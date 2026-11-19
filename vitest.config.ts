import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Each test opens its own Claude Code processes; running them one at a time keeps failures readable.
		fileParallelism: false,
	},
});
