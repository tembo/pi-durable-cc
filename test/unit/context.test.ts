import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { describe, expect, it } from 'vitest';
import { digestMessage, readRequest } from '../../src/context.js';

function assistant(content: AssistantMessage['content'], api = 'claude-code'): AssistantMessage {
	return {
		role: 'assistant',
		content,
		api,
		provider: 'claude-code',
		model: 'claude-haiku-5-5',
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'toolUse',
		timestamp: 1,
	};
}

function toolResult(text: string, isError = false): ToolResultMessage {
	return {
		role: 'toolResult',
		toolCallId: 'toolu_1',
		toolName: 'lookup',
		content: [{ type: 'text', text }],
		isError,
		timestamp: 2,
	} as ToolResultMessage;
}

describe('digestMessage', () => {
	it('ignores bookkeeping such as timestamps, usage and durations', () => {
		const call = { type: 'toolCall' as const, id: 'toolu_1', name: 'lookup', arguments: { b: 1, a: 2 } };
		const stored = { ...assistant([call]), timestamp: 99, durationMs: 5, usage: { ...assistant([]).usage, output: 7 } };
		const reordered = assistant([{ ...call, arguments: { a: 2, b: 1 } }]);
		expect(digestMessage(stored)).toBe(digestMessage(reordered));
	});

	it('tells apart what the model would see differently', () => {
		const thinking = (signature: string) =>
			assistant([{ type: 'thinking', thinking: 'plan', thinkingSignature: signature }]);
		expect(digestMessage(thinking('a'))).not.toBe(digestMessage(thinking('b')));
		expect(digestMessage(toolResult('4217'))).not.toBe(digestMessage(toolResult('4217', true)));
		expect(digestMessage(toolResult('4217'))).not.toBe(digestMessage(toolResult('4218')));
	});
});

describe('readRequest', () => {
	it('replays system messages into one prompt and tool set, and fingerprints them', () => {
		const tool = { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } };
		const base = normalizeContext({
			systemPrompt: 'You are a bot.',
			tools: [tool],
			messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
		});
		const request = readRequest(base, { model: 'm' });
		expect(request.systemPrompt).toContain('You are a bot.');
		expect(request.tools.map((item) => item.name)).toEqual(['lookup']);
		expect(request.conversation).toHaveLength(1);

		const later: Message = {
			role: 'system',
			content: 'Also be brief.',
			toolsRemoved: [{ name: 'lookup' }],
			timestamp: 2,
		};
		const changed = readRequest(
			{ ...base, messages: [...base.messages, later] } as typeof base,
			{ model: 'm' }
		);
		expect(changed.systemPrompt).toContain('Also be brief.');
		expect(changed.tools).toEqual([]);
		expect(changed.setupDigest).not.toBe(request.setupDigest);
		expect(readRequest(base, { model: 'other' }).setupDigest).not.toBe(request.setupDigest);
	});
});
