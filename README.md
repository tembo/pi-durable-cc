# @tembo/pi-durable-cc

Claude Code as a model API for [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Pi's durable harness keeps the conversation, the tools and the crash recovery; Claude models answer through the official Claude Code binary, signed in with an Anthropic API key or a Claude subscription token.

```ts
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { claudeCodeApi, claudeCodeModels } from '@tembo/pi-durable-cc';

const api = claudeCodeApi();
const models = createModels();
models.setProvider(
	createProvider({
		id: 'claude-code',
		name: 'Claude Code',
		auth: {
			apiKey: {
				name: 'Claude credential',
				// An API key, or a subscription token from `claude setup-token` (sk-ant-oat…).
				resolve: async () => ({ auth: { apiKey: process.env.CLAUDE_CODE_OAUTH_TOKEN! }, source: 'env' }),
			},
		},
		models: claudeCodeModels(),
		api,
	})
);

const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
const root = await harness.root(context, {
	agent: { model: { provider: 'claude-code', modelId: 'claude-opus-5-5' }, thinkingLevel: 'low' },
});
// … submit inputs as usual …
await harness.close(context);
await api.close(); // stops the Claude Code processes this API started
```

Whether a Claude subscription may be used this way depends on Anthropic's terms for your use case. Check them before you rely on it; an API key always works.

## How it works

- **One process per conversation.** Pi calls the model once per request; Claude Code runs a whole turn, tool calls included, in one process. Each conversation (Pi's durable provider `sessionId`) gets one Claude Code process that stays open across the requests of a turn and across turns.
- **Pi's tools, nothing else.** Claude Code's own tools are off (`tools: []`, no settings files, no other MCP servers). Pi's tools are served to it over an in-process MCP server. When Claude calls one, the Pi request ends with that tool call, Pi runs the tool as a durable task, and the next request hands the result to the waiting MCP call. Results are paired by the `tool_use` id Claude Code stamps on every call.
- **Pi is the source of truth.** Every message is fingerprinted. A request that only adds to what the process holds (tool results, a new input, a steer) continues it. Anything else rebuilds: a new process, a worker restart, compaction, a changed prompt, model, thinking level or credential. The rebuild writes Pi's history as a Claude Code session ([cc-session-io](https://www.npmjs.com/package/cc-session-io)) and resumes it, thinking signatures included, so prompt caching keeps working. History that ends at a tool result, as after a crash mid-tool, resumes with a short "continue" prompt.
- **One-off requests stay one-off.** Compaction summaries and other requests sent with `cacheRetention: "none"` or `disableContinuation` run in a throwaway process, so they never enter the conversation's session.
- **Streaming as usual.** Claude Code's raw stream events become Pi's text, thinking and tool-call events, with usage priced from the model catalog (`claudeCodeModels({ zeroCost: true })` reports zero cost for subscription usage).

## Running it in a worker

- Each process gets a private config, home and working directory in the temp directory, and an environment built from scratch: only `PATH`, locale, proxy and certificate variables, its own credential and the flags in `CLAUDE_CODE_FLAGS`. A worker serving many users never hands one user's process another's secrets. Pass `inheritEnv: true` to inherit everything instead.
- In a job runner such as Temporal, one job usually runs one turn: the turn's tool loop stays in one process, and the next job, on any worker, rebuilds from Pi's storage. Call `api.close()` when the job's harness closes.
- The Claude Code binary comes with `@anthropic-ai/claude-agent-sdk` as a platform package (glibc or musl). Use `executable` to point at another one.
- Idle processes close after `idleTimeoutMs` (10 minutes); a process waits up to `toolTimeoutMs` (6 hours) for Pi to run a tool.

## Options

| Option | Default | |
| --- | --- | --- |
| `executable` | bundled binary | Path to `claude`. |
| `env` | | Extra environment for every process; an empty value removes a variable. |
| `inheritEnv` | `false` | Inherit this process's whole environment. |
| `tmpDir` | OS temp dir | Where session directories go. |
| `idleTimeoutMs` | 10 min | Close idle processes after this long. |
| `toolTimeoutMs` | 6 h | How long Claude Code waits for a tool result. |
| `clientApp` | `pi-durable-cc/<version>` | Identifies the app in Claude Code's User-Agent. |
| `debug` | | Lifecycle notes, for logs. Never message content. |
| `queryOptions` | | Extra Claude Agent SDK options, applied last. |

## Development

```sh
npm install
npm run typecheck
npm test                # unit tests, offline
ANTHROPIC_API_KEY=… npm run test:integration   # a real harness on real Claude Code
```

The integration tests drive pi-durable through Claude Code: a plain answer, a tool loop that reuses one process, a rebuild after a restart, a turn cut off mid-tool, a steer during a tool call, thinking replayed through reuse and rebuild, and abort. They run under Node and Bun (`bun --bun ./node_modules/.bin/vitest run test/integration`).

## Credits

The MCP tool-id pairing, the Claude Code environment flags and the history conversion follow [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson (MIT). See `NOTICE`.
