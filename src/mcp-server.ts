import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Tool } from '@earendil-works/pi-ai';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Claude Code stamps every MCP tools/call with the id of the tool_use block it came from. It is the only reliable way
 * to pair a call with the result Pi produces: call order need not match the order of the blocks.
 */
const TOOL_USE_ID_META = 'claudecode/toolUseId';

/** Name of the MCP server that carries Pi's tools; Claude Code calls them `mcp__pi__<tool>`. */
export const TOOL_SERVER_NAME = 'pi';
export const TOOL_NAME_PREFIX = `mcp__${TOOL_SERVER_NAME}__`;

export type ToolCallHandler = (call: {
	toolUseId: string;
	name: string;
}) => Promise<CallToolResult>;

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Claude Code drops a tool whose schema has a top-level anyOf, oneOf or allOf, so those are advertised as one flat
 * object with every branch's properties. Pi still validates the call against the real schema.
 */
function advertisedSchema(parameters: unknown): JsonSchema {
	if (!isRecord(parameters)) return { type: 'object', properties: {} };
	const combinators = ['anyOf', 'oneOf', 'allOf'].filter(
		(key) => key in parameters
	);
	if (parameters.type === 'object' && combinators.length === 0) {
		return parameters;
	}
	const {
		anyOf: _anyOf,
		oneOf: _oneOf,
		allOf: _allOf,
		...rest
	} = parameters;
	const properties: JsonSchema = isRecord(parameters.properties)
		? { ...parameters.properties }
		: {};
	for (const key of combinators) {
		const branches = parameters[key];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			if (!isRecord(branch) || !isRecord(branch.properties)) continue;
			for (const [name, schema] of Object.entries(branch.properties)) {
				if (!(name in properties)) properties[name] = schema;
			}
		}
	}
	return { ...rest, type: 'object', properties };
}

/** An in-process MCP server that hands every call to `onCall`, which answers once Pi has run the tool. */
export function createToolServer(
	tools: readonly Tool[],
	onCall: ToolCallHandler,
	timeoutMs: number
): McpSdkServerConfigWithInstance {
	const server = new McpServer(
		{ name: TOOL_SERVER_NAME, version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);
	const names = new Set(tools.map((tool) => tool.name));
	// Served on the protocol server directly: McpServer.registerTool only takes Zod, and Pi's tools are JSON Schema.
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: advertisedSchema(tool.parameters) as {
				type: 'object';
			},
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name } = request.params;
		if (!names.has(name)) throw new Error(`Unknown tool: ${name}`);
		const toolUseId = request.params._meta?.[TOOL_USE_ID_META];
		if (typeof toolUseId !== 'string') {
			throw new Error(
				`${name}: the call has no _meta["${TOOL_USE_ID_META}"], so its result cannot be paired with its tool call`
			);
		}
		return onCall({ toolUseId, name });
	});
	return {
		type: 'sdk',
		name: TOOL_SERVER_NAME,
		instance: server,
		timeout: timeoutMs,
	};
}
