import type { Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeEnv } from '../../src/env.js';
import { claudeCodeModels } from '../../src/models.js';
import { thinkingOptions } from '../../src/thinking.js';

const saved = { ...process.env };
afterEach(() => {
	process.env = { ...saved };
});

describe('claudeCodeEnv', () => {
	const base = { configDir: '/c', home: '/h', clientApp: 'test' };

	it("never hands a process the host's secrets", () => {
		process.env.ANTHROPIC_API_KEY = 'host-key';
		process.env.DATABASE_URL = 'postgres://secret';
		const env = claudeCodeEnv({ ...base, credential: 'user-key' });
		expect(env.ANTHROPIC_API_KEY).toBe('user-key');
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
		expect(env.DISABLE_AUTO_COMPACT).toBe('1');
	});

	it('passes a subscription token as an OAuth token, and lets callers remove variables', () => {
		const env = claudeCodeEnv({
			...base,
			credential: 'sk-ant-oat01-token',
			env: { ANTHROPIC_BASE_URL: 'https://gateway', DISABLE_AUTO_COMPACT: '' },
		});
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-token');
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway');
		expect(env.DISABLE_AUTO_COMPACT).toBeUndefined();
	});
});

describe('thinkingOptions', () => {
	const models = claudeCodeModels();
	const find = (id: string) => models.find((model) => model.id === id) as Model<string>;

	it('uses the catalog effort for adaptive models', () => {
		expect(thinkingOptions(find('claude-sonnet-5-5'), 'high')).toEqual({
			thinking: { type: 'adaptive' },
			effort: 'high',
		});
	});

	it('thinks as little as possible on models that cannot turn thinking off', () => {
		expect(thinkingOptions(find('claude-sonnet-5-5'), undefined)).toEqual({
			thinking: { type: 'adaptive' },
			effort: 'low',
		});
		expect(thinkingOptions(find('claude-haiku-5-5'), undefined)).toEqual({ thinking: { type: 'disabled' } });
	});

	it('falls back to the lowest effort for a level the model does not support', () => {
		expect(thinkingOptions(find('claude-haiku-5-5'), 'minimal')).toEqual({
			thinking: { type: 'adaptive' },
			effort: 'low',
		});
	});
});
