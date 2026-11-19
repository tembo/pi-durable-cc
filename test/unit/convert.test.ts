import type { AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { AssistantBuilder, type StreamEvent } from '../../src/convert.js';
import { claudeCodeModels } from '../../src/models.js';

const model = claudeCodeModels().find((item) => item.id === 'claude-haiku-5-5') as Model<string>;

function run(events: unknown[]) {
	const builder = new AssistantBuilder(model, (name) => name.replace(/^mcp__pi__/, ''));
	const emitted: AssistantMessageEvent[] = [];
	for (const event of events) emitted.push(...builder.accept(event as StreamEvent));
	return { builder, emitted, final: builder.finish() };
}

const start = {
	type: 'message_start',
	message: {
		id: 'msg_1',
		model: 'claude-haiku-5-5',
		usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
	},
};

describe('AssistantBuilder', () => {
	it('builds text and a tool call, maps the tool name back and prices the usage', () => {
		const { builder, emitted, final } = run([
			start,
			{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking ' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it up.' } },
			{ type: 'content_block_stop', index: 0 },
			{
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__pi__lookup', input: {} },
			},
			{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"name":' } },
			{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"alpha"}' } },
			{ type: 'content_block_stop', index: 1 },
			{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
			{ type: 'message_stop' },
		]);
		expect(emitted.map((event) => event.type)).toEqual([
			'start',
			'text_start',
			'text_delta',
			'text_delta',
			'text_end',
			'toolcall_start',
			'toolcall_delta',
			'toolcall_delta',
			'toolcall_end',
		]);
		expect(builder.wantsTools).toBe(true);
		expect(final.type).toBe('done');
		if (final.type !== 'done') return;
		expect(final.reason).toBe('toolUse');
		expect(final.message.content).toEqual([
			{ type: 'text', text: 'Looking it up.' },
			{ type: 'toolCall', id: 'toolu_1', name: 'lookup', arguments: { name: 'alpha' } },
		]);
		expect(final.message.usage).toMatchObject({ input: 1000, output: 40, cacheRead: 500, totalTokens: 1540 });
		expect(final.message.usage.cost.total).toBeGreaterThan(0);
	});

	it('keeps thinking signatures and reports malformed tool arguments', () => {
		const { final } = run([
			start,
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
			{ type: 'content_block_stop', index: 0 },
			{
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'tool_use', id: 'toolu_2', name: 'mcp__pi__lookup', input: {} },
			},
			{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"name":' } },
			{ type: 'content_block_stop', index: 1 },
			{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
			{ type: 'message_stop' },
		]);
		if (final.type !== 'done') throw new Error('expected done');
		expect(final.message.content[0]).toEqual({ type: 'thinking', thinking: 'hmm', thinkingSignature: 'abc' });
		const call = final.message.content[1];
		expect(call).toMatchObject({ type: 'toolCall', arguments: {} });
		expect(call?.type === 'toolCall' && call.argumentsError).toContain('not valid JSON');
	});

	it('maps stop reasons and turns a refusal into an error', () => {
		const end = (reason: string) =>
			run([start, { type: 'message_delta', delta: { stop_reason: reason }, usage: {} }, { type: 'message_stop' }])
				.final;
		const stop = end('end_turn');
		expect(stop.type === 'done' && stop.reason).toBe('stop');
		const length = end('max_tokens');
		expect(length.type === 'done' && length.reason).toBe('length');
		expect(end('refusal').type).toBe('error');
	});
});
