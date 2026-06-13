import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { personId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSlackPersonLinkRepository } from "./slack-person-link-repo.js";

describe("PostgresSlackPersonLinkRepository", () => {
  let pool: Pool;
  let repo: PostgresSlackPersonLinkRepository;
  let personRepo: PostgresPersonRepository;

  beforeAll(() => {
    pool = createTestPool();
    repo = new PostgresSlackPersonLinkRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedPerson(email?: string) {
    return personRepo.create({
      id: personId(),
      name: "Alice",
      email: email ?? `alice-${personId()}@example.com`,
    });
  }

  it("find returns undefined when missing", async () => {
    expect(await repo.find("T_xxx", "U_xxx")).toBeUndefined();
  });

  it("upsert + find round-trips", async () => {
    const p = await seedPerson();
    const created = await repo.upsert({
      workspace_id: "T_TEAM",
      slack_user_id: "U_ALICE",
      person_id: p.id,
    });
    expect(created.workspace_id).toBe("T_TEAM");
    expect(created.slack_user_id).toBe("U_ALICE");
    expect(created.person_id).toBe(p.id);
    expect(created.created_at).toBeInstanceOf(Date);

    const found = await repo.find("T_TEAM", "U_ALICE");
    expect(found).toEqual(created);
  });

  it("upsert is idempotent for the same (workspace, slack_user) -> person", async () => {
    const p = await seedPerson();
    const first = await repo.upsert({
      workspace_id: "T_TEAM",
      slack_user_id: "U_ALICE",
      person_id: p.id,
    });
    const second = await repo.upsert({
      workspace_id: "T_TEAM",
      slack_user_id: "U_ALICE",
      person_id: p.id,
    });
    expect(second.created_at).toEqual(first.created_at);
    expect(second.person_id).toBe(p.id);
  });

  it("upsert updates person_id when the same Slack identity is re-linked", async () => {
    const a = await seedPerson("a@example.com");
    const b = await seedPerson("b@example.com");
    await repo.upsert({
      workspace_id: "T_TEAM",
      slack_user_id: "U_ALICE",
      person_id: a.id,
    });
    const relinked = await repo.upsert({
      workspace_id: "T_TEAM",
      slack_user_id: "U_ALICE",
      person_id: b.id,
    });
    expect(relinked.person_id).toBe(b.id);

    const found = await repo.find("T_TEAM", "U_ALICE");
    expect(found?.person_id).toBe(b.id);
  });

  it("isolates rows by workspace_id (same slack_user_id, different team)", async () => {
    const p = await seedPerson();
    await repo.upsert({
      workspace_id: "T_TEAM_A",
      slack_user_id: "U_ALICE",
      person_id: p.id,
    });
    await repo.upsert({
      workspace_id: "T_TEAM_B",
      slack_user_id: "U_ALICE",
      person_id: p.id,
    });
    expect(await repo.find("T_TEAM_A", "U_ALICE")).toBeDefined();
    expect(await repo.find("T_TEAM_B", "U_ALICE")).toBeDefined();
  });

  it("rejects inserts referencing a missing person (FK)", async () => {
    await expect(
      repo.upsert({
        workspace_id: "T_TEAM",
        slack_user_id: "U_ALICE",
        person_id: "person_does_not_exist",
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes when the linked person is deleted", async () => {
    const p = await seedPerson();
    await repo.upsert({
      workspace_id: "T_TEAM",
      slack_user_id: "U_ALICE",
      person_id: p.id,
    });
    await pool.query(`DELETE FROM person WHERE id = $1`, [p.id]);
    expect(await repo.find("T_TEAM", "U_ALICE")).toBeUndefined();
  });
});
