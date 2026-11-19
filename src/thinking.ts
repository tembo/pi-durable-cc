import type { EffortLevel, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Model } from '@earendil-works/pi-ai';

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Claude Code's thinking settings for a Pi thinking level. The model catalog's `thinkingLevelMap` gives the provider
 * value for each level: an effort name for adaptive models, a token budget for older ones, `null` when unsupported.
 */
export function thinkingOptions(
	model: Model<string>,
	level: string | undefined
): Pick<Options, 'thinking' | 'effort'> {
	if (!model.reasoning) return { thinking: { type: 'disabled' } };
	const map = (model.thinkingLevelMap ?? {}) as Record<
		string,
		string | number | null | undefined
	>;
	const requested = level ?? 'off';
	if (requested === 'off') {
		// Models that cannot turn thinking off map "off" to null; they think as little as they can instead.
		return map.off === null
			? { thinking: { type: 'adaptive' }, effort: 'low' }
			: { thinking: { type: 'disabled' } };
	}
	const value = map[requested];
	if (typeof value === 'number') {
		return { thinking: { type: 'enabled', budgetTokens: value } };
	}
	if (typeof value === 'string' && EFFORTS.has(value)) {
		return { thinking: { type: 'adaptive' }, effort: value as EffortLevel };
	}
	if (EFFORTS.has(requested)) {
		return { thinking: { type: 'adaptive' }, effort: requested as EffortLevel };
	}
	// A level the model does not support, such as "minimal": the closest one it has.
	return { thinking: { type: 'adaptive' }, effort: 'low' };
}
