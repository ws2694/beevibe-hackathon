/**
 * Composio Slack inbound -> beevibe agent dispatch.
 *
 * Composio's SDK subscribe stream delivers SLACKBOT_DIRECT_MESSAGE_RECEIVED
 * and SLACKBOT_CHANNEL_MESSAGE_RECEIVED events to this handler. We:
 *
 *   1. Defensively extract slack fields (channel, user, text, ts) from
 *      whichever payload version Composio delivered.
 *   2. Filter out noise: own bot messages, channel messages that don't
 *      @-mention us, malformed payloads.
 *   3. Resolve which beevibe person this Slack identity belongs to —
 *      cache hit (M0 slack_person_link) → email bridge → demo fallback.
 *   4. Pick that person's top-level agent (auth/find-user-agent.ts).
 *   5. Build the FRESH intent template and fire-and-forget dispatch.
 *      The agent's reply is its own job (it calls SLACKBOT_SEND_MESSAGE
 *      via Composio MCP using the channel/thread_ts we pass in).
 *
 * Pure: every dependency is injected. The SDK subscriber wraps this in a
 * thin try/catch and feeds in events.
 */

import { findUserAgent } from "@beevibe/core/auth";
import type {
  AgentRepository,
  PersonRepository,
  SlackConversationSessionRepository,
  SlackPersonLinkRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ResumeReason } from "@beevibe/core/services/agent-session";
import type { ExtractedSlackEvent, HandlerOutcome } from "./types.js";

export interface SlackEventHandlerDeps {
  slackPersonLinkRepo: SlackPersonLinkRepository;
  slackConversationSessionRepo: SlackConversationSessionRepository;
  personRepo: PersonRepository;
  agentRepo: AgentRepository;
  dispatchService: DispatchService;
  /**
   * Our Slack bot's user id (U_xxx), used to filter our own messages out
   * (avoid feedback loops). If absent, channel events are dropped
   * entirely — DM-only mode.
   */
  botUserId?: string;
  /**
   * Additional Slack ids that should count as @-mentioning us. Slack
   * sometimes renders bot mentions with a `<@B...>` bot id (not the
   * `<@U...>` user id of botUserId) depending on how the human picked
   * the bot from autocomplete. Both forms route to the same bot; we
   * accept either. Comma-separated string from env.
   */
  extraMentionIds?: string[];
  /**
   * Fallback person id used when neither the slack_person_link cache
   * nor the email-bridge lookup resolves a person. Useful for single-
   * user hackathon demos: set to your beevibe person id and any Slack
   * sender routes to your agent. Set to `undefined` in multi-tenant
   * deployments — there, unmapped users should be rejected, not routed
   * to a random fallback.
   */
  demoPersonId?: string;
}

export interface IncomingComposioEvent {
  triggerSlug?: string;
  payload?: Record<string, unknown>;
  originalPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function handleComposioSlackEvent(
  event: IncomingComposioEvent,
  deps: SlackEventHandlerDeps,
): Promise<HandlerOutcome> {
  const extracted = extractSlackFields(event, deps.botUserId);
  if (!extracted) {
    return { status: "ignored", reason: "extract_failed" };
  }

  if (deps.botUserId && extracted.slack_user_id === deps.botUserId) {
    return { status: "ignored", reason: "own_bot_message" };
  }

  if (extracted.channel_kind === "channel") {
    if (!deps.botUserId) {
      return {
        status: "ignored",
        reason: "channel_message_dropped_no_bot_user_id_configured",
      };
    }
    const mentionIds = [deps.botUserId, ...(deps.extraMentionIds ?? [])];
    const isMentioned = mentionIds.some(
      (id) => id && extracted.text.includes(`<@${id}>`),
    );
    if (!isMentioned) {
      // No explicit @-mention. Allow if this is a reply in a thread we
      // already have a session cache for — i.e., the bot has been part
      // of this thread before. Mirrors Slack's natural UX: @-mention to
      // start, then converse in the thread without re-mentioning.
      // (Bot's own replies are filtered earlier as `own_bot_message`,
      // so we don't loop on our own thread posts.)
      if (!extracted.thread_ts) {
        return { status: "ignored", reason: "channel_message_not_mentioned" };
      }
      const engagedThread = await deps.slackConversationSessionRepo.find(
        extracted.workspace_id,
        extracted.channel,
        extracted.thread_ts,
      );
      if (!engagedThread) {
        return {
          status: "ignored",
          reason: "channel_thread_reply_bot_not_engaged",
        };
      }
      // engagedThread exists → fall through and process this turn.
    }
  }

  const personId = await resolvePerson(extracted, deps);
  if (!personId) {
    return { status: "ignored", reason: "unmapped_slack_user" };
  }

  const userAgent = await findUserAgent(deps.agentRepo, personId);
  if (!userAgent) {
    return { status: "ignored", reason: "person_has_no_top_level_agent" };
  }

  const threadBucket = deriveThreadBucket(extracted);
  const cached = await deps.slackConversationSessionRepo.find(
    extracted.workspace_id,
    extracted.channel,
    threadBucket,
  );

  const intent = cached ? buildResumedIntent(extracted) : buildFreshIntent(extracted);
  const reason: ResumeReason = cached
    ? { kind: "chat_continuation", prior_session_id: cached.prior_session_id }
    : { kind: "fresh" };

  const dispatchResult = await deps.dispatchService.dispatchTask({
    agentId: userAgent.agentId,
    intent,
    reason,
    type: "chat",
  });

  // Cache write — next inbound message in this conversation resumes from
  // the session we just spawned. FK to session(id) is satisfied because
  // dispatchService inserts the pending session row inline before returning.
  await deps.slackConversationSessionRepo.upsert({
    workspace_id: extracted.workspace_id,
    channel: extracted.channel,
    thread_bucket: threadBucket,
    prior_session_id: dispatchResult.session.id,
  });

  return {
    status: "dispatched",
    agent_id: userAgent.agentId,
    person_id: personId,
    session_id: dispatchResult.session.id,
  };
}

/**
 * Compute the cache bucket for a Slack conversation:
 *   DM:                              'dm' (one rolling session per DM channel)
 *   Channel + existing thread:       thread_ts (turn anchored to thread)
 *   Channel + top-level @-mention:   message_ts (agent's reply creates the
 *                                                thread; subsequent in-thread
 *                                                messages key on the same ts)
 *
 * Exported for unit testing.
 */
export function deriveThreadBucket(e: ExtractedSlackEvent): string {
  if (e.channel_kind === "dm") return "dm";
  return e.thread_ts ?? e.message_ts;
}

/**
 * RESUMED intent template — sent when the cache shows a prior session
 * for this conversation. Minimal: just the new message + reply context.
 * The agent already saw the FRESH briefing (system rules, tool slugs)
 * in turn 1 of the resumed session, so we don't re-burn context here.
 *
 * Exported for unit testing.
 */
export function buildResumedIntent(e: ExtractedSlackEvent): string {
  const threadBucket = e.thread_ts ?? e.message_ts;
  const senderLabel = e.sender_name
    ? `${e.sender_name} (${e.slack_user_id})`
    : e.slack_user_id;
  // The recipe must repeat in RESUMED because not every runtime gives us
  // a true CLI-side resume (OpenClaw sessions without prior cli_session_id
  // spawn fresh, losing tool-use context from turn 1). Minimal enough to
  // not balloon context but unambiguous about how to reply.
  return [
    "[Slack continuation]",
    `From: ${senderLabel}`,
    `Channel: ${e.channel}`,
    `Thread: ${threadBucket}`,
    "",
    "Message:",
    e.text,
    "",
    "★ The user only sees Slack posts — your final session text is not",
    "delivered. You MUST call SLACKBOT_SEND_MESSAGE before ending, even on",
    "delegation. Post via COMPOSIO_MULTI_EXECUTE_TOOL:",
    "  tools: [{",
    '    tool_slug: "SLACKBOT_SEND_MESSAGE",',
    "    arguments: {",
    `      channel: "${e.channel}",`,
    `      thread_ts: "${threadBucket}",`,
    '      text: "<your reply>"',
    "    }",
    "  }]",
  ].join("\n");
}

/**
 * Defensive payload extraction. Composio normalizes across V1/V2/V3
 * schemas; we probe the well-known fields under both `payload` and
 * `originalPayload` and return undefined if the minimums are missing.
 * Exported for unit testing.
 */
export function extractSlackFields(
  event: IncomingComposioEvent,
  botUserId?: string,
): ExtractedSlackEvent | undefined {
  const payload = isRecord(event.payload) ? event.payload : {};
  const original = isRecord(event.originalPayload) ? event.originalPayload : {};
  const meta = isRecord(event.metadata) ? event.metadata : {};

  const slack_user_id =
    pickStringDeep(payload, ["user", "user_id", "userId"]) ??
    pickStringDeep(original, ["user", "user_id"]);
  const channel =
    pickStringDeep(payload, ["channel", "channel_id", "channelId"]) ??
    pickStringDeep(original, ["channel", "channel_id"]);
  const text =
    pickStringDeep(payload, ["text", "message"]) ??
    pickStringDeep(original, ["text", "message"]) ??
    "";
  const message_ts =
    pickStringDeep(payload, ["ts", "timestamp", "event_ts"]) ??
    pickStringDeep(original, ["ts", "timestamp", "event_ts"]);
  const workspace_id =
    pickStringDeep(payload, ["team_id", "team", "workspace_id"]) ??
    pickStringDeep(original, ["team_id", "team"]) ??
    pickStringDeep(meta, ["team_id", "workspaceId"]);
  const thread_ts =
    pickStringDeep(payload, ["thread_ts", "threadTs"]) ??
    pickStringDeep(original, ["thread_ts"]);
  const slack_user_email =
    pickStringDeep(payload, [
      "user_email",
      "userEmail",
      "email",
      "sender_email",
    ]) ?? pickStringDeep(original, ["user_email", "email"]);
  const sender_name =
    pickStringDeep(payload, ["user_name", "username", "user_display_name"]) ??
    pickStringDeep(original, ["user_name", "username"]);
  const channel_name =
    pickStringDeep(payload, ["channel_name", "channelName"]) ??
    pickStringDeep(original, ["channel_name"]);

  if (!slack_user_id || !channel || !message_ts || !workspace_id) {
    return undefined;
  }

  // Slack DM channels start with 'D'; public/private channels with 'C' or 'G'.
  const channel_kind: "dm" | "channel" = channel.startsWith("D")
    ? "dm"
    : "channel";

  return {
    workspace_id,
    slack_user_id,
    slack_user_email,
    channel,
    channel_kind,
    text,
    message_ts,
    thread_ts,
    bot_user_id: botUserId,
    sender_name,
    channel_name,
  };
}

/**
 * Build the FRESH intent template — what the agent sees on the first
 * turn of a conversation. The RESUMED variant (M2.6) is shorter; for
 * now we always emit FRESH because M2.6 hasn't shipped yet.
 *
 * The agent is told the exact channel + thread_bucket to reply to and
 * the authoritative SLACKBOT_SEND_MESSAGE invocation shape. Known tool
 * slugs are listed so it can skip COMPOSIO_SEARCH_TOOLS for the common
 * cases.
 *
 * Exported for unit testing.
 */
export function buildFreshIntent(e: ExtractedSlackEvent): string {
  const threadBucket = e.thread_ts ?? e.message_ts;
  const senderLabel = e.sender_name
    ? `${e.sender_name} (${e.slack_user_id})`
    : e.slack_user_id;
  const channelLabel = e.channel_name
    ? `${e.channel_name} (${e.channel})`
    : e.channel;
  const botLine = e.bot_user_id
    ? `Bot user id (your own id, to strip mentions of yourself): ${e.bot_user_id}`
    : "Bot user id: (not provided)";

  return [
    "[Slack inbound]",
    `From: ${senderLabel}`,
    `Channel: ${channelLabel}`,
    `Thread: ${threadBucket}`,
    botLine,
    "",
    "Message:",
    e.text,
    "",
    "★ CRITICAL ★ The user only sees what you post to Slack — your final text",
    "in this session is NOT delivered. You MUST call SLACKBOT_SEND_MESSAGE",
    "before ending this session, EVEN IF you delegated work to subordinates,",
    "EVEN IF subordinates are still working, EVEN IF you only have a partial",
    "answer. Post at minimum a one-line 'On it — <one-line plan>' acknowledgement.",
    "If you have a final synthesis (subordinates returned, plan agreed), post",
    "the full summary with any Drive / calendar links inline.",
    "",
    "To post: call COMPOSIO_MULTI_EXECUTE_TOOL with:",
    "  tools: [{",
    '    tool_slug: "SLACKBOT_SEND_MESSAGE",',
    "    arguments: {",
    `      channel: "${e.channel}",`,
    `      thread_ts: "${threadBucket}",`,
    '      text: "<your reply text>"',
    "    }",
    "  }]",
    "",
    "Known authoritative slugs (skip COMPOSIO_SEARCH_TOOLS for these):",
    "  - SLACKBOT_SEND_MESSAGE                — post in slack channel/DM",
    "  - GMAIL_SEND_EMAIL                     — send an email",
    "  - GMAIL_CREATE_EMAIL_DRAFT             — draft an email without sending",
    "  - GOOGLECALENDAR_CREATE_EVENT          — create a calendar event",
    "  - GOOGLEDRIVE_CREATE_FILE_FROM_TEXT    — create a Drive file from raw text (returns URL)",
    "  - GOOGLEDRIVE_UPLOAD_FILE              — upload a binary file to Drive",
    "",
    "For Composio tools whose slug you don't know, first call COMPOSIO_SEARCH_TOOLS,",
    "then COMPOSIO_MULTI_EXECUTE_TOOL with the returned slug.",
    "",
    "Do NOT use COMPOSIO_REMOTE_BASH_TOOL or COMPOSIO_REMOTE_WORKBENCH —",
    "you have your own local workspace.",
  ].join("\n");
}

/**
 * Resolve a Slack identity to a beevibe person id. Three-stage lookup
 * with cache-write side effects:
 *
 *   1. cache hit  → return mapped person_id
 *   2. email bridge → if Composio enriched the payload with an email
 *      and there's a beevibe person with that email, link + return
 *   3. demo fallback → if `deps.demoPersonId` is configured, link + return
 *
 * Returns undefined when all three fail — the handler treats that as
 * "ignore this event".
 *
 * Exported for unit testing.
 */
export async function resolvePerson(
  e: ExtractedSlackEvent,
  deps: SlackEventHandlerDeps,
): Promise<string | undefined> {
  const cached = await deps.slackPersonLinkRepo.find(
    e.workspace_id,
    e.slack_user_id,
  );
  if (cached) return cached.person_id;

  if (e.slack_user_email) {
    const person = await deps.personRepo.findByEmail(e.slack_user_email);
    if (person) {
      await deps.slackPersonLinkRepo.upsert({
        workspace_id: e.workspace_id,
        slack_user_id: e.slack_user_id,
        person_id: person.id,
      });
      return person.id;
    }
  }

  if (deps.demoPersonId) {
    await deps.slackPersonLinkRepo.upsert({
      workspace_id: e.workspace_id,
      slack_user_id: e.slack_user_id,
      person_id: deps.demoPersonId,
    });
    return deps.demoPersonId;
  }

  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickStringDeep(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
