import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	type Submission,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { obj, str } from '@earendil-works/pi-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type ClaudeCodeApi, claudeCodeApi, claudeCodeModels } from '../../src/index.js';

// Needs a real credential: an Anthropic API key or a Claude subscription token (`claude setup-token`).
const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PI_DURABLE_CC_TEST_MODEL ?? 'claude-haiku-5-5';
const context = BACKGROUND_CONTEXT;
const OPENED = 'claude-code: opened session';
const REBUILT = 'claude-code: rebuilding session';

const SECRETS: Record<string, string> = { alpha: '4217', beta: '9031' };

type Storage = Parameters<typeof Harness.open>[0];

interface Setup {
	api: ClaudeCodeApi;
	harness: Harness;
	notes: string[];
	toolCalls: string[];
}

const open: Setup[] = [];
const directories: string[] = [];

/**
 * A harness on Claude Code with one tool. `gate`, when given, holds every tool call until it resolves; a held call
 * fails when the harness closes, as a call cut off by a crash does.
 */
async function setup(
	options: { storage?: Storage; gate?: () => Promise<void> } = {}
): Promise<Setup> {
	const notes: string[] = [];
	const toolCalls: string[] = [];
	const api = claudeCodeApi({ debug: (message) => notes.push(message) });
	const models = createModels();
	models.setProvider(
		createProvider({
			id: 'claude-code',
			name: 'Claude Code',
			auth: {
				apiKey: {
					name: 'Test credential',
					resolve: async () =>
						credential ? { auth: { apiKey: credential }, source: 'test' } : undefined,
				},
			},
			models: claudeCodeModels(),
			api,
		})
	);
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: 'secrets',
			tools: [
				defineTool({
					name: 'lookup_secret',
					description: 'Look up the secret number stored under a name.',
					parameters: obj({ name: str() }),
					execute: async (args, _api, toolContext) => {
						toolCalls.push(args.name);
						if (options.gate) {
							const gate = options.gate();
							await new Promise<void>((resolve, reject) => {
								gate.then(resolve, reject);
								toolContext.abortSignal?.addEventListener('abort', () =>
									reject(new Error('The harness closed.'))
								);
							});
						}
						const secret = SECRETS[args.name];
						if (!secret) throw new Error(`No secret named ${args.name}`);
						return { output: [{ type: 'text', text: secret }] };
					},
				}),
			],
		})
	);
	const harness = await Harness.open(options.storage ?? new MemoryStorage(), { models, registry }, context);
	const result = { api, harness, notes, toolCalls };
	open.push(result);
	return result;
}

async function fileStorage() {
	const directory = await mkdtemp(join(tmpdir(), 'pdcc-test-'));
	directories.push(directory);
	return { directory, open: () => openNodeJsonlStorage(directory, context) };
}

async function root(harness: Harness, thinkingLevel?: 'low') {
	return harness.root(context, {
		agent: {
			model: { provider: 'claude-code', modelId: MODEL },
			...(thinkingLevel ? { thinkingLevel } : {}),
		},
	});
}

type Conversation = Awaited<ReturnType<typeof root>>;

async function answerOf(conversation: Conversation, submission: Submission) {
	const settled = await submission.wait(context);
	if (settled.status !== 'done' || settled.type !== 'input') {
		throw new Error(`The input was not answered: ${JSON.stringify(settled)}`);
	}
	const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message;
}

function textOf(message: AssistantMessage | undefined) {
	return (message?.content ?? [])
		.flatMap((block) => (block.type === 'text' ? [block.text] : []))
		.join('');
}

async function ask(harness: Harness, content: string, thinkingLevel?: 'low') {
	const conversation = await root(harness, thinkingLevel);
	const submission = await conversation.submit({ type: 'input', content }, context);
	return textOf(await answerOf(conversation, submission));
}

async function until(condition: () => boolean, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting.');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function shutDown(setup: Setup) {
	await setup.harness.close(context);
	await setup.api.close();
}

afterEach(async () => {
	for (const setup of open.splice(0)) {
		await setup.harness.close(context).catch(() => undefined);
		await setup.api.close();
	}
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe.skipIf(!credential)('pi-durable on Claude Code', () => {
	it('answers through Claude Code', async () => {
		const { harness, api } = await setup();
		const answer = await ask(harness, 'Reply with exactly the word PONG and nothing else.');
		expect(answer).toContain('PONG');
		expect(api.openSessions).toBe(1);
	}, 120_000);

	it('runs a tool loop through one process and reuses it for the next input', async () => {
		const { harness, notes, toolCalls } = await setup();
		const first = await ask(
			harness,
			'Use the lookup_secret tool to look up the secrets named alpha and beta, then reply with both numbers.'
		);
		expect(first).toContain('4217');
		expect(first).toContain('9031');
		expect(toolCalls.sort()).toEqual(['alpha', 'beta']);

		const second = await ask(
			harness,
			'Without calling any tool: what is the alpha secret plus one? Reply with just the number.'
		);
		expect(second).toContain('4218');
		// Both inputs, and every request of the tool loop, went through the same Claude Code process.
		expect(notes.filter((note) => note === OPENED)).toHaveLength(1);
		expect(notes).not.toContain(REBUILT);
	}, 240_000);

	it('rebuilds a conversation from Pi history alone after a restart', async () => {
		// A worker restart: the transcript survives on disk, the Claude Code process does not.
		const storage = await fileStorage();
		const first = await setup({ storage: await storage.open() });
		await ask(first.harness, 'Use the lookup_secret tool to look up the secret named beta. Reply with the number.');
		expect(first.toolCalls).toEqual(['beta']);
		await shutDown(first);
		expect(first.api.openSessions).toBe(0);

		const second = await setup({ storage: await storage.open() });
		const answer = await ask(
			second.harness,
			'Without calling any tool: what was the beta secret? Reply with just the number.'
		);
		expect(answer).toContain('9031');
		expect(second.toolCalls).toEqual([]);
		expect(second.notes).toContain(OPENED);
	}, 240_000);

	it('finishes a turn that a restart cut off in the middle of a tool call', async () => {
		const storage = await fileStorage();
		const prompt = 'Use the lookup_secret tool to look up the secret named alpha. Reply with the number.';
		// The tool never finishes in the first process: the harness closes while it runs.
		const first = await setup({ storage: await storage.open(), gate: () => new Promise(() => undefined) });
		const firstRoot = await root(first.harness);
		await firstRoot.submit({ type: 'input', content: prompt, requestId: 'cut-off' }, context);
		await until(() => first.toolCalls.length === 1);
		await shutDown(first);

		// The same request id finds the same submission; the run continues from the interrupted tool result.
		const second = await setup({ storage: await storage.open() });
		const secondRoot = await root(second.harness);
		const submission = await secondRoot.submit(
			{ type: 'input', content: prompt, requestId: 'cut-off' },
			context
		);
		const answer = textOf(await answerOf(secondRoot, submission));
		expect(answer).toContain('4217');
		expect(second.notes).toContain(OPENED);
	}, 240_000);

	it('delivers a steer sent while a tool runs, in the same process', async () => {
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, notes, toolCalls } = await setup({ gate: () => released });
		const conversation = await root(harness);
		const submission = await conversation.submit(
			{
				type: 'input',
				content: 'Use the lookup_secret tool to look up the secret named alpha, then reply with the number.',
			},
			context
		);
		await until(() => toolCalls.length === 1);
		await conversation.submit(
			{
				type: 'input',
				content: 'Also look up the secret named beta with the tool, and reply with both numbers.',
				whenBusy: 'steer',
			},
			context
		);
		release();
		const answer = textOf(await answerOf(conversation, submission));
		expect(answer).toContain('4217');
		expect(answer).toContain('9031');
		expect(toolCalls).toContain('beta');
		expect(notes.filter((note) => note === OPENED)).toHaveLength(1);
		expect(notes).not.toContain(REBUILT);
	}, 240_000);

	it('keeps thinking replayable through reuse and a rebuild', async () => {
		const storage = await fileStorage();
		const first = await setup({ storage: await storage.open() });
		const conversation = await root(first.harness, 'low');
		const submission = await conversation.submit(
			{
				type: 'input',
				content: 'Think it through, then use the lookup_secret tool for alpha and reply with the number times 3.',
			},
			context
		);
		const message = await answerOf(conversation, submission);
		expect(textOf(message)).toContain('12651');
		// Counted, never printed: thinking text stays out of test output.
		const page = await conversation.entries({ order: 'ascending' }, 100, undefined, context);
		const signed = page.items
			.flatMap((entry) => entry.model ?? [])
			.flatMap((model) => (model.role === 'assistant' ? model.content : []))
			.filter((block) => block.type === 'thinking' && block.thinkingSignature);
		expect(signed.length).toBeGreaterThan(0);
		// A second input reuses the process, so every earlier message, thinking signatures included, matched exactly.
		expect(await ask(first.harness, 'What is that result minus 1? Reply with just the number.', 'low')).toContain(
			'12650'
		);
		expect(first.notes).not.toContain(REBUILT);
		await shutDown(first);

		// The rebuilt session replays the thinking blocks; Anthropic rejects any whose signature does not verify.
		const second = await setup({ storage: await storage.open() });
		expect(await ask(second.harness, 'What was the alpha secret? Reply with just the number.', 'low')).toContain(
			'4217'
		);
	}, 300_000);

	it('aborts a running request and closes its process', async () => {
		const { harness, api } = await setup();
		const conversation = await root(harness);
		const submission = await conversation.submit(
			{ type: 'input', content: 'Write a 2000 word essay about the history of the elephant.' },
			context
		);
		await new Promise((resolve) => setTimeout(resolve, 4000));
		await conversation.abort(context);
		const settled = await submission.wait(context);
		expect(settled.status).not.toBe('done');
		await until(() => api.openSessions === 0, 5000);
	}, 120_000);
});
