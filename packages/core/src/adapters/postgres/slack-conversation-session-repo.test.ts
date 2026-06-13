import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { personId, sessionId as newSessionId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSlackConversationSessionRepository } from "./slack-conversation-session-repo.js";

describe("PostgresSlackConversationSessionRepository", () => {
  let pool: Pool;
  let repo: PostgresSlackConversationSessionRepository;
  let personRepo: PostgresPersonRepository;

  beforeAll(() => {
    pool = createTestPool();
    repo = new PostgresSlackConversationSessionRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Minimal seed: an agent + a session row to satisfy the FK. */
  async function seedSession(): Promise<string> {
    const pid = personId();
    await personRepo.create({ id: pid, name: "Alice" });
    const agentRow = await pool.query(
      `INSERT INTO agent (id, name, owner_id, hierarchy_level, runtime_config)
       VALUES ($1, 'a', $2, 'team', '{"type":"openclaw"}'::jsonb)
       RETURNING id`,
      [`agent_${pid}`, pid],
    );
    const sid = newSessionId();
    await pool.query(
      `INSERT INTO session (id, agent_id, type, intent, status)
       VALUES ($1, $2, 'chat', 'hi', 'succeeded')`,
      [sid, agentRow.rows[0].id],
    );
    return sid;
  }

  it("find returns undefined when missing", async () => {
    expect(await repo.find("T_x", "D_x", "dm")).toBeUndefined();
  });

  it("upsert + find round-trips", async () => {
    const sid = await seedSession();
    const created = await repo.upsert({
      workspace_id: "T_demo",
      channel: "D_alice",
      thread_bucket: "dm",
      prior_session_id: sid,
    });
    expect(created.prior_session_id).toBe(sid);
    expect(created.last_used_at).toBeInstanceOf(Date);

    const found = await repo.find("T_demo", "D_alice", "dm");
    expect(found?.prior_session_id).toBe(sid);
  });

  it("upsert updates prior_session_id + bumps last_used_at on conflict", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const first = await repo.upsert({
      workspace_id: "T_demo",
      channel: "D_alice",
      thread_bucket: "dm",
      prior_session_id: a,
    });
    // Sleep enough for TIMESTAMPTZ resolution to advance.
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.upsert({
      workspace_id: "T_demo",
      channel: "D_alice",
      thread_bucket: "dm",
      prior_session_id: b,
    });
    expect(second.prior_session_id).toBe(b);
    expect(second.last_used_at.getTime()).toBeGreaterThanOrEqual(
      first.last_used_at.getTime(),
    );
  });

  it("isolates rows by thread_bucket within the same channel", async () => {
    const a = await seedSession();
    const b = await seedSession();
    await repo.upsert({
      workspace_id: "T_demo",
      channel: "C_launches",
      thread_bucket: "1700000000.111",
      prior_session_id: a,
    });
    await repo.upsert({
      workspace_id: "T_demo",
      channel: "C_launches",
      thread_bucket: "1700000000.222",
      prior_session_id: b,
    });
    const x = await repo.find("T_demo", "C_launches", "1700000000.111");
    const y = await repo.find("T_demo", "C_launches", "1700000000.222");
    expect(x?.prior_session_id).toBe(a);
    expect(y?.prior_session_id).toBe(b);
  });

  it("rejects upserts pointing at a missing session (FK)", async () => {
    await expect(
      repo.upsert({
        workspace_id: "T_demo",
        channel: "D_alice",
        thread_bucket: "dm",
        prior_session_id: "session_does_not_exist",
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes when the referenced session is deleted", async () => {
    const sid = await seedSession();
    await repo.upsert({
      workspace_id: "T_demo",
      channel: "D_alice",
      thread_bucket: "dm",
      prior_session_id: sid,
    });
    await pool.query(`DELETE FROM session WHERE id = $1`, [sid]);
    expect(await repo.find("T_demo", "D_alice", "dm")).toBeUndefined();
  });
});
