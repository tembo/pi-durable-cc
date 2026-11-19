import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from '@earendil-works/pi-ai';
import { createHash } from 'node:crypto';
import { readRequest } from './context.js';
import { failedMessage } from './convert.js';
import { ClaudeCodeSession, type SessionSettings } from './session.js';

const VERSION = '0.1.0';

export interface ClaudeCodeApiOptions {
	/** Path to the `claude` binary. Defaults to the one bundled with the Claude Agent SDK. */
	executable?: string;
	/** Environment for every Claude Code process, over the request's `env`. An empty value removes a variable. */
	env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Let Claude Code processes inherit this process's whole environment. Off by default: a process only gets what it
	 * needs to run plus its own credential, so a worker serving several users never mixes their secrets.
	 */
	inheritEnv?: boolean;
	/** Where each session's private config and working directories go. Defaults to the OS temp directory. */
	tmpDir?: string;
	/** Close a session's process after this long without a request. Default: 10 minutes. */
	idleTimeoutMs?: number;
	/** How long Claude Code waits for Pi to run a tool before giving up. Default: 6 hours. */
	toolTimeoutMs?: number;
	/** Identifies the calling app in Claude Code's User-Agent. */
	clientApp?: string;
	/** Receives lifecycle notes, for logging. Never message content. */
	debug?: SessionSettings['debug'];
	/** Extra Claude Agent SDK query options, applied last. */
	queryOptions?: Partial<Options>;
}

/** A Pi chat API served by Claude Code, plus the sessions it keeps open. */
export interface ClaudeCodeApi extends ProviderStreams {
	/** Close every open Claude Code process. Call it when the harness that used this API closes. */
	close(): Promise<void>;
	/** Number of Claude Code processes open right now. */
	readonly openSessions: number;
}

type Options_ = SimpleStreamOptions & StreamOptions;

function credentialDigest(credential: string | undefined) {
	return credential ? createHash('sha256').update(credential).digest('hex') : null;
}

/**
 * Claude models through the official Claude Code binary, as a pi-ai `api` implementation for `createProvider`.
 *
 * Each conversation (Pi's provider `sessionId`) gets one Claude Code process that runs its tool loop, so the tool
 * calls of one turn stream through a single process. A request that does not continue what a process holds (a new
 * worker, a restart, compaction, a changed prompt) rebuilds the conversation from Pi's history instead, so Pi stays the
 * only source of truth and any process can pick up any conversation.
 */
export function claudeCodeApi(options: ClaudeCodeApiOptions = {}): ClaudeCodeApi {
	const sessions = new Map<string, ClaudeCodeSession>();
	const settings: SessionSettings = {
		executable: options.executable,
		env: options.env,
		inheritEnv: options.inheritEnv ?? false,
		tmpDir: options.tmpDir,
		toolTimeoutMs: options.toolTimeoutMs ?? 6 * 60 * 60 * 1000,
		clientApp: options.clientApp ?? `pi-durable-cc/${VERSION}`,
		debug: options.debug,
		queryOptions: options.queryOptions,
	};
	const idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60 * 1000;
	const sweeper = setInterval(() => {
		const now = Date.now();
		for (const [key, session] of sessions) {
			const idle = session.state === 'idle' || session.state === 'awaitingTools';
			if (session.state === 'closed' || (idle && now - session.lastActiveAt > idleTimeoutMs)) {
				sessions.delete(key);
				session.close().catch(() => undefined);
			}
		}
	}, Math.min(60_000, idleTimeoutMs));
	sweeper.unref?.();

	async function run(
		model: Model<string>,
		context: TranscriptContext,
		streamOptions: Options_,
		stream: AssistantMessageEventStream
	) {
		const credential = streamOptions.apiKey;
		const reasoning = streamOptions.reasoning;
		const request = readRequest(context, {
			model: model.id,
			reasoning: reasoning ?? 'off',
			credential: credentialDigest(credential),
		});
		if (request.conversation.length === 0) {
			throw new Error('The request has no messages.');
		}
		const key = streamOptions.sessionId;
		// Summaries and other replays must not become part of the conversation's Claude Code session.
		const oneOff =
			key === undefined ||
			streamOptions.cacheRetention === 'none' ||
			streamOptions.disableContinuation === true;
		if (!oneOff) {
			const existing = sessions.get(key);
			const plan = existing?.plan(request);
			if (existing && plan) {
				existing.respond(plan, stream, streamOptions.signal);
				return;
			}
			if (existing) {
				sessions.delete(key);
				options.debug?.('claude-code: rebuilding session', { state: existing.state });
				await existing.close();
			}
		}
		const env = { ...(options.env ?? {}), ...(streamOptions.env ?? {}) };
		const { session, plan } = await ClaudeCodeSession.open({
			model,
			request,
			reasoning,
			credential,
			env,
			settings,
		});
		if (!oneOff && key !== undefined) sessions.set(key, session);
		session.respond(plan, stream, streamOptions.signal, oneOff);
	}

	function streamSimple(
		model: Model<string>,
		context: TranscriptContext,
		streamOptions?: Options_
	) {
		const stream = createAssistantMessageEventStream();
		run(model, context, streamOptions ?? {}, stream).catch((error: unknown) => {
			const aborted = streamOptions?.signal?.aborted === true;
			const message = failedMessage(
				model,
				aborted ? 'aborted' : 'error',
				error instanceof Error ? error.message : String(error)
			);
			stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
			stream.end(message);
		});
		return stream;
	}

	return {
		stream: streamSimple,
		streamSimple,
		get openSessions() {
			return [...sessions.values()].filter((session) => session.state !== 'closed').length;
		},
		async close() {
			clearInterval(sweeper);
			const open = [...sessions.values()];
			sessions.clear();
			await Promise.all(open.map((session) => session.close()));
		},
	};
}
