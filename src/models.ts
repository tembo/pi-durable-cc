import type { Model } from '@earendil-works/pi-ai';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';

/** The `model.api` id of models served through Claude Code. */
export const CLAUDE_CODE_API = 'claude-code';

/** The provider id {@link claudeCodeModels} uses unless told otherwise. */
export const DEFAULT_PROVIDER_ID = 'claude-code';

export interface ClaudeCodeModelsOptions {
	/** Provider id the models belong to. It must match the id passed to `createProvider`. */
	provider?: string;
	/**
	 * Report a cost of zero. Use it when requests are billed to a Claude subscription, where
	 * catalog API prices would overstate what the request cost.
	 */
	zeroCost?: boolean;
}

/** pi-ai's Anthropic chat models, served through Claude Code instead of the Messages API. */
export function claudeCodeModels(
	options: ClaudeCodeModelsOptions = {}
): Model<typeof CLAUDE_CODE_API>[] {
	const provider = options.provider ?? DEFAULT_PROVIDER_ID;
	return Object.values(ANTHROPIC_MODELS)
		.filter((model) => model.type === undefined || model.type === 'chat')
		.map((model) => {
			const { compat: _compat, ...rest } = model as Model<string>;
			return {
				...rest,
				api: CLAUDE_CODE_API,
				provider,
				baseUrl: 'claude-code:',
				...(options.zeroCost
					? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
					: {}),
			} as Model<typeof CLAUDE_CODE_API>;
		});
}
