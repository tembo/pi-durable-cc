import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	calculateCost,
	type Model,
	type StopReason,
	type ToolCall,
	type Usage,
} from '@earendil-works/pi-ai';

export type StreamEvent = SDKPartialAssistantMessage['event'];

type DoneReason = Extract<StopReason, 'stop' | 'length' | 'toolUse'>;

interface UsageFields {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** An assistant message with no content, used to report a failure as Pi's providers do. */
export function failedMessage(
	model: Model<string>,
	reason: 'error' | 'aborted',
	errorMessage: string
): AssistantMessage {
	return {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: reason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function mapStopReason(reason: string | null | undefined): DoneReason {
	if (reason === 'tool_use') return 'toolUse';
	if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') {
		return 'length';
	}
	return 'stop';
}

type Slot =
	| { kind: 'text'; index: number }
	| { kind: 'thinking'; index: number }
	| { kind: 'toolCall'; index: number; json: string }
	| { kind: 'ignored' };

/**
 * Builds one Pi assistant message from the raw stream events of one model response. Each `accept` returns the Pi
 * events to emit; `partial` is the shared response-so-far, as Pi's own providers keep it.
 */
export class AssistantBuilder {
	readonly partial: AssistantMessage;
	#slots = new Map<number, Slot>();
	#usage: UsageFields = {};
	#stopReason: string | null | undefined;
	#refusal = false;

	constructor(
		private readonly model: Model<string>,
		private readonly toolName: (ccName: string) => string
	) {
		this.partial = {
			role: 'assistant',
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: 'stop',
			timestamp: Date.now(),
		};
	}

	/** Whether the response asked for tools, so Claude Code is now waiting for their results. */
	get wantsTools() {
		return this.#stopReason === 'tool_use';
	}

	accept(event: StreamEvent): AssistantMessageEvent[] {
		const partial = this.partial;
		switch (event.type) {
			case 'message_start': {
				partial.responseModel = event.message.model;
				partial.responseId = event.message.id;
				this.#usage = { ...(event.message.usage as UsageFields) };
				return [{ type: 'start', partial }];
			}
			case 'content_block_start': {
				const block = event.content_block;
				const index = partial.content.length;
				if (block.type === 'text') {
					partial.content.push({ type: 'text', text: '' });
					this.#slots.set(event.index, { kind: 'text', index });
					return [{ type: 'text_start', contentIndex: index, partial }];
				}
				if (block.type === 'thinking') {
					partial.content.push({ type: 'thinking', thinking: '' });
					this.#slots.set(event.index, { kind: 'thinking', index });
					return [{ type: 'thinking_start', contentIndex: index, partial }];
				}
				if (block.type === 'redacted_thinking') {
					partial.content.push({
						type: 'thinking',
						thinking: '',
						redacted: true,
						thinkingSignature: block.data,
					});
					this.#slots.set(event.index, { kind: 'thinking', index });
					return [{ type: 'thinking_start', contentIndex: index, partial }];
				}
				if (block.type === 'tool_use') {
					partial.content.push({
						type: 'toolCall',
						id: block.id,
						name: this.toolName(block.name),
						arguments: {},
					});
					this.#slots.set(event.index, { kind: 'toolCall', index, json: '' });
					return [{ type: 'toolcall_start', contentIndex: index, partial }];
				}
				this.#slots.set(event.index, { kind: 'ignored' });
				return [];
			}
			case 'content_block_delta': {
				const slot = this.#slots.get(event.index);
				if (!slot || slot.kind === 'ignored') return [];
				const delta = event.delta;
				const block = partial.content[slot.index];
				if (delta.type === 'text_delta' && block?.type === 'text') {
					block.text += delta.text;
					return [
						{
							type: 'text_delta',
							contentIndex: slot.index,
							delta: delta.text,
							partial,
						},
					];
				}
				if (delta.type === 'thinking_delta' && block?.type === 'thinking') {
					block.thinking += delta.thinking;
					return [
						{
							type: 'thinking_delta',
							contentIndex: slot.index,
							delta: delta.thinking,
							partial,
						},
					];
				}
				if (delta.type === 'signature_delta' && block?.type === 'thinking') {
					block.thinkingSignature =
						(block.thinkingSignature ?? '') + delta.signature;
					return [];
				}
				if (delta.type === 'input_json_delta' && slot.kind === 'toolCall') {
					slot.json += delta.partial_json;
					return [
						{
							type: 'toolcall_delta',
							contentIndex: slot.index,
							delta: delta.partial_json,
							partial,
						},
					];
				}
				return [];
			}
			case 'content_block_stop': {
				const slot = this.#slots.get(event.index);
				if (!slot || slot.kind === 'ignored') return [];
				const block = partial.content[slot.index];
				if (slot.kind === 'text' && block?.type === 'text') {
					return [
						{
							type: 'text_end',
							contentIndex: slot.index,
							content: block.text,
							partial,
						},
					];
				}
				if (slot.kind === 'thinking' && block?.type === 'thinking') {
					return [
						{
							type: 'thinking_end',
							contentIndex: slot.index,
							content: block.thinking,
							partial,
						},
					];
				}
				if (slot.kind === 'toolCall' && block?.type === 'toolCall') {
					parseArguments(block, slot.json);
					return [
						{
							type: 'toolcall_end',
							contentIndex: slot.index,
							toolCall: block,
							partial,
						},
					];
				}
				return [];
			}
			case 'message_delta': {
				this.#stopReason = event.delta.stop_reason;
				if (event.delta.stop_reason === 'refusal') this.#refusal = true;
				for (const [key, value] of Object.entries(event.usage ?? {})) {
					if (typeof value === 'number') {
						(this.#usage as Record<string, number>)[key] = value;
					}
				}
				return [];
			}
			default:
				return [];
		}
	}

	/** The terminal event for a response whose `message_stop` arrived. */
	finish(): AssistantMessageEvent {
		const usage = this.#usage;
		const partial = this.partial;
		partial.usage = {
			input: usage.input_tokens ?? 0,
			output: usage.output_tokens ?? 0,
			cacheRead: usage.cache_read_input_tokens ?? 0,
			cacheWrite: usage.cache_creation_input_tokens ?? 0,
			totalTokens:
				(usage.input_tokens ?? 0) +
				(usage.output_tokens ?? 0) +
				(usage.cache_read_input_tokens ?? 0) +
				(usage.cache_creation_input_tokens ?? 0),
			cost: emptyUsage().cost,
		};
		partial.usage.cost = calculateCost(this.model, partial.usage);
		if (this.#stopReason) partial.rawStopReason = this.#stopReason;
		if (this.#refusal) {
			partial.stopReason = 'error';
			partial.errorMessage = 'The model declined to answer (refusal).';
			return { type: 'error', reason: 'error', error: partial };
		}
		const reason = mapStopReason(this.#stopReason);
		partial.stopReason = reason;
		return { type: 'done', reason, message: partial };
	}
}

function parseArguments(block: ToolCall, json: string) {
	if (!json.trim()) {
		block.arguments = {};
		return;
	}
	try {
		const parsed: unknown = JSON.parse(json);
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			block.arguments = parsed as ToolCall['arguments'];
			return;
		}
		block.arguments = {};
		block.argumentsError = `The arguments were not a JSON object: ${json}`;
	} catch {
		block.arguments = {};
		block.argumentsError = `The arguments were not valid JSON: ${json}`;
	}
}
