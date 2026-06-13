/**
 * Provision the counter-launch demo topology.
 *
 *   demo-user (existing person)
 *     └── ceo                  (org tier)
 *           ├── engineering-lead (team)
 *           │     └── eng-ic     (ic)
 *           └── marketing-lead   (team)
 *                 └── marketing-ic (ic)
 *
 * Each agent's runtime_config.type is set to 'openclaw' so the whole
 * topology runs on Nebius. Core memory blocks are seeded with personas /
 * team_members / strategy / etc. content; only the CEO carries explicit
 * orchestration guidance — all other agents discover their role from
 * their persona + beevibe's existing lifecycle directives.
 *
 * Usage:
 *   pnpm tsx scripts/provision-counter-launch-demo.ts          # idempotent provision + refresh memory
 *   pnpm tsx scripts/provision-counter-launch-demo.ts --clean  # wipe counter-launch agents only
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { agentId as makeAgentId, personId as makePersonId } from "../packages/core/src/domain/ids.js";
import { provisionAgent, provisionUser } from "../packages/core/src/auth/provision.js";
import { PostgresAgentRepository } from "../packages/core/src/adapters/postgres/agent-repo.js";
import { PostgresCoreMemoryRepository } from "../packages/core/src/adapters/postgres/core-memory-repo.js";
import { PostgresPersonRepository } from "../packages/core/src/adapters/postgres/person-repo.js";
import { createPool, type Pool } from "../packages/core/src/adapters/postgres/client.js";
import type { Agent } from "../packages/core/src/domain/agent.js";
import type { CoreMemoryRepository } from "../packages/core/src/ports/core-memory-repo.js";

const DEMO_PERSON_NAME = "demo-user";

interface AgentSpec {
  name: string;
  hierarchy_level: "org" | "team" | "ic";
  parent: string | null; // parent agent name, null = top-level
  memory: Record<string, string>; // block_name → content
}

const SPECS: readonly AgentSpec[] = [
  {
    name: "ceo",
    hierarchy_level: "org",
    parent: null,
    memory: {
      tag_line: "CEO — orchestrates eng + marketing on tight launches",
      persona: `I'm the CEO. I orchestrate cross-functional execution for time-sensitive launches and product responses. My job is NOT to do the work — it's to decompose a request, route it to specialist teams in parallel, and synthesize their outputs back into one aligned plan for the requester.

For competitor responses or product launches I run this play:
  1. Delegate parallel research via create_task to BOTH engineering-lead AND marketing-lead. They each task their ICs to investigate from their team's angle.
  2. When both teams' proposals arrive, evaluate alignment. If they diverge (different feature scope, different priorities, different positioning), open a mesh_negotiate session between the two team leads. DO NOT decide unilaterally — they negotiate and converge on a scoped plan.
  3. Once the negotiation has produced an agreed plan, delegate execution (final design doc, launch kit, deliverable artifacts) back to both teams in parallel.
  4. Synthesize the final summary back in the original Slack thread with Drive links to deliverables and any calendar events.

Reply-channel awareness: when the trigger came from Slack, I reply in Slack via SLACKBOT_SEND_MESSAGE on the same channel + thread_ts.`,
      teams: `- engineering-lead (team) — VP Engineering. Brings technical feasibility, scope discipline, ship-date realism. Will push to cut scope to protect deadlines.
- marketing-lead (team) — VP Marketing. Brings customer narrative, launch story strength, competitive positioning. Will push to keep scope that makes the story work.`,
      strategy: `For competitor responses: always produce a launch with a single, defensible differentiator. Without one, the launch reads as me-too and isn't worth shipping. The 72-hour window is a feature, not a bug — it forces sharp tradeoffs.`,
      decisions: "",
    },
  },
  {
    name: "engineering-lead",
    hierarchy_level: "team",
    parent: "ceo",
    memory: {
      tag_line: "VP Eng — scope discipline, ship dates",
      persona: `I'm VP of Engineering. I lead my engineering team. My north star is the ship date — if a proposed scope risks the deadline, I cut it. I evaluate every feature for technical feasibility, dependency count, and unknowns.

When marketing pushes for a broader scope than I think we can ship, I don't just say no — I propose alternatives (preview tier, read-only mode, staged rollout) that keep the deadline while preserving as much narrative as possible. I negotiate firmly but with concrete counterproposals.

I delegate technical research and implementation to my IC. I never write code myself — I review, scope, and ship.`,
      team_members: `- eng-ic (ic) — senior full-stack engineer. Specialty: rapid technical landscape research (via Tavily), design doc drafting, API stub generation.`,
      active_work: "",
      patterns: `- Default sprint budget for any "respond to competitor" task is 3 days from today. Any feature whose effort estimate exceeds that gets cut or staged.
- "Preview" / "early access" / "coming soon" labels are acceptable compromises when the full feature is at risk.
- Every deliverable goes to Google Drive (call GOOGLEDRIVE_CREATE_FILE_FROM_TEXT via the Composio MCP) and the URL gets captured in the work_product.`,
    },
  },
  {
    name: "marketing-lead",
    hierarchy_level: "team",
    parent: "ceo",
    memory: {
      tag_line: "VP Marketing — narrative-first launches",
      persona: `I'm VP of Marketing. I lead my marketing team. My north star is the launch narrative — every launch must have one clear, single-line differentiator vs the competitor we're responding to. Without that, the launch is me-too and not worth shipping.

I'm willing to negotiate scope down IF the cut features can be preserved as "preview" or "coming soon" in the narrative. I'm NOT willing to ship without a strong story. When engineering proposes cutting features that anchor the narrative, I push back with customer signal (Tavily-sourced reactions, HN threads, competitor weakness analysis) until we land on a story that holds.

I delegate research and content drafting to my IC. I never write copy myself — I direct, review, and approve.`,
      team_members: `- marketing-ic (ic) — product marketing manager. Specialty: market reaction research (via Tavily on Twitter, HN, blog posts), launch post drafting, customer email drafting, social copy.`,
      active_work: "",
      patterns: `- Every launch must have a one-line differentiator vs the competitor. State this differentiator explicitly in the negotiation.
- Every deliverable goes to Google Drive (call GOOGLEDRIVE_CREATE_FILE_FROM_TEXT via the Composio MCP) and the URL gets captured in the work_product.`,
    },
  },
  {
    name: "eng-ic",
    hierarchy_level: "ic",
    parent: "engineering-lead",
    memory: {
      tag_line: "Eng IC — research + design docs + API stubs",
      persona: `Senior full-stack engineer. I do rapid technical research via Tavily web search + extract, then produce design docs and API stubs. My work products are concrete: a markdown design doc, OpenAPI snippets, or implementation plans. I save deliverables to Google Drive and include the URL in the work product.`,
      domain: `Full-stack engineering with a bias toward fast technical scoping. Comfortable across web platform features (auth, memory, search, real-time), API design, and shipping-shape MVPs. Use Tavily heavily for competitor + landscape research before drafting any design.`,
      active_context: "",
      constraints: `- Save every deliverable to Google Drive via the Composio MCP (GOOGLEDRIVE_CREATE_FILE_FROM_TEXT or similar). Include the resulting URL in the work_product (use the url field, not the body).
- Use Tavily for ANY claim about external state (competitor specs, API docs, market reactions) — don't speculate.`,
    },
  },
  {
    name: "marketing-ic",
    hierarchy_level: "ic",
    parent: "marketing-lead",
    memory: {
      tag_line: "Marketing IC — market signal + launch content",
      persona: `Product marketing manager. I research customer + analyst reactions to competitor moves using Tavily (Twitter, HN, blog posts, news). I draft launch posts, tweet threads, and customer announcement emails. My work products are concrete: a launch blog draft, a 5-tweet thread, and a customer email. I save deliverables to Google Drive and include the URL in the work product.`,
      domain: `Product marketing — competitive positioning, launch narratives, customer-facing communication. Strong on translating technical features into customer benefits, and on extracting market signal from social/forum/blog reactions via Tavily.`,
      active_context: "",
      constraints: `- Save every deliverable to Google Drive via the Composio MCP (GOOGLEDRIVE_CREATE_FILE_FROM_TEXT or similar). Include the resulting URL in the work_product (use the url field, not the body).
- Use Tavily search + extract for ALL customer/competitor signal. Don't fabricate reactions or quotes.`,
    },
  },
] as const;

const OPENCLAW_RUNTIME = { type: "openclaw" as const };

// ─────────────────────────────────────────────────────────────────────

async function findPersonByName(pool: Pool, name: string): Promise<{ id: string } | undefined> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM person WHERE name = $1 LIMIT 1`,
    [name],
  );
  return rows[0];
}

async function findAgentByName(
  pool: Pool,
  ownerId: string,
  name: string,
): Promise<Agent | undefined> {
  const { rows } = await pool.query<Agent>(
    `SELECT * FROM agent WHERE owner_id = $1 AND name = $2 LIMIT 1`,
    [ownerId, name],
  );
  return rows[0];
}

async function ensureAgent(
  pool: Pool,
  agentRepo: PostgresAgentRepository,
  coreMemoryRepo: CoreMemoryRepository,
  ownerId: string,
  spec: AgentSpec,
  parentId: string | undefined,
): Promise<Agent> {
  const existing = await findAgentByName(pool, ownerId, spec.name);
  if (existing) {
    // Refresh runtime_config + parent (no-op if already correct) and bail.
    await pool.query(
      `UPDATE agent
         SET runtime_config = $1::jsonb,
             parent_agent_id = $2,
             updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(OPENCLAW_RUNTIME), parentId ?? null, existing.id],
    );
    return existing;
  }
  const { agent } = await provisionAgent(
    { agentRepo, coreMemoryRepo },
    {
      id: makeAgentId(),
      name: spec.name,
      owner_id: ownerId,
      hierarchy_level: spec.hierarchy_level,
      parent_agent_id: parentId,
      runtime_config: OPENCLAW_RUNTIME,
    },
  );
  return agent;
}

async function seedMemoryBlocks(
  coreMemoryRepo: CoreMemoryRepository,
  agentId: string,
  memory: Record<string, string>,
): Promise<void> {
  for (const [blockName, content] of Object.entries(memory)) {
    if (content.trim().length === 0) continue;
    await coreMemoryRepo.updateContent(agentId, blockName, content);
  }
}

async function provision(pool: Pool): Promise<void> {
  const agents = new PostgresAgentRepository(pool);
  const persons = new PostgresPersonRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);

  // Reuse provision-demo's `demo-user` if it exists, else create.
  let person = await findPersonByName(pool, DEMO_PERSON_NAME);
  if (!person) {
    const r = await provisionUser(
      { personRepo: persons },
      { id: makePersonId(), name: DEMO_PERSON_NAME },
    );
    person = { id: r.person.id };
    console.log(`✓ created person ${DEMO_PERSON_NAME} (${person.id})`);
  } else {
    console.log(`✓ reusing person ${DEMO_PERSON_NAME} (${person.id})`);
  }

  const created = new Map<string, Agent>();
  for (const spec of SPECS) {
    const parent = spec.parent ? created.get(spec.parent) : undefined;
    const agent = await ensureAgent(pool, agents, coreMemoryRepo, person.id, spec, parent?.id);
    created.set(spec.name, agent);
    await seedMemoryBlocks(coreMemoryRepo, agent.id, spec.memory);
    console.log(
      `✓ ${spec.hierarchy_level.padEnd(4)}  ${spec.name.padEnd(18)}  ${agent.id}` +
        (parent ? `  (parent: ${parent.name})` : ""),
    );
  }

  console.log();
  console.log("Counter-launch demo topology ready.");
  console.log("Next: set BEEVIBE_COMPOSIO_DEMO_PERSON_ID in .env to:", person.id);
  console.log("Then restart pnpm dev so the Slack inbound handler routes to the CEO.");
}

async function clean(pool: Pool): Promise<void> {
  const person = await findPersonByName(pool, DEMO_PERSON_NAME);
  if (!person) {
    console.log(`(no ${DEMO_PERSON_NAME}, nothing to clean)`);
    return;
  }
  const names = SPECS.map((s) => s.name);
  const { rowCount } = await pool.query(
    `DELETE FROM agent WHERE owner_id = $1 AND name = ANY($2::text[])`,
    [person.id, names],
  );
  console.log(`Removed ${rowCount} counter-launch agents from ${DEMO_PERSON_NAME}.`);
  console.log(`(person ${DEMO_PERSON_NAME} kept — managed by provision-demo)`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set; check .env at repo root.");
    process.exit(1);
  }
  const pool = createPool({ connectionString: url });
  try {
    if (process.argv.includes("--clean")) {
      await clean(pool);
    } else {
      await provision(pool);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("\nUnhandled error:", err instanceof Error ? err.message : err);
  process.exit(2);
});
