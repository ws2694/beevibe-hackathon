import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  RuntimeWorkspaceContext,
  Workspace,
} from "../../ports/runtime.js";
import { runCliProcess } from "../claude-code/spawn.js";
import { tailTrajectory } from "./trajectory-tail.js";

const DEFAULT_COMMAND = "openclaw";
// Verified live against Nebius 2026-06-12 (PONG via Qwen3.5-397B).
// Prefix `nebius/` requires registering Nebius as a custom OpenClaw
// provider in ~/.openclaw/openclaw.json — done out-of-band via:
//   openclaw config patch --stdin <<<<EOF
//     {"models":{"providers":{"nebius":{
//        "baseUrl":"https://api.studio.nebius.com/v1",
//        "apiKey":"<NEBIUS_API_KEY>",
//        "models":[{"id":"Qwen/Qwen3.5-397B-A17B-fast", "api":"openai-completions", ...}]
//     }}}}
//   EOF
// Documented fallback: nebius/deepseek-ai/DeepSeek-V3.2-fast.
const DEFAULT_MODEL = "nebius/Qwen/Qwen3.5-397B-A17B-fast";
// OpenClaw's own default timeout per its CLI help.
const DEFAULT_TIMEOUT_SECONDS = 600;

export interface OpenClawRuntimeConfig {
  /** Override CLI command (defaults to "openclaw" on PATH). */
  command?: string;
  /**
   * OpenClaw model id in `provider/model` form. Defaults to
   * `openai/<BEEVIBE_OPENCLAW_MODEL>` (env-derived) so the same env var
   * controls both this runtime and the M5 docs. Falls back to a known-good
   * Qwen-on-Nebius via openai-compatible provider.
   */
  model?: string;
  /** Default per-invocation timeout in seconds. */
  timeoutSeconds?: number;
}

/**
 * OpenClaw CLI subprocess runtime.
 *
 * OpenClaw is a "self-hosted gateway" agent runtime with its own profile
 * model, MCP support, and session store. We use its `agent --local` mode
 * which runs embedded (no Gateway daemon required), so each beevibe spawn
 * is a self-contained subprocess — matching the lifecycle of Claude Code,
 * Codex, and OpenCode.
 *
 * Nebius wiring: OpenClaw's `openai` provider is an OpenAI-compatible
 * client. We point its `OPENAI_API_KEY` + `OPENAI_BASE_URL` env at Nebius
 * and pass model ids in `openai/<nebius-model-id>` form. No native Nebius
 * provider is needed — OpenAI compatibility is the bridge.
 *
 * Session resume: OpenClaw has first-class session ids (--session-id).
 * Maps directly onto RuntimeContext.resume_session_id and
 * RuntimeResult.cli_session_id — no history-replay fallback required.
 *
 * MCP wiring: OpenClaw persists MCP server configs per-profile in
 * `~/.openclaw/openclaw.json`. `prepareWorkspace` registers our servers
 * (beevibe, optional composio, optional tavily) idempotently via
 * `openclaw mcp set`. Default profile is shared across all beevibe
 * agents for the hackathon — no per-agent profile isolation yet.
 */
export class OpenClawRuntime implements AgentRuntime {
  readonly type = "openclaw";

  constructor(private config: OpenClawRuntimeConfig = {}) {}

  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    const args = buildAgentArgs(context, this.config);
    const env = composeOpenClawEnv(context);

    // OpenClaw doesn't stream events on stdout — it writes a
    // `<sessionId>.trajectory.jsonl` file in real time as the agent
    // runs. We tail that file in parallel with the subprocess and emit
    // RuntimeSteps via context.onStep so session_event rows populate
    // live. The other runtime adapters do the equivalent via stdout
    // stream-json parsing; this is the OpenClaw-shaped version.
    const tailerAbort = new AbortController();
    const tailerDone = context.onStep
      ? tailTrajectory({
          onStep: context.onStep,
          abortSignal: tailerAbort.signal,
        }).catch((err: unknown) => {
          console.warn(
            "[OpenClawRuntime] trajectory tail failed:",
            err instanceof Error ? err.message : err,
          );
        })
      : Promise.resolve();

    const result = await runCliProcess({
      command: this.config.command ?? DEFAULT_COMMAND,
      args,
      cwd: context.workspace.path,
      env,
      abortSignal: context.abort_signal,
      onSpawn: ({ pid, process_group_id }) => {
        context.onSpawn?.({ process_pid: pid, process_group_id });
      },
    });

    // Subprocess settled — stop the tailer so it can drain trailing
    // lines and exit cleanly. We await it so onStep emissions finish
    // BEFORE we return RuntimeResult (the agent-session layer is
    // best-effort about persisting events anyway, but draining first
    // keeps the session_event tail aligned with the actual end).
    tailerAbort.abort();
    await tailerDone;

    if (result.aborted) {
      return {
        status: "cancelled",
        output: "Session cancelled.",
        process_pid: result.pid ?? undefined,
        process_group_id: result.process_group_id ?? undefined,
      };
    }

    const parsed = parseAgentResult(result.stdout);
    const STDERR_TAIL_BYTES = 4096;
    const stderrTail =
      result.exitCode !== 0 && result.stderr
        ? result.stderr.slice(-STDERR_TAIL_BYTES)
        : undefined;

    if (result.exitCode === 0) {
      return {
        status: "completed",
        output: parsed.output,
        cli_session_id: parsed.session_id,
        process_pid: result.pid ?? undefined,
        process_group_id: result.process_group_id ?? undefined,
        exit_code: result.exitCode,
      };
    }

    return {
      status: "failed",
      output:
        parsed.output ||
        `OpenClaw CLI exited with code ${result.exitCode ?? "null"}`,
      cli_session_id: parsed.session_id,
      process_pid: result.pid ?? undefined,
      process_group_id: result.process_group_id ?? undefined,
      exit_code: result.exitCode,
      ...(stderrTail ? { stderr: stderrTail } : {}),
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    try {
      const result = await runCliProcess({
        command: this.config.command ?? DEFAULT_COMMAND,
        args: ["--version"],
        cwd: tmpdir(),
        timeoutMs: 5_000,
        graceMs: 0,
      });
      return { healthy: result.exitCode === 0 };
    } catch {
      return {
        healthy: false,
        error: `Command not found: ${this.config.command ?? DEFAULT_COMMAND}`,
      };
    }
  }

  async shutdown(): Promise<void> {
    /* stateless — each session is a separate process */
  }

  skillsDir(workspace: Workspace): string {
    // OpenClaw uses `.openclaw/skills` per its skills discovery convention.
    return join(workspace.path, ".openclaw", "skills");
  }

  async prepareWorkspace(context: RuntimeWorkspaceContext): Promise<void> {
    // Register MCP servers in OpenClaw's profile config. Uses
    // `openclaw mcp set <name> <json>` which is an upsert — idempotent
    // across re-runs.
    await upsertOpenClawMcpServer(this.config.command ?? DEFAULT_COMMAND, "beevibe", {
      type: "http",
      url: context.mcpServerUrl,
      headers: {
        Authorization: `Bearer ${context.agentApiKey}`,
        "X-Beevibe-Session": "${BEEVIBE_SESSION_ID}",
      },
    });

    const composioUrl = process.env.COMPOSIO_MCP_URL?.trim();
    const composioKey = process.env.COMPOSIO_MCP_CONSUMER_KEY?.trim();
    if (composioUrl && composioKey) {
      await upsertOpenClawMcpServer(
        this.config.command ?? DEFAULT_COMMAND,
        "composio",
        {
          type: "http",
          url: composioUrl,
          headers: { "x-consumer-api-key": composioKey },
          // Drop OpenClaw-irrelevant meta-tools so the agent's tool list
          // stays focused. Composio's sandbox is wasted here — beevibe
          // provides its own workspace.
          exclude: [
            "COMPOSIO_REMOTE_BASH_TOOL",
            "COMPOSIO_REMOTE_WORKBENCH",
          ],
        },
      );
    }

    const tavilyKey = process.env.TAVILY_API_KEY?.trim();
    if (tavilyKey) {
      await upsertOpenClawMcpServer(
        this.config.command ?? DEFAULT_COMMAND,
        "tavily",
        {
          type: "http",
          url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${tavilyKey}`,
        },
      );
    }
  }
}

/**
 * Pure CLI-args builder — exposed for unit testing without spawning.
 * Mirrors the codex/opencode adapters' approach: keep the args composition
 * separately verifiable so a regression in flag ordering is caught fast.
 */
export function buildAgentArgs(
  context: RuntimeContext,
  config: OpenClawRuntimeConfig = {},
): string[] {
  const args = [
    "agent",
    "--local",
    "--json",
    "--timeout",
    String(config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
  ];

  const model =
    context.model ??
    config.model ??
    envModel() ??
    DEFAULT_MODEL;
  args.push("--model", model);

  if (context.resume_session_id) {
    args.push("--session-id", context.resume_session_id);
  } else {
    // OpenClaw requires ONE of --to, --session-key, --session-id, or
    // --agent on every invocation. For fresh spawns we mint a unique
    // session-key — beevibe owns multi-turn resume continuity via
    // resume_session_id, so we don't need OpenClaw's session-key to be
    // stable across calls. Random hex is sufficient.
    const unique = process.hrtime.bigint().toString(16);
    args.push("--session-key", `agent:beevibe:${unique}`);
  }

  args.push("--message", composePrompt(context));
  return args;
}

/**
 * Compose the user-message payload. Beevibe's system-prompt content goes
 * in front of the intent wrapped in delimiters that match what we do for
 * OpenCode — OpenClaw's `--message` is a single string, no separate
 * system-prompt flag.
 */
function composePrompt(context: RuntimeContext): string {
  if (context.system_prompt_append.length === 0) return context.intent;
  return [
    "<beevibe_system_context>",
    context.system_prompt_append,
    "</beevibe_system_context>",
    "",
    context.intent,
  ].join("\n");
}

// Provider prefixes OpenClaw recognizes via its catalog + our custom
// registration. Adding nebius first since that's the demo target; the
// others are baked into OpenClaw's built-in catalog and serve as escape
// hatches when the user wants to override BEEVIBE_OPENCLAW_MODEL with
// e.g. `claude-cli/claude-opus-4-7` directly.
const KNOWN_PROVIDER_PREFIXES = [
  "nebius/",
  "openai/",
  "claude-cli/",
  "anthropic/",
  "deepseek/",
  "groq/",
  "cerebras/",
  "deepinfra/",
] as const;

/**
 * Read BEEVIBE_OPENCLAW_MODEL and prepend `nebius/` if not already
 * provider-qualified. Nebius model ids are `vendor/model` (e.g.
 * `Qwen/Qwen3.5-397B-A17B-fast`, `meta-llama/Llama-3.3-70B-Instruct`) —
 * a slash alone doesn't indicate a provider since vendor/model itself
 * has one. Default to `nebius/` (the demo target); pass any prefix
 * from KNOWN_PROVIDER_PREFIXES verbatim.
 */
function envModel(): string | undefined {
  const raw = process.env.BEEVIBE_OPENCLAW_MODEL?.trim();
  if (!raw) return undefined;
  const hasKnownPrefix = KNOWN_PROVIDER_PREFIXES.some((p) =>
    raw.startsWith(p),
  );
  return hasKnownPrefix ? raw : `nebius/${raw}`;
}

/**
 * OpenAI provider env vars stripped from the spawned OpenClaw subprocess
 * before Nebius creds get injected. Without this, the daemon's shell
 * `OPENAI_API_KEY` (set in .env for the existing OpenAI memory adapter)
 * would silently route OpenClaw inference to api.openai.com and bill the
 * user's OpenAI account instead of using Nebius credits — same shape of
 * bug as ClaudeCodeRuntime's ANTHROPIC_AUTH_VARS strip and CodexRuntime's
 * OPENAI_AUTH_VARS strip. The difference: codex strips so its subscription
 * auth wins; we strip so Nebius wins.
 */
const OPENAI_PROVIDER_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_AUTH_TOKEN",
] as const;

/**
 * Inject Nebius credentials as OpenAI-compatible env vars so OpenClaw's
 * openai provider routes there. Mutates the passed env in place. Only
 * sets when the destination is unset to respect explicit overrides
 * supplied via `RuntimeContext.env`.
 */
export function injectNebiusOpenAiCompat(
  env: Record<string, string | undefined>,
): void {
  const nebiusKey = process.env.NEBIUS_API_KEY?.trim();
  const nebiusBase = process.env.NEBIUS_BASE_URL?.trim();
  if (nebiusKey && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = nebiusKey;
  if (nebiusBase && !env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = nebiusBase;
}

/**
 * Build the subprocess env for an OpenClaw spawn. The pipeline:
 *
 *   1. Start from process.env (preserves PATH, HOME, BEEVIBE_*, etc.).
 *   2. Strip `OPENAI_*` — see OPENAI_PROVIDER_VARS comment. Critical
 *      because the daemon's shell almost always has an OpenAI key for
 *      the memory subsystem, and that key must NOT leak into OpenClaw.
 *   3. Apply `RuntimeContext.env` overrides — explicit per-spawn wins.
 *   4. Fill `OPENAI_API_KEY` + `OPENAI_BASE_URL` from `NEBIUS_*` if
 *      still unset — the default path.
 *
 * Result: OpenClaw's openai provider points at Nebius unless the caller
 * explicitly overrode via `context.env`. Exposed for unit testing.
 */
export function composeOpenClawEnv(
  context: Pick<RuntimeContext, "env">,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of OPENAI_PROVIDER_VARS) {
    delete env[key];
  }
  if (context.env) Object.assign(env, context.env);
  injectNebiusOpenAiCompat(env);
  return env;
}

/**
 * Pure output parser — exposed for unit testing. OpenClaw `agent --json`
 * output shape can be either a single final JSON object or NDJSON with a
 * terminating result line. Tries both: parse the whole blob first, then
 * fall back to the last newline-delimited line.
 *
 * OpenClaw 2026.6.5 emits:
 *   { "payloads": [{ "text": "<reply>", "mediaUrl": null }],
 *     "meta": { "agentMeta": { "sessionId": "<uuid>", ... } } }
 *
 * We also accept the more generic shapes (top-level `message`/`reply`/
 * `text`/`content`/`output`, and top-level `session_id`/`sessionId`/
 * `session.id`) so future OpenClaw versions and adjacent CLIs don't
 * break us.
 *
 * Falls back to raw stdout text if no JSON parses.
 */
export function parseAgentResult(stdout: string): {
  output: string;
  session_id?: string;
} {
  const text = stdout.trim();
  if (!text) return { output: "" };

  const tryParse = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };

  // Whole stdout as JSON, or last NDJSON line.
  let parsed = tryParse(text);
  if (parsed === undefined) {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      parsed = tryParse(lines[i]!);
      if (parsed !== undefined) break;
    }
  }

  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { output: text };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    output: extractOutput(obj) ?? text,
    session_id: extractSessionId(obj),
  };
}

function extractOutput(obj: Record<string, unknown>): string | undefined {
  // OpenClaw 2026.6.5 native shape: payloads[0].text
  if (Array.isArray(obj.payloads) && obj.payloads.length > 0) {
    const head = obj.payloads[0];
    if (isObject(head) && typeof head.text === "string") return head.text;
  }
  return (
    pickString(obj, "message") ??
    pickString(obj, "reply") ??
    pickString(obj, "text") ??
    pickString(obj, "content") ??
    pickString(obj, "output")
  );
}

function extractSessionId(obj: Record<string, unknown>): string | undefined {
  // OpenClaw 2026.6.5 native shape: meta.agentMeta.sessionId
  if (isObject(obj.meta) && isObject(obj.meta.agentMeta)) {
    const sid = obj.meta.agentMeta.sessionId;
    if (typeof sid === "string") return sid;
  }
  if (typeof obj.session_id === "string") return obj.session_id;
  if (typeof obj.sessionId === "string") return obj.sessionId;
  if (isObject(obj.session) && typeof obj.session.id === "string") {
    return obj.session.id;
  }
  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

async function upsertOpenClawMcpServer(
  command: string,
  name: string,
  serverConfig: Record<string, unknown>,
): Promise<void> {
  const result = await runCliProcess({
    command,
    args: ["mcp", "set", name, JSON.stringify(serverConfig)],
    cwd: tmpdir(),
    timeoutMs: 10_000,
    graceMs: 0,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `openclaw mcp set ${name} failed (exit ${result.exitCode}): ${
        result.stderr?.slice(-512) ?? "<no stderr>"
      }`,
    );
  }
}
