import type { SlackPersonLink } from "../../domain/slack-person-link.js";
import type {
  NewSlackPersonLink,
  SlackPersonLinkRepository,
} from "../../ports/slack-person-link-repo.js";
import type { Pool } from "./client.js";
import type { SlackPersonLinkRow } from "./row-types.js";

export class PostgresSlackPersonLinkRepository
  implements SlackPersonLinkRepository
{
  constructor(private pool: Pool) {}

  async find(
    workspaceId: string,
    slackUserId: string,
  ): Promise<SlackPersonLink | undefined> {
    const { rows } = await this.pool.query<SlackPersonLinkRow>(
      `SELECT * FROM slack_person_link
        WHERE workspace_id = $1 AND slack_user_id = $2
        LIMIT 1`,
      [workspaceId, slackUserId],
    );
    return rows[0] ? rowToLink(rows[0]) : undefined;
  }

  async upsert(input: NewSlackPersonLink): Promise<SlackPersonLink> {
    const { rows } = await this.pool.query<SlackPersonLinkRow>(
      `INSERT INTO slack_person_link (workspace_id, slack_user_id, person_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, slack_user_id) DO UPDATE
         SET person_id = EXCLUDED.person_id
       RETURNING *`,
      [input.workspace_id, input.slack_user_id, input.person_id],
    );
    return rowToLink(rows[0]!);
  }
}

function rowToLink(row: SlackPersonLinkRow): SlackPersonLink {
  return {
    workspace_id: row.workspace_id,
    slack_user_id: row.slack_user_id,
    person_id: row.person_id,
    created_at: row.created_at,
  };
}
