import { createHash } from 'node:crypto';
import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	UserMessage,
} from '@earendil-works/pi-ai';
import {
	getCurrentSystemPrompt,
	getCurrentTools,
} from '@earendil-works/pi-ai/utils/transcript';

/** A message Claude Code sees as conversation: everything but system messages. */
export type ConversationMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage;

/** A request as Claude Code needs it: one system prompt, one tool set and the conversation. */
export interface Request {
	systemPrompt: string;
	tools: Tool[];
	conversation: ConversationMessage[];
	/** Fingerprint of everything outside the conversation that a running Claude Code process holds fixed. */
	setupDigest: string;
}

function sha256(value: string) {
	return createHash('sha256').update(value).digest('hex');
}

/** JSON with sorted object keys, so equal values always serialize the same way. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function isConversationMessage(
	message: Message
): message is ConversationMessage {
	return (
		message.role === 'user' ||
		message.role === 'assistant' ||
		message.role === 'toolResult'
	);
}

/** Read a transcript the way Claude Code needs it: replayed system state plus the conversation. */
export function readRequest(
	context: TranscriptContext,
	setup: Record<string, unknown>
): Request {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages);
	return {
		systemPrompt,
		tools,
		conversation: context.messages.filter(isConversationMessage),
		setupDigest: sha256(
			stableJson({
				systemPrompt,
				tools: tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
				...setup,
			})
		),
	};
}

function contentDigest(content: string | (TextContent | ImageContent)[]) {
	if (typeof content === 'string') return [{ text: content }];
	return content.map((block) =>
		block.type === 'text'
			? { text: block.text }
			: { image: sha256(block.data), mimeType: block.mimeType }
	);
}

/**
 * A fingerprint of what a message says to the model. Two messages with the same fingerprint render the same request,
 * so a running Claude Code process can be reused for a conversation whose earlier messages all match.
 */
export function digestMessage(message: ConversationMessage): string {
	switch (message.role) {
		case 'user':
			return sha256(stableJson({ user: contentDigest(message.content) }));
		case 'toolResult':
			return sha256(
				stableJson({
					toolResult: message.toolCallId,
					isError: message.isError,
					content: contentDigest(message.content),
				})
			);
		case 'assistant':
			return sha256(
				stableJson({
					assistant: message.content.map((block) => {
						if (block.type === 'text') return { text: block.text };
						if (block.type === 'thinking') {
							return {
								thinking: block.thinking,
								signature: block.thinkingSignature ?? null,
								redacted: block.redacted ?? false,
							};
						}
						return {
							toolCall: block.id,
							name: block.name,
							arguments: block.arguments,
						};
					}),
				})
			);
	}
}
