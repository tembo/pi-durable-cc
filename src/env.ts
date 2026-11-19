/**
 * Flags every Claude Code process gets. Pi owns the conversation, so Claude Code must not change it on its own.
 * Adapted from pi-claude-bridge (MIT, Eli Dickinson), which documents why each one is needed.
 */
export const CLAUDE_CODE_FLAGS: Readonly<Record<string, string>> = {
	// The workspace's claude.ai MCP connections stay out; Pi serves its own tools.
	ENABLE_CLAUDEAI_MCP_SERVERS: '0',
	// Pi compacts; Claude Code compacting its own copy would diverge from Pi's history.
	DISABLE_AUTO_COMPACT: '1',
	// No per-request audit records in the session file, which Claude Code never reads back.
	CLAUDE_CODE_ELEGANT_MEADOW: '0',
	// No update checks, MCP registry or telemetry.
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
	DISABLE_AUTOUPDATER: '1',
	// A resumed session ending at a tool result must not get a "Continue from where you left off" message.
	CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: '1',
	// No reminders injected that are not in Pi's history.
	CLAUDE_CODE_SILENT_TURN_REMINDER: '0',
	// Tool descriptions are sent whole, as Pi's own providers do.
	CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: '16384',
};

/** Variables a Claude Code process needs from its host to run at all. Nothing else is inherited. */
const INHERITED = [
	'PATH',
	'LANG',
	'LC_ALL',
	'TZ',
	'TMPDIR',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
];

const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/** Whether a credential is a Claude subscription OAuth token rather than an API key. */
export function isOAuthToken(credential: string) {
	return credential.startsWith(OAUTH_TOKEN_PREFIX);
}

/**
 * The environment of one Claude Code process. It never inherits the host's secrets: a worker serving many users
 * must not hand one user's process another's credentials. `env` comes last and wins; an empty value removes a key.
 */
export function claudeCodeEnv(params: {
	credential?: string;
	configDir: string;
	home: string;
	env?: Readonly<Record<string, string | undefined>>;
	inheritEnv?: boolean;
	clientApp: string;
}): Record<string, string> {
	const result: Record<string, string> = {};
	const host = params.inheritEnv
		? Object.entries(process.env)
		: INHERITED.map((key) => [key, process.env[key]] as const);
	for (const [key, value] of host) {
		if (value !== undefined) result[key] = value;
	}
	Object.assign(result, CLAUDE_CODE_FLAGS, {
		HOME: params.home,
		CLAUDE_CONFIG_DIR: params.configDir,
		CLAUDE_AGENT_SDK_CLIENT_APP: params.clientApp,
	});
	if (params.credential) {
		if (isOAuthToken(params.credential)) {
			result.CLAUDE_CODE_OAUTH_TOKEN = params.credential;
			delete result.ANTHROPIC_API_KEY;
		} else {
			result.ANTHROPIC_API_KEY = params.credential;
			delete result.CLAUDE_CODE_OAUTH_TOKEN;
		}
	}
	for (const [key, value] of Object.entries(params.env ?? {})) {
		if (value === undefined || value === '') delete result[key];
		else result[key] = value;
	}
	return result;
}
