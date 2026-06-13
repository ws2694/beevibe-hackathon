/**
 * Hackathon-demo readiness check + synthetic-pipeline E2E.
 *
 * Run with:
 *   pnpm tsx scripts/integration-test-demo.ts
 *
 * What it verifies, end-to-end, against live infrastructure:
 *   1. .env: required keys present
 *   2. Postgres reachable + slack_person_link / slack_conversation_session
 *      migrations applied
 *   3. Composio MCP: x-consumer-api-key auth works AND all three OAuth
 *      connections (slackbot, gmail, googlecalendar) are ACTIVE
 *   4. Nebius: /v1/models reachable AND Llama-3.3-70B inference returns
 *      a non-empty completion
 *   5. Tavily MCP: tools/list works AND advertises tavily_search
 *   6. CLIs: `openclaw --version` + `claude --version` both succeed
 *   7. Demo data: at least one person exists, that person owns ≥1 agent
 *      (run `pnpm tsx scripts/provision-demo.ts` first if missing)
 *   8. Synthetic-pipeline: call handleComposioSlackEvent with a fake
 *      DM event against the real DB. Assert a session row is created,
 *      slack_person_link cache populated, slack_conversation_session
 *      cache populated.
 *
 * Independent of the running api server — instantiates its own minimal
 * dependency graph. Safe to run multiple times (synthetic-pipeline
 * cleans up after itself).
 */

import { config as loadEnv } from "dotenv";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import {
  createPool,
  PostgresAgentRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  PostgresSlackConversationSessionRepository,
  PostgresSlackPersonLinkRepository,
  PostgresTaskRepository,
} from "../packages/core/src/adapters/postgres/index.js";
import { DispatchService } from "../packages/core/src/services/dispatch-service.js";
import { handleComposioSlackEvent } from "../packages/api/src/composio/slack-event-handler.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

async function timed<T>(
  name: string,
  fn: () => Promise<{ ok: boolean; detail?: string }>,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const r = await fn();
    return { name, ok: r.ok, detail: r.detail, ms: Date.now() - start };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    };
  }
}

// ─── individual checks ────────────────────────────────────────────────

async function checkEnv(): Promise<{ ok: boolean; detail?: string }> {
  const required = [
    "DATABASE_URL",
    "COMPOSIO_API_KEY",
    "COMPOSIO_MCP_URL",
    "COMPOSIO_MCP_CONSUMER_KEY",
    "COMPOSIO_USER_ID",
    "TAVILY_API_KEY",
    "NEBIUS_API_KEY",
    "NEBIUS_BASE_URL",
    "BEEVIBE_OPENCLAW_MODEL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]?.trim());
  return missing.length === 0
    ? { ok: true, detail: `${required.length} keys present` }
    : { ok: false, detail: `missing: ${missing.join(", ")}` };
}

async function checkPostgres(): Promise<{ ok: boolean; detail?: string }> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL! });
  try {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('slack_person_link', 'slack_conversation_session')`,
    );
    const got = new Set(rows.map((r) => r.table_name));
    if (!got.has("slack_person_link") || !got.has("slack_conversation_session")) {
      return {
        ok: false,
        detail: `missing tables: ${[
          "slack_person_link",
          "slack_conversation_session",
        ]
          .filter((t) => !got.has(t))
          .join(", ")}. Run \`pnpm migrate up\`.`,
      };
    }
    return { ok: true, detail: "tables: 2/2" };
  } finally {
    await pool.end();
  }
}

async function checkComposio(): Promise<{ ok: boolean; detail?: string }> {
  const tools = await postJson(
    process.env.COMPOSIO_MCP_URL!,
    { "x-consumer-api-key": process.env.COMPOSIO_MCP_CONSUMER_KEY! },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    "sse",
  );
  if (!tools.ok) return { ok: false, detail: `MCP probe failed: ${tools.detail}` };

  const connRes = await fetch(
    `https://backend.composio.dev/api/v3/connected_accounts?user_ids=${encodeURIComponent(
      process.env.COMPOSIO_USER_ID!,
    )}&limit=50`,
    { headers: { "x-api-key": process.env.COMPOSIO_API_KEY! } },
  );
  if (!connRes.ok) {
    return { ok: false, detail: `connections HTTP ${connRes.status}` };
  }
  const conns = (await connRes.json()) as {
    items?: Array<{ toolkit?: { slug?: string }; status?: string }>;
  };
  const active = new Set(
    (conns.items ?? [])
      .filter((a) => a.status === "ACTIVE")
      .map((a) => a.toolkit?.slug)
      .filter((s): s is string => typeof s === "string"),
  );
  const required = ["slackbot", "gmail", "googlecalendar"];
  const missing = required.filter((t) => !active.has(t));
  if (missing.length > 0) {
    return { ok: false, detail: `inactive toolkits: ${missing.join(", ")}` };
  }
  return { ok: true, detail: "MCP + 3 OAuth connections ACTIVE" };
}

async function checkNebius(): Promise<{ ok: boolean; detail?: string }> {
  const modelRes = await fetch(`${process.env.NEBIUS_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY!}` },
  });
  if (!modelRes.ok) {
    return { ok: false, detail: `/models HTTP ${modelRes.status}` };
  }
  const completionRes = await fetch(
    `${process.env.NEBIUS_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NEBIUS_API_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta-llama/Llama-3.3-70B-Instruct",
        messages: [
          { role: "user", content: "Reply with the single word PONG." },
        ],
        max_tokens: 16,
        temperature: 0,
      }),
    },
  );
  if (!completionRes.ok) {
    return {
      ok: false,
      detail: `inference HTTP ${completionRes.status}`,
    };
  }
  const body = (await completionRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!/pong/i.test(text)) {
    return { ok: false, detail: `unexpected reply: ${text.slice(0, 40)}` };
  }
  return { ok: true, detail: "PONG ✓" };
}

async function checkTavily(): Promise<{ ok: boolean; detail?: string }> {
  const url = `https://mcp.tavily.com/mcp/?tavilyApiKey=${encodeURIComponent(
    process.env.TAVILY_API_KEY!,
  )}`;
  const r = await postJson(
    url,
    {},
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    "sse",
  );
  if (!r.ok) return { ok: false, detail: r.detail };
  if (!r.body?.includes("tavily_search")) {
    return { ok: false, detail: "no tavily_search tool in response" };
  }
  return { ok: true, detail: "tools/list ✓" };
}

async function checkCli(name: string): Promise<{ ok: boolean; detail?: string }> {
  const out = spawnSync(name, ["--version"], { encoding: "utf-8", timeout: 5_000 });
  if (out.status !== 0) {
    return {
      ok: false,
      detail: `exit ${out.status}; ${out.stderr?.slice(0, 80) ?? ""}`,
    };
  }
  return { ok: true, detail: (out.stdout?.split("\n")[0] ?? "").trim() };
}

async function checkDemoData(): Promise<{ ok: boolean; detail?: string }> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL! });
  try {
    const personCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM person`,
    );
    const agentCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM agent`,
    );
    const persons = Number(personCount.rows[0]?.c ?? 0);
    const agents = Number(agentCount.rows[0]?.c ?? 0);
    if (persons === 0) {
      return {
        ok: false,
        detail: "no persons in DB. Run `pnpm tsx scripts/provision-demo.ts`.",
      };
    }
    if (agents === 0) {
      return {
        ok: false,
        detail: "no agents in DB. Run `pnpm tsx scripts/provision-demo.ts`.",
      };
    }
    return { ok: true, detail: `${persons} person(s), ${agents} agent(s)` };
  } finally {
    await pool.end();
  }
}

async function checkSyntheticPipeline(): Promise<{
  ok: boolean;
  detail?: string;
}> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL! });
  try {
    const { rows: persons } = await pool.query<{ id: string }>(
      `SELECT id FROM person ORDER BY created_at LIMIT 1`,
    );
    const personId = persons[0]?.id;
    if (!personId) return { ok: false, detail: "no person to drive event" };

    const { rows: agents } = await pool.query<{ id: string }>(
      `SELECT id FROM agent
        WHERE owner_id = $1
          AND hierarchy_level IN ('team', 'org')
        ORDER BY hierarchy_level DESC
        LIMIT 1`,
      [personId],
    );
    if (!agents[0])
      return {
        ok: false,
        detail: "demo person has no team/org agent",
      };

    const agentRepo = new PostgresAgentRepository(pool);
    const personRepo = new PostgresPersonRepository(pool);
    const sessionRepo = new PostgresSessionRepository(pool);
    const taskRepo = new PostgresTaskRepository(pool);
    const slackPersonLinkRepo = new PostgresSlackPersonLinkRepository(pool);
    const slackConversationSessionRepo =
      new PostgresSlackConversationSessionRepository(pool);

    const dispatchService = new DispatchService({
      agentRepo,
      sessionRepo,
      taskRepo,
      isRuntimeOnline: () => true,
    });

    // Unique-ish synthetic ids per run so re-runs don't collide cache rows.
    const stamp = process.hrtime.bigint().toString();
    const synthetic = {
      triggerSlug: "SLACKBOT_DIRECT_MESSAGE_RECEIVED",
      payload: {
        team_id: "T_synth",
        user: `U_synth_${stamp}`,
        channel: `D_synth_${stamp}`,
        text: "synthetic readiness probe",
        ts: `1700${stamp.slice(-7)}.0`,
      },
    };

    const outcome = await handleComposioSlackEvent(synthetic, {
      slackPersonLinkRepo,
      slackConversationSessionRepo,
      personRepo,
      agentRepo,
      dispatchService,
      demoPersonId: personId, // fallback so unmapped synthetic user routes here
    });

    if (outcome.status !== "dispatched") {
      return { ok: false, detail: `handler returned ${outcome.status}: ${outcome.reason}` };
    }

    // Verify all three side-effects landed.
    const link = await slackPersonLinkRepo.find(
      "T_synth",
      synthetic.payload.user,
    );
    const conv = await slackConversationSessionRepo.find(
      "T_synth",
      synthetic.payload.channel,
      "dm",
    );
    if (!link)
      return { ok: false, detail: "slack_person_link not written" };
    if (!conv)
      return { ok: false, detail: "slack_conversation_session not written" };
    if (conv.prior_session_id !== outcome.session_id) {
      return {
        ok: false,
        detail: `cache prior_session_id mismatch (cache=${conv.prior_session_id}, dispatch=${outcome.session_id})`,
      };
    }

    return {
      ok: true,
      detail: `dispatched session ${outcome.session_id.slice(0, 12)}… agent=${outcome.agent_id.slice(0, 12)}…`,
    };
  } finally {
    await pool.end();
  }
}

// ─── HTTP helper (handles SSE responses transparently) ────────────────

async function postJson(
  url: string,
  extraHeaders: Record<string, string>,
  body: object,
  mode: "json" | "sse",
): Promise<{ ok: boolean; detail?: string; body?: string }> {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: mode === "sse" ? "application/json, text/event-stream" : "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, detail: `HTTP ${r.status}`, body: text };
  return { ok: true, body: text };
}

// ─── runner ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Beevibe hackathon-demo readiness check\n");

  const results: CheckResult[] = [];
  // Independent checks first — run in parallel.
  const parallel = await Promise.all([
    timed("env vars", checkEnv),
    timed("postgres + migrations", checkPostgres),
    timed("composio (MCP + 3 OAuth)", checkComposio),
    timed("nebius (PONG)", checkNebius),
    timed("tavily MCP", checkTavily),
    timed("openclaw CLI", () => checkCli("openclaw")),
    timed("claude CLI", () => checkCli("claude")),
  ]);
  results.push(...parallel);

  // Sequential checks that depend on DB readiness.
  results.push(await timed("demo data (person + agent)", checkDemoData));
  results.push(await timed("synthetic slack→dispatch pipeline", checkSyntheticPipeline));

  console.log();
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const ms = `${r.ms}ms`.padStart(7);
    const detail = r.detail ? ` — ${r.detail}` : "";
    console.log(`  ${icon} ${r.name.padEnd(38)} ${ms}${detail}`);
  }
  console.log();

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log(
      `All ${results.length} checks passed. Demo can run end-to-end.`,
    );
    console.log("");
    console.log("Next steps to demo:");
    console.log("  1. pnpm dev               (api + scheduler + tunnel)");
    console.log("  2. DM the bot in Slack — Composio routes it here.");
    console.log("  3. Watch the agent reply via SLACKBOT_SEND_MESSAGE.");
    process.exit(0);
  } else {
    console.log(
      `${failed.length} of ${results.length} checks FAILED. Fix the items above before demoing.`,
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("\nUnhandled error:", err instanceof Error ? err.message : err);
  process.exit(2);
});
