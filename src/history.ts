import type {
	ImageContent,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from '@earendil-works/pi-ai';
import {
	type ContentBlock,
	createSession,
	type Message as SessionMessage,
} from 'cc-session-io';
import type { ConversationMessage } from './context.js';
import { TOOL_NAME_PREFIX } from './mcp-server.js';
import { CLAUDE_CODE_API } from './models.js';

/** Anthropic requires tool ids to match `^[a-zA-Z0-9_-]+$`; ids from other providers may not. */
export function claudeToolId(id: string) {
	return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

type UserBlock = Extract<ContentBlock, { type: 'text' | 'image' }>;

export function userBlocks(
	content: string | (TextContent | ImageContent)[]
): UserBlock[] {
	if (typeof content === 'string') {
		return content ? [{ type: 'text', text: content }] : [];
	}
	const blocks: UserBlock[] = [];
	for (const block of content) {
		if (block.type === 'text' && block.text) {
			blocks.push({ type: 'text', text: block.text });
		} else if (block.type === 'image') {
			blocks.push({
				type: 'image',
				source: { type: 'base64', media_type: block.mimeType, data: block.data },
			});
		}
	}
	return blocks;
}

/** A tool result as Claude Code stores it: text when it is only text, blocks when it carries an image. */
export function toolResultContent(
	message: ToolResultMessage
): string | UserBlock[] {
	const blocks = userBlocks(message.content);
	if (blocks.length === 0) {
		// Claude Code never sends an empty result, and the API rejects an empty one marked as an error.
		return message.isError
			? 'The tool failed with no output.'
			: `(${message.toolName} completed with no output)`;
	}
	return blocks.every((block) => block.type === 'text')
		? blocks.map((block) => (block as { text: string }).text).join('\n')
		: blocks;
}

function userMessage(message: UserMessage): SessionMessage {
	const blocks = userBlocks(message.content);
	return { role: 'user', content: blocks.length > 0 ? blocks : '[empty]' };
}

/**
 * Pi's conversation as Anthropic messages. A turn's tool results go in one user message right after its tool calls,
 * and a steer that arrived while they ran follows them, as Claude Code orders it: a result anywhere else would no
 * longer pair with its call.
 */
export function toSessionMessages(
	messages: readonly ConversationMessage[]
): SessionMessage[] {
	const converted: SessionMessage[] = [];
	let results: { role: 'user'; content: ContentBlock[] } | undefined;
	let pending = new Set<string>();
	let deferred: SessionMessage[] = [];
	const flush = () => {
		converted.push(...deferred);
		deferred = [];
	};
	for (const message of messages) {
		if (message.role === 'user') {
			if (pending.size > 0) {
				deferred.push(userMessage(message));
			} else {
				results = undefined;
				converted.push(userMessage(message));
			}
			continue;
		}
		if (message.role === 'toolResult') {
			const block: ContentBlock = {
				type: 'tool_result',
				tool_use_id: claudeToolId(message.toolCallId),
				content: toolResultContent(message),
				...(message.isError ? { is_error: true } : {}),
			};
			if (results) {
				results.content.push(block);
			} else {
				results = { role: 'user', content: [block] };
				converted.push(results);
			}
			pending.delete(message.toolCallId);
			if (pending.size === 0) flush();
			continue;
		}
		const blocks: ContentBlock[] = [];
		const calls = new Set<string>();
		for (const block of message.content) {
			if (block.type === 'text' && block.text) {
				blocks.push({ type: 'text', text: block.text });
			} else if (block.type === 'thinking') {
				// Only thinking Claude Code produced can be replayed: Anthropic rejects signatures it did not mint here.
				if (
					message.api === CLAUDE_CODE_API &&
					block.thinkingSignature &&
					!block.redacted
				) {
					blocks.push({
						type: 'thinking',
						thinking: block.thinking,
						signature: block.thinkingSignature,
					});
				}
			} else if (block.type === 'toolCall') {
				calls.add(block.id);
				blocks.push({
					type: 'tool_use',
					id: claudeToolId(block.id),
					name: `${TOOL_NAME_PREFIX}${block.name}`,
					input: block.arguments,
				});
			}
		}
		// A turn aborted before anything streamed has no content; leaving it out keeps the replayed prefix unchanged.
		if (blocks.length === 0) continue;
		// Calls that never got a result are stubbed by the pairing repair on import.
		flush();
		results = undefined;
		pending = calls;
		converted.push({ role: 'assistant', content: blocks });
	}
	flush();
	return converted;
}

/** Write Pi's history as a Claude Code session that a query can resume. Returns the session id. */
export function importHistory(params: {
	messages: readonly ConversationMessage[];
	configDir: string;
	cwd: string;
	modelId: string;
}): string {
	const session = createSession({
		projectPath: params.cwd,
		claudeDir: params.configDir,
		cwd: params.cwd,
		model: params.modelId,
	});
	// importMessages also repairs tool_use/tool_result pairing, so a turn cut off mid-tool still resumes.
	session.importMessages(toSessionMessages(params.messages));
	session.save();
	return session.sessionId;
}
