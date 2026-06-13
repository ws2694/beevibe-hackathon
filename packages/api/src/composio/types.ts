/**
 * Defensive extracted view of a Composio Slack trigger event.
 *
 * The Composio SDK normalizes payloads across V1/V2/V3 schema versions,
 * and Slack's own payload differs between `message.im` and `app_mention`.
 * Rather than trust one field path, the extractor (in slack-event-handler)
 * probes several likely locations and falls back gracefully. This type
 * represents what we've *successfully* pulled out of the wire event.
 */
export interface ExtractedSlackEvent {
  /** Slack team_id (T_xxx). Used as workspace partition for the link cache. */
  workspace_id: string;
  /** Slack user_id of the message sender (U_xxx). */
  slack_user_id: string;
  /** Sender's email if Composio enriched the payload with it. */
  slack_user_email?: string;
  /** Slack channel id where the message arrived (D_xxx for DM, C_xxx for channel). */
  channel: string;
  /** Convenience: was this DM'd to the bot vs. mentioned in a channel? */
  channel_kind: "dm" | "channel";
  /** Message text body. */
  text: string;
  /** Message timestamp (used to create or anchor a thread). */
  message_ts: string;
  /** Existing thread_ts if the message was already inside a thread. */
  thread_ts?: string;
  /** Our bot's slack user id, so the agent can strip self-mentions from text. */
  bot_user_id?: string;
  /** Resolved sender display name when available. */
  sender_name?: string;
  /** Resolved channel name when available (e.g. "#launches"). */
  channel_name?: string;
}

export type HandlerOutcome =
  | { status: "dispatched"; agent_id: string; session_id: string; person_id: string }
  | { status: "ignored"; reason: string };
