import type { SlackConversationSession } from "../domain/slack-conversation-session.js";

export type NewSlackConversationSession = Omit<
  SlackConversationSession,
  "last_used_at" | "created_at"
>;

export interface SlackConversationSessionRepository {
  /** Look up the cached prior_session_id for a Slack conversation. */
  find(
    workspaceId: string,
    channel: string,
    threadBucket: string,
  ): Promise<SlackConversationSession | undefined>;

  /**
   * Upsert the cache. New session for the same conversation → row
   * updates to point at the latest session (which is what the next
   * turn should resume from). Bumps last_used_at to NOW().
   */
  upsert(input: NewSlackConversationSession): Promise<SlackConversationSession>;
}
