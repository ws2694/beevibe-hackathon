import type { SlackConversationSession } from "../../domain/slack-conversation-session.js";
import type {
  NewSlackConversationSession,
  SlackConversationSessionRepository,
} from "../../ports/slack-conversation-session-repo.js";
import type { Pool } from "./client.js";
import type { SlackConversationSessionRow } from "./row-types.js";

export class PostgresSlackConversationSessionRepository
  implements SlackConversationSessionRepository
{
  constructor(private pool: Pool) {}

  async find(
    workspaceId: string,
    channel: string,
    threadBucket: string,
  ): Promise<SlackConversationSession | undefined> {
    const { rows } = await this.pool.query<SlackConversationSessionRow>(
      `SELECT * FROM slack_conversation_session
        WHERE workspace_id = $1 AND channel = $2 AND thread_bucket = $3
        LIMIT 1`,
      [workspaceId, channel, threadBucket],
    );
    return rows[0] ? rowToConv(rows[0]) : undefined;
  }

  async upsert(
    input: NewSlackConversationSession,
  ): Promise<SlackConversationSession> {
    const { rows } = await this.pool.query<SlackConversationSessionRow>(
      `INSERT INTO slack_conversation_session
         (workspace_id, channel, thread_bucket, prior_session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, channel, thread_bucket) DO UPDATE
         SET prior_session_id = EXCLUDED.prior_session_id,
             last_used_at = NOW()
       RETURNING *`,
      [
        input.workspace_id,
        input.channel,
        input.thread_bucket,
        input.prior_session_id,
      ],
    );
    return rowToConv(rows[0]!);
  }
}

function rowToConv(
  row: SlackConversationSessionRow,
): SlackConversationSession {
  return {
    workspace_id: row.workspace_id,
    channel: row.channel,
    thread_bucket: row.thread_bucket,
    prior_session_id: row.prior_session_id,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}
