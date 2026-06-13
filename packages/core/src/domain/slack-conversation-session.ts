/**
 * Mapping from a Slack conversation (workspace, channel, thread_bucket)
 * to the last beevibe sessionId spawned for it. Used by the Composio
 * Slack inbound handler to pass `chat_continuation` reason on resume.
 *
 * Composite key keeps DM, thread, and new-mention conversations isolated.
 */
export interface SlackConversationSession {
  workspace_id: string;
  channel: string;
  /** 'dm' | thread_ts | message_ts — see migration comment for derivation. */
  thread_bucket: string;
  prior_session_id: string;
  last_used_at: Date;
  created_at: Date;
}
