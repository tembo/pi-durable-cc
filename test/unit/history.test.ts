import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { claudeToolId, toSessionMessages } from '../../src/history.js';

function assistant(content: AssistantMessage['content'], api = 'claude-code'): AssistantMessage {
	return {
		role: 'assistant',
		content,
		api,
		provider: 'p',
		model: 'm',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'toolUse',
		timestamp: 0,
	};
}

function result(toolCallId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: 'toolResult',
		toolCallId,
		toolName: 'lookup',
		content: text ? [{ type: 'text', text }] : [],
		isError,
		timestamp: 0,
	} as ToolResultMessage;
}

describe('toSessionMessages', () => {
	it('puts parallel tool results, and a steer between them, right after their tool calls', () => {
		const messages = toSessionMessages([
			{ role: 'user', content: 'look up both', timestamp: 0 },
			assistant([
				{ type: 'toolCall', id: 'toolu_a', name: 'lookup', arguments: { name: 'a' } },
				{ type: 'toolCall', id: 'toolu_b', name: 'lookup', arguments: { name: 'b' } },
			]),
			result('toolu_a', '1'),
			{ role: 'user', content: 'also c', timestamp: 0 },
			result('toolu_b', ''),
		]);
		expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'user']);
		expect(messages[1]?.content).toEqual([
			{ type: 'tool_use', id: 'toolu_a', name: 'mcp__pi__lookup', input: { name: 'a' } },
			{ type: 'tool_use', id: 'toolu_b', name: 'mcp__pi__lookup', input: { name: 'b' } },
		]);
		expect(messages[2]?.content).toEqual([
			{ type: 'tool_result', tool_use_id: 'toolu_a', content: '1' },
			// The API rejects empty results, so an empty one gets a note instead.
			{ type: 'tool_result', tool_use_id: 'toolu_b', content: '(lookup completed with no output)' },
		]);
		expect(messages[3]?.content).toEqual([{ type: 'text', text: 'also c' }]);
	});

	it('replays only thinking Claude Code signed, and makes foreign tool ids valid', () => {
		const messages = toSessionMessages([
			{ role: 'user', content: 'go', timestamp: 0 },
			assistant(
				[
					{ type: 'thinking', thinking: 'mine', thinkingSignature: 'sig' },
					{ type: 'text', text: 'ok' },
				],
				'claude-code'
			),
			assistant(
				[
					{ type: 'thinking', thinking: 'foreign', thinkingSignature: 'other' },
					{ type: 'toolCall', id: 'call:1|x', name: 'lookup', arguments: {} },
				],
				'anthropic-messages'
			),
			result('call:1|x', 'done'),
		]);
		expect(messages[1]?.content).toEqual([
			{ type: 'thinking', thinking: 'mine', signature: 'sig' },
			{ type: 'text', text: 'ok' },
		]);
		expect(messages[2]?.content).toEqual([
			{ type: 'tool_use', id: 'call_1_x', name: 'mcp__pi__lookup', input: {} },
		]);
		expect(messages[3]?.content).toEqual([
			{ type: 'tool_result', tool_use_id: claudeToolId('call:1|x'), content: 'done' },
		]);
	});

	it('leaves out an aborted turn that streamed nothing', () => {
		const messages = toSessionMessages([
			{ role: 'user', content: 'one', timestamp: 0 },
			assistant([]),
			{ role: 'user', content: 'two', timestamp: 0 },
		]);
		expect(messages.map((message) => message.role)).toEqual(['user', 'user']);
	});
});
