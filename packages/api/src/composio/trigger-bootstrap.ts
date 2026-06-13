/**
 * Idempotent creation of the Slack triggers we subscribe to.
 *
 * Run on api startup when COMPOSIO_API_KEY + COMPOSIO_USER_ID are set.
 * Lists active triggers for the configured Composio user, then creates
 * any missing entries from REQUIRED_TRIGGERS. "Already exists" errors
 * from the Composio API are swallowed — the goal is convergent state,
 * not strict create-or-fail.
 *
 * The two triggers we depend on (probed live via Composio's REST API
 * 2026-06-11):
 *
 *  - SLACKBOT_DIRECT_MESSAGE_RECEIVED — fires for any DM to our bot
 *  - SLACKBOT_CHANNEL_MESSAGE_RECEIVED — fires for any message in any
 *    channel the bot is in; the handler filters down to messages that
 *    @-mention us.
 */

import type { Composio } from "@composio/core";

export const REQUIRED_SLACK_TRIGGER_SLUGS = [
  "SLACKBOT_DIRECT_MESSAGE_RECEIVED",
  "SLACKBOT_CHANNEL_MESSAGE_RECEIVED",
] as const;

export type RequiredSlackTriggerSlug = (typeof REQUIRED_SLACK_TRIGGER_SLUGS)[number];

export interface TriggerBootstrapResult {
  /** Triggers already active before this run — no-ops. */
  already_active: RequiredSlackTriggerSlug[];
  /** Triggers we created. */
  created: RequiredSlackTriggerSlug[];
  /** Triggers we tried to create but failed; demo can still proceed. */
  failed: { slug: RequiredSlackTriggerSlug; error: string }[];
}

export async function ensureSlackTriggers(
  composio: Composio,
  userId: string,
): Promise<TriggerBootstrapResult> {
  const result: TriggerBootstrapResult = {
    already_active: [],
    created: [],
    failed: [],
  };

  // Listing active triggers is best-effort. The SDK's response shape varies
  // across versions; rather than thread types around defensive parsing, we
  // attempt create() on each slug and let Composio's "already exists" path
  // dedupe. A failed list call shouldn't block setup.
  const activeSlugs = await safeListActiveSlugs(composio, userId);

  for (const slug of REQUIRED_SLACK_TRIGGER_SLUGS) {
    if (activeSlugs.has(slug)) {
      result.already_active.push(slug);
      continue;
    }
    try {
      await composio.triggers.create(userId, slug, {});
      result.created.push(slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Composio returns "already exists" / 409 if a trigger for this
      // (user, slug) pair was created out-of-band. Treat as a no-op.
      if (/already exists|409|conflict/i.test(msg)) {
        result.already_active.push(slug);
      } else {
        result.failed.push({ slug, error: msg });
      }
    }
  }

  return result;
}

async function safeListActiveSlugs(
  composio: Composio,
  userId: string,
): Promise<Set<string>> {
  try {
    const resp = (await composio.triggers.listActive({
      userIds: [userId],
    } as never)) as unknown;
    const items = extractTriggerItems(resp);
    return new Set(
      items
        .map(
          (it) =>
            it.triggerName ?? it.triggerSlug ?? it.slug ?? it.trigger_name,
        )
        .filter((s): s is string => typeof s === "string"),
    );
  } catch {
    return new Set();
  }
}

interface TriggerListItem {
  triggerName?: string;
  triggerSlug?: string;
  slug?: string;
  trigger_name?: string;
}

function extractTriggerItems(resp: unknown): TriggerListItem[] {
  if (Array.isArray(resp)) return resp as TriggerListItem[];
  if (typeof resp !== "object" || resp === null) return [];
  const obj = resp as Record<string, unknown>;
  for (const key of ["items", "data", "results", "triggers"]) {
    const v = obj[key];
    if (Array.isArray(v)) return v as TriggerListItem[];
  }
  return [];
}
