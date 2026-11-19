import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Options,
	query,
	type Query,
	type SDKMessage,
	type SDKUserMessage,
	type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	ToolResultMessage,
	UserMessage,
} from '@earendil-works/pi-ai';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
	type ConversationMessage,
	digestMessage,
	type Request,
} from './context.js';
import { AssistantBuilder, failedMessage, type StreamEvent } from './convert.js';
import { claudeCodeEnv } from './env.js';
import { importHistory, toolResultContent, userBlocks } from './history.js';
import { Inbox } from './inbox.js';
import {
	createToolServer,
	TOOL_NAME_PREFIX,
	TOOL_SERVER_NAME,
} from './mcp-server.js';
import { thinkingOptions } from './thinking.js';

/** Opens a resumed turn whose history ends at a tool result: Claude Code needs a prompt to start a request. */
const CONTINUE_PROMPT =
	'[Your session was interrupted and resumed. The conversation above ends where you left off. Continue from there.]';

export interface SessionSettings {
	executable?: string;
	env?: Readonly<Record<string, string | undefined>>;
	inheritEnv: boolean;
	tmpDir?: string;
	toolTimeoutMs: number;
	clientApp: string;
	debug?: (message: string, details?: Record<string, unknown>) => void;
	/** Extra query options, applied last. For experiments; the defaults keep Claude Code to Pi's tools only. */
	queryOptions?: Partial<Options>;
}

/** What a request adds to the conversation a session's Claude Code already holds. */
export interface Plan {
	/** Results for the tool calls Claude Code is waiting on. */
	results: ToolResultMessage[];
	/** New user messages; sent together as one prompt. */
	prompts: UserMessage[];
	/** Fingerprints of `results` and `prompts`, in conversation order. */
	digests: string[];
	/** Whether the turn starts from a history that ends without a user prompt. */
	resumeWithoutPrompt?: boolean;
}

type State = 'idle' | 'responding' | 'awaitingTools' | 'closed';

interface Turn {
	stream: AssistantMessageEventStream;
	builder?: AssistantBuilder;
	/** Close the session once this response ends; used for one-off requests. */
	closeAfter: boolean;
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function toMcpResult(message: ToolResultMessage): CallToolResult {
	const content = toolResultContent(message);
	return {
		isError: message.isError,
		content:
			typeof content === 'string'
				? [{ type: 'text', text: content }]
				: content.map((block) =>
						block.type === 'text'
							? { type: 'text' as const, text: block.text }
							: {
									type: 'image' as const,
									data: block.source.type === 'base64' ? block.source.data : '',
									mimeType:
										block.source.type === 'base64' ? block.source.media_type : 'image/png',
								}
					),
	};
}

function promptMessage(messages: readonly UserMessage[]): SDKUserMessage {
	const blocks = messages.flatMap((message) => userBlocks(message.content));
	return {
		type: 'user',
		parent_tool_use_id: null,
		message: {
			role: 'user',
			content: blocks.length > 0 ? blocks : '[empty]',
		},
	} as SDKUserMessage;
}

/**
 * One Claude Code process serving one Pi conversation. A Pi turn is many model requests with tool calls between them;
 * Claude Code runs that loop itself, so the session keeps its process open across requests: a request that asks for
 * tools ends its Pi stream, the tool calls wait in the MCP server, and the next Pi request delivers their results.
 */
export class ClaudeCodeSession {
	readonly setupDigest: string;
	/** Fingerprints of the Pi messages Claude Code holds, in order. */
	readonly synced: string[] = [];
	lastActiveAt = Date.now();
	#state: State = 'idle';
	#expectedToolIds: string[] = [];
	#waiting = new Map<string, (result: CallToolResult) => void>();
	#delivered = new Map<string, CallToolResult>();
	#input = new Inbox<SDKUserMessage>();
	#abort = new AbortController();
	#query: Query | undefined;
	#turn: Turn | undefined;
	#stderr: string[] = [];
	#lastError: string | undefined;
	/** Claude Code turns whose final response Pi already has, but whose `result` has not arrived yet. */
	#resultsOwed = 0;
	#closed: Promise<void> | undefined;
	#pump: Promise<void> | undefined;
	#process: ChildProcess | undefined;

	private constructor(
		private readonly model: Model<string>,
		private readonly settings: SessionSettings,
		private readonly root: string,
		setupDigest: string
	) {
		this.setupDigest = setupDigest;
	}

	get state() {
		return this.#state;
	}

	/**
	 * Start a Claude Code process for a conversation. The history before the trailing user messages is written as a
	 * Claude Code session the process resumes; the trailing messages become the plan's prompt.
	 */
	static async open(params: {
		model: Model<string>;
		request: Request;
		reasoning: string | undefined;
		credential: string | undefined;
		env: Readonly<Record<string, string | undefined>> | undefined;
		settings: SessionSettings;
	}): Promise<{ session: ClaudeCodeSession; plan: Plan }> {
		const { model, request, settings } = params;
		const conversation = request.conversation;
		let split = conversation.length;
		while (split > 0 && conversation[split - 1]?.role === 'user') split -= 1;
		const history = conversation.slice(0, split);
		const prompts = conversation.slice(split) as UserMessage[];

		const root = await mkdtemp(join(settings.tmpDir ?? tmpdir(), 'pdcc-'));
		const configDir = join(root, 'config');
		const home = join(root, 'home');
		const cwd = join(root, 'work');
		await Promise.all([
			mkdir(configDir, { recursive: true }),
			mkdir(home, { recursive: true }),
			mkdir(cwd, { recursive: true }),
		]);
		const session = new ClaudeCodeSession(model, settings, root, request.setupDigest);
		try {
			const resume =
				history.length > 0
					? importHistory({ messages: history, configDir, cwd, modelId: model.id })
					: undefined;
			session.synced.push(...history.map(digestMessage));
			session.#start({
				request,
				resume,
				cwd,
				env: claudeCodeEnv({
					credential: params.credential,
					configDir,
					home,
					env: params.env,
					inheritEnv: settings.inheritEnv,
					clientApp: settings.clientApp,
				}),
				reasoning: params.reasoning,
			});
		} catch (error) {
			await session.close();
			throw error;
		}
		settings.debug?.('claude-code: opened session', {
			historyMessages: history.length,
			promptMessages: prompts.length,
		});
		return {
			session,
			plan: {
				results: [],
				prompts,
				digests: prompts.map(digestMessage),
				resumeWithoutPrompt: prompts.length === 0,
			},
		};
	}

	#start(params: {
		request: Request;
		resume: string | undefined;
		cwd: string;
		env: Record<string, string>;
		reasoning: string | undefined;
	}) {
		const { request } = params;
		const hasTools = request.tools.length > 0;
		const options: Options = {
			model: this.model.id,
			cwd: params.cwd,
			env: params.env,
			abortController: this.#abort,
			// Pi's prompt replaces Claude Code's own; its tools are the only ones Claude can call.
			...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
			tools: [],
			mcpServers: hasTools
				? {
						[TOOL_SERVER_NAME]: createToolServer(
							request.tools,
							(call) => this.#toolCall(call.toolUseId),
							this.settings.toolTimeoutMs
						),
					}
				: {},
			allowedTools: hasTools ? [`mcp__${TOOL_SERVER_NAME}`] : [],
			permissionMode: 'dontAsk',
			settingSources: [],
			strictMcpConfig: true,
			includePartialMessages: true,
			...(params.resume ? { resume: params.resume } : {}),
			...thinkingOptions(this.model, params.reasoning),
			...(this.settings.executable
				? { pathToClaudeCodeExecutable: this.settings.executable }
				: {}),
			// Spawned here so closing can wait for the process to exit before its directory is removed.
			spawnClaudeCodeProcess: (spawnOptions) => {
				const child = spawn(spawnOptions.command, spawnOptions.args, {
					cwd: spawnOptions.cwd,
					env: spawnOptions.env,
					signal: spawnOptions.signal,
					stdio: ['pipe', 'pipe', 'pipe'],
				});
				child.stderr?.on('data', (chunk: Buffer) => {
					this.#stderr.push(chunk.toString());
					if (this.#stderr.length > 50) this.#stderr.shift();
				});
				child.on('error', () => undefined);
				this.#process = child;
				return child as unknown as SpawnedProcess;
			},
			...this.settings.queryOptions,
		};
		this.#query = query({ prompt: this.#input, options });
		this.#pump = this.#run(this.#query);
	}

	async #run(source: Query) {
		try {
			for await (const message of source) this.#handle(message);
			this.#fail('Claude Code exited.');
		} catch (error) {
			this.#fail(errorText(error));
		}
	}

	#handle(message: SDKMessage) {
		this.lastActiveAt = Date.now();
		switch (message.type) {
			case 'stream_event':
				// Events of a subagent's own requests carry its tool call; Pi's tools never start one.
				if (message.parent_tool_use_id === null) this.#streamEvent(message.event);
				return;
			case 'assistant':
				if (message.error) this.#lastError = message.error;
				return;
			case 'result': {
				const failed = message.subtype !== 'success' || message.is_error;
				if (this.#resultsOwed > 0) {
					// Closes a turn Pi already has the answer of; the next request may already be running.
					this.#resultsOwed -= 1;
					if (failed) this.close().catch(() => undefined);
					return;
				}
				if (this.#turn) {
					// The turn ended without a complete response, such as a request that failed before streaming.
					const detail =
						message.subtype === 'success'
							? message.result
							: message.errors.join('\n');
					this.#fail(detail || this.#lastError || 'Claude Code ended the turn without a response.');
					return;
				}
				if (failed) this.close().catch(() => undefined);
				return;
			}
			default:
				return;
		}
	}

	#streamEvent(event: StreamEvent) {
		const turn = this.#turn;
		if (!turn) {
			// A response no Pi request waits for leaves Claude Code's conversation ahead of Pi's: start over next time.
			this.settings.debug?.('claude-code: response without a waiting request', {
				event: event.type,
			});
			this.close().catch(() => undefined);
			return;
		}
		if (event.type === 'message_start') {
			turn.builder = new AssistantBuilder(this.model, (name) =>
				name.startsWith(TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : name
			);
		}
		const builder = turn.builder;
		if (!builder) return;
		for (const piEvent of builder.accept(event)) turn.stream.push(piEvent);
		if (event.type !== 'message_stop') return;
		const final = builder.finish();
		const message: AssistantMessage =
			final.type === 'done' ? final.message : (final as { error: AssistantMessage }).error;
		this.synced.push(digestMessage(message));
		this.#turn = undefined;
		if (final.type === 'done' && final.reason === 'toolUse') {
			this.#state = 'awaitingTools';
			this.#expectedToolIds = message.content.flatMap((block) =>
				block.type === 'toolCall' ? [block.id] : []
			);
		} else {
			this.#state = 'idle';
			this.#resultsOwed += 1;
		}
		turn.stream.push(final);
		turn.stream.end(message);
		if (turn.closeAfter || final.type === 'error') this.close().catch(() => undefined);
	}

	#toolCall(toolUseId: string): Promise<CallToolResult> {
		const delivered = this.#delivered.get(toolUseId);
		if (delivered) {
			this.#delivered.delete(toolUseId);
			return Promise.resolve(delivered);
		}
		return new Promise((resolve) => {
			this.#waiting.set(toolUseId, resolve);
		});
	}

	/** The plan for a request, when it only adds to what this process holds; otherwise undefined. */
	plan(request: Request): Plan | undefined {
		if (this.#state === 'closed' || this.#state === 'responding') return undefined;
		if (request.setupDigest !== this.setupDigest) return undefined;
		const conversation = request.conversation;
		if (conversation.length <= this.synced.length) return undefined;
		for (let index = 0; index < this.synced.length; index += 1) {
			const message = conversation[index];
			if (!message || digestMessage(message) !== this.synced[index]) return undefined;
		}
		const tail = conversation.slice(this.synced.length);
		let results: ToolResultMessage[] = [];
		let rest: ConversationMessage[] = tail;
		if (this.#state === 'awaitingTools') {
			const count = tail.findIndex((message) => message.role !== 'toolResult');
			results = tail.slice(0, count === -1 ? tail.length : count) as ToolResultMessage[];
			rest = tail.slice(results.length);
			const answered = new Set(results.map((result) => result.toolCallId));
			if (
				answered.size !== this.#expectedToolIds.length ||
				this.#expectedToolIds.some((id) => !answered.has(id))
			) {
				return undefined;
			}
		} else if (rest.length === 0) {
			return undefined;
		}
		if (rest.some((message) => message.role !== 'user')) return undefined;
		return {
			results,
			prompts: rest as UserMessage[],
			digests: tail.map(digestMessage),
		};
	}

	/** Answer a Pi request with the next response of this process. */
	respond(
		plan: Plan,
		stream: AssistantMessageEventStream,
		signal: AbortSignal | undefined,
		closeAfter = false
	) {
		if (signal?.aborted) {
			this.#endTurn(stream, 'aborted', 'The request was aborted.');
			this.close().catch(() => undefined);
			return;
		}
		this.#turn = { stream, closeAfter };
		this.#state = 'responding';
		this.lastActiveAt = Date.now();
		this.synced.push(...plan.digests);
		signal?.addEventListener('abort', () => this.#abortTurn(stream), { once: true });
		for (const result of plan.results) {
			const answer = toMcpResult(result);
			const waiting = this.#waiting.get(result.toolCallId);
			if (waiting) {
				this.#waiting.delete(result.toolCallId);
				waiting(answer);
			} else {
				this.#delivered.set(result.toolCallId, answer);
			}
		}
		this.#expectedToolIds = [];
		if (plan.prompts.length > 0) {
			this.#input.push(promptMessage(plan.prompts));
		} else if (plan.resumeWithoutPrompt) {
			this.#input.push(
				promptMessage([{ role: 'user', content: CONTINUE_PROMPT, timestamp: Date.now() }])
			);
		}
	}

	#abortTurn(stream: AssistantMessageEventStream) {
		if (this.#turn?.stream !== stream) return;
		this.#query?.interrupt().catch(() => undefined);
		this.#endTurn(stream, 'aborted', 'The request was aborted.');
		this.close().catch(() => undefined);
	}

	#endTurn(
		stream: AssistantMessageEventStream,
		reason: 'error' | 'aborted',
		message: string
	) {
		if (this.#turn?.stream === stream) this.#turn = undefined;
		const error = failedMessage(this.model, reason, message);
		stream.push({ type: 'error', reason, error });
		stream.end(error);
	}

	#fail(reason: string) {
		const turn = this.#turn;
		if (turn) {
			const stderr = this.#stderr.join('').trim().split('\n').slice(-5).join('\n');
			this.#endTurn(
				turn.stream,
				this.#abort.signal.aborted ? 'aborted' : 'error',
				stderr ? `${reason}\n${stderr}` : reason
			);
		}
		this.close().catch(() => undefined);
	}

	/** Wait for the process to exit, killing it if it lingers. */
	async #exit() {
		const child = this.#process;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
		const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
		child.kill('SIGTERM');
		await exited;
		clearTimeout(timer);
	}

	/** Stop the process and remove its files. Tool calls still waiting get an error result. */
	close(): Promise<void> {
		this.#closed ??= (async () => {
			this.#state = 'closed';
			for (const resolve of this.#waiting.values()) {
				resolve({
					isError: true,
					content: [{ type: 'text', text: 'The session closed before the tool ran.' }],
				});
			}
			this.#waiting.clear();
			const turn = this.#turn;
			if (turn) this.#endTurn(turn.stream, 'error', 'The Claude Code session closed.');
			this.#input.close();
			this.#abort.abort();
			try {
				this.#query?.close();
			} catch {
				// Already exited.
			}
			await this.#pump?.catch(() => undefined);
			await this.#exit();
			await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
			this.settings.debug?.('claude-code: closed session');
		})();
		return this.#closed;
	}
}
