/**
 * Long-lived Composio SDK subscribe loop.
 *
 * `composio.triggers.subscribe` opens a persistent push channel (Pusher
 * under the hood) to Composio's backend. Each inbound Slack trigger is
 * delivered to a callback synchronously; this module wraps that callback
 * around the pure `handleComposioSlackEvent` so the SDK's wire layer
 * stays out of test scope.
 *
 * Wired into api bootstrap conditionally — when COMPOSIO_API_KEY and
 * COMPOSIO_USER_ID are present in env. Absent in CI (no real Composio
 * project), so the api still boots cleanly without it.
 */

import { Composio } from "@composio/core";
import {
  handleComposioSlackEvent,
  type SlackEventHandlerDeps,
} from "./slack-event-handler.js";
import {
  ensureSlackTriggers,
  REQUIRED_SLACK_TRIGGER_SLUGS,
} from "./trigger-bootstrap.js";

export interface ComposioSubscriberConfig {
  apiKey: string;
  userId: string;
  handlerDeps: SlackEventHandlerDeps;
}

export interface ComposioSubscriberHandle {
  stop: () => Promise<void>;
}

export async function startComposioSubscriber(
  config: ComposioSubscriberConfig,
): Promise<ComposioSubscriberHandle> {
  const composio = new Composio({ apiKey: config.apiKey });

  const bootstrapResult = await ensureSlackTriggers(composio, config.userId);
  if (bootstrapResult.created.length > 0) {
    console.log(
      `[composio] created triggers: ${bootstrapResult.created.join(", ")}`,
    );
  }
  if (bootstrapResult.already_active.length > 0) {
    console.log(
      `[composio] triggers already active: ${bootstrapResult.already_active.join(", ")}`,
    );
  }
  if (bootstrapResult.failed.length > 0) {
    for (const { slug, error } of bootstrapResult.failed) {
      console.error(`[composio] trigger ${slug} setup failed: ${error}`);
    }
  }

  await composio.triggers.subscribe(
    (data) => {
      // Fire-and-forget dispatch — the agent's reply goes through Composio
      // MCP (SLACKBOT_SEND_MESSAGE), not back through this socket.
      const event = data as {
        triggerSlug?: string;
        payload?: { text?: string; user?: string; channel?: string };
      };
      const slug = event.triggerSlug ?? "?";
      // Debug: extract <@U_xxx> mentions from the message text and the
      // sender id so the operator can identify the bot's Slack user id
      // (needed for BEEVIBE_SLACK_BOT_USER_ID env). Always log on inbound;
      // remove once the demo is set up.
      const text = event.payload?.text ?? "";
      const mentioned = Array.from(text.matchAll(/<@(U[A-Z0-9]+)>/g)).map(
        (m) => m[1],
      );
      console.log(
        `[composio inbound] ${slug} from=${event.payload?.user} channel=${event.payload?.channel} mentions=[${mentioned.join(",")}] text="${text.slice(0, 80)}"`,
      );
      void handleComposioSlackEvent(data as never, config.handlerDeps)
        .then((outcome) => {
          if (outcome.status === "dispatched") {
            console.log(
              `[composio] ${slug} -> agent ${outcome.agent_id} (session ${outcome.session_id})`,
            );
          } else {
            console.log(`[composio] ${slug} ignored: ${outcome.reason}`);
          }
        })
        .catch((err: unknown) => {
          console.error("[composio] slack event handler error:", err);
        });
    },
    {
      userId: config.userId,
      triggerSlug: [...REQUIRED_SLACK_TRIGGER_SLUGS],
    } as never,
  );

  console.log(
    `[composio] subscriber listening for ${REQUIRED_SLACK_TRIGGER_SLUGS.join(", ")} (user ${config.userId})`,
  );

  return {
    stop: async () => {
      try {
        await composio.triggers.unsubscribe();
      } catch (err) {
        console.error("[composio] unsubscribe error:", err);
      }
    },
  };
}
