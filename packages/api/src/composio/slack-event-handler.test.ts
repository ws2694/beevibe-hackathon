import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  PersonRepository,
  SlackConversationSession,
  SlackConversationSessionRepository,
  SlackPersonLinkRepository,
  Agent,
  Person,
  SlackPersonLink,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import {
  buildFreshIntent,
  buildResumedIntent,
  deriveThreadBucket,
  extractSlackFields,
  handleComposioSlackEvent,
  resolvePerson,
  type SlackEventHandlerDeps,
} from "./slack-event-handler.js";
import type { ExtractedSlackEvent } from "./types.js";

function person(id: string, email?: string): Person {
  return {
    id,
    name: `person_${id}`,
    email,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function agent(id: string, level: "ic" | "team" | "org"): Agent {
  return {
    id,
    name: `agent_${id}`,
    owner_id: "owner",
    hierarchy_level: level,
    runtime_config: { type: "openclaw", model: "openai/Qwen/Qwen3.5-397B-A17B-fast" },
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeDeps(overrides: {
  cachedLink?: SlackPersonLink;
  cachedConversation?: SlackConversationSession;
  personByEmail?: Person;
  agentsForOwner?: Agent[];
  demoPersonId?: string;
  botUserId?: string;
  dispatchReturns?: { session: { id: string }; runtime_id?: string };
} = {}): {
  deps: SlackEventHandlerDeps;
  upsertSpy: ReturnType<typeof vi.fn>;
  dispatchSpy: ReturnType<typeof vi.fn>;
  conversationUpsertSpy: ReturnType<typeof vi.fn>;
} {
  const upsertSpy = vi.fn(async (input: { workspace_id: string; slack_user_id: string; person_id: string }) => ({
    ...input,
    created_at: new Date(),
  }));

  const dispatchSpy = vi.fn(async () => ({
    session: overrides.dispatchReturns?.session ?? { id: "sess_xxx" },
    runtime_id: overrides.dispatchReturns?.runtime_id,
  }));

  const slackPersonLinkRepo = {
    find: vi.fn(async () => overrides.cachedLink),
    upsert: upsertSpy,
  } as unknown as SlackPersonLinkRepository;

  const personRepo = {
    findByEmail: vi.fn(async () => overrides.personByEmail),
  } as unknown as PersonRepository;

  const agentRepo = {
    findTopLevelForOwner: vi.fn(async () => {
      // Reproduce the team-then-org preference used by findUserAgent.
      const list = overrides.agentsForOwner ?? [];
      return (
        list.find((a) => a.hierarchy_level === "team") ??
        list.find((a) => a.hierarchy_level === "org")
      );
    }),
  } as unknown as AgentRepository;

  const dispatchService = { dispatchTask: dispatchSpy } as unknown as DispatchService;

  const conversationUpsertSpy = vi.fn(async (input) => ({
    ...input,
    last_used_at: new Date(),
    created_at: new Date(),
  }));
  const slackConversationSessionRepo = {
    find: vi.fn(async () => overrides.cachedConversation),
    upsert: conversationUpsertSpy,
  } as unknown as SlackConversationSessionRepository;

  return {
    deps: {
      slackPersonLinkRepo,
      slackConversationSessionRepo,
      personRepo,
      agentRepo,
      dispatchService,
      botUserId: overrides.botUserId,
      demoPersonId: overrides.demoPersonId,
    },
    upsertSpy,
    dispatchSpy,
    conversationUpsertSpy,
  };
}

function dmEvent(overrides: Partial<Record<string, unknown>> = {}): {
  triggerSlug: string;
  payload: Record<string, unknown>;
} {
  return {
    triggerSlug: "SLACKBOT_DIRECT_MESSAGE_RECEIVED",
    payload: {
      team_id: "T_demo",
      user: "U_alice",
      channel: "D_alice_bot",
      text: "hello bot",
      ts: "1717000000.123456",
      ...overrides,
    },
  };
}

function channelEvent(overrides: Partial<Record<string, unknown>> = {}): {
  triggerSlug: string;
  payload: Record<string, unknown>;
} {
  return {
    triggerSlug: "SLACKBOT_CHANNEL_MESSAGE_RECEIVED",
    payload: {
      team_id: "T_demo",
      user: "U_alice",
      channel: "C_launches",
      text: "<@U_bot> please draft a tweet",
      ts: "1717000000.123456",
      ...overrides,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
//  extractSlackFields
// ───────────────────────────────────────────────────────────────────────

describe("extractSlackFields", () => {
  it("extracts the standard fields from a DM payload", () => {
    const got = extractSlackFields(dmEvent());
    expect(got).toMatchObject({
      workspace_id: "T_demo",
      slack_user_id: "U_alice",
      channel: "D_alice_bot",
      channel_kind: "dm",
      text: "hello bot",
      message_ts: "1717000000.123456",
    });
  });

  it("classifies channel ids starting with C as channel (not DM)", () => {
    const got = extractSlackFields(channelEvent());
    expect(got?.channel_kind).toBe("channel");
  });

  it("classifies channel ids starting with G as channel (private channels)", () => {
    const got = extractSlackFields(dmEvent({ channel: "G_private" }));
    expect(got?.channel_kind).toBe("channel");
  });

  it("returns undefined when minimum fields missing (no workspace_id)", () => {
    const got = extractSlackFields({
      triggerSlug: "SLACKBOT_DIRECT_MESSAGE_RECEIVED",
      payload: { user: "U_alice", channel: "D_x", text: "hi", ts: "1.0" },
    });
    expect(got).toBeUndefined();
  });

  it("falls back to originalPayload for fields missing from payload", () => {
    const got = extractSlackFields({
      triggerSlug: "SLACKBOT_DIRECT_MESSAGE_RECEIVED",
      payload: { team_id: "T_demo" },
      originalPayload: {
        user: "U_alice",
        channel: "D_x",
        text: "hi",
        ts: "1.0",
      },
    });
    expect(got?.slack_user_id).toBe("U_alice");
    expect(got?.text).toBe("hi");
  });

  it("recognizes thread_ts when present", () => {
    const got = extractSlackFields(
      dmEvent({ thread_ts: "1717000000.000000" }),
    );
    expect(got?.thread_ts).toBe("1717000000.000000");
  });

  it("extracts user email when present (email-bridge enrichment)", () => {
    const got = extractSlackFields(
      dmEvent({ user_email: "alice@example.com" }),
    );
    expect(got?.slack_user_email).toBe("alice@example.com");
  });

  it("passes through botUserId from caller", () => {
    const got = extractSlackFields(dmEvent(), "U_bot");
    expect(got?.bot_user_id).toBe("U_bot");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  buildFreshIntent
// ───────────────────────────────────────────────────────────────────────

describe("buildFreshIntent", () => {
  const base: ExtractedSlackEvent = {
    workspace_id: "T_demo",
    slack_user_id: "U_alice",
    channel: "D_alice_bot",
    channel_kind: "dm",
    text: "hello",
    message_ts: "1717000000.123456",
    bot_user_id: "U_bot",
  };

  it("includes the [Slack inbound] header, channel, sender, thread bucket, and text", () => {
    const out = buildFreshIntent(base);
    expect(out).toContain("[Slack inbound]");
    expect(out).toContain("U_alice");
    expect(out).toContain("D_alice_bot");
    expect(out).toContain("hello");
    // No thread_ts present → bucket falls back to message_ts.
    expect(out).toContain("Thread: 1717000000.123456");
  });

  it("uses existing thread_ts as the reply bucket when present", () => {
    const out = buildFreshIntent({ ...base, thread_ts: "1716000000.999999" });
    expect(out).toContain("Thread: 1716000000.999999");
    expect(out).toContain('thread_ts: "1716000000.999999"');
  });

  it("instructs the agent to use COMPOSIO_MULTI_EXECUTE_TOOL with SLACKBOT_SEND_MESSAGE", () => {
    const out = buildFreshIntent(base);
    expect(out).toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(out).toContain("SLACKBOT_SEND_MESSAGE");
    expect(out).toContain(`channel: "${base.channel}"`);
  });

  it("lists the four known authoritative slugs (no search needed)", () => {
    const out = buildFreshIntent(base);
    for (const slug of [
      "SLACKBOT_SEND_MESSAGE",
      "GMAIL_SEND_EMAIL",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GOOGLECALENDAR_CREATE_EVENT",
    ]) {
      expect(out).toContain(slug);
    }
  });

  it("forbids the Composio remote bash/workbench tools", () => {
    const out = buildFreshIntent(base);
    expect(out).toContain("Do NOT use COMPOSIO_REMOTE_BASH_TOOL");
    expect(out).toContain("COMPOSIO_REMOTE_WORKBENCH");
  });

  it("uses sender_name in the From line when available", () => {
    const out = buildFreshIntent({ ...base, sender_name: "Alice Chen" });
    expect(out).toContain("From: Alice Chen (U_alice)");
  });

  it("omits bot_user_id line gracefully when not configured", () => {
    const out = buildFreshIntent({ ...base, bot_user_id: undefined });
    expect(out).toContain("Bot user id: (not provided)");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  resolvePerson
// ───────────────────────────────────────────────────────────────────────

describe("resolvePerson", () => {
  const baseExtracted: ExtractedSlackEvent = {
    workspace_id: "T_demo",
    slack_user_id: "U_alice",
    channel: "D_x",
    channel_kind: "dm",
    text: "hi",
    message_ts: "1.0",
  };

  it("returns cached person_id without touching personRepo", async () => {
    const { deps, upsertSpy } = makeDeps({
      cachedLink: {
        workspace_id: "T_demo",
        slack_user_id: "U_alice",
        person_id: "p_cached",
        created_at: new Date(),
      },
    });
    expect(await resolvePerson(baseExtracted, deps)).toBe("p_cached");
    // Cache hit means we don't write back.
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(deps.personRepo.findByEmail).not.toHaveBeenCalled();
  });

  it("uses email bridge when cache misses and an email is present (+ writes cache)", async () => {
    const { deps, upsertSpy } = makeDeps({
      personByEmail: person("p_alice", "alice@example.com"),
    });
    const got = await resolvePerson(
      { ...baseExtracted, slack_user_email: "alice@example.com" },
      deps,
    );
    expect(got).toBe("p_alice");
    expect(deps.personRepo.findByEmail).toHaveBeenCalledWith(
      "alice@example.com",
    );
    expect(upsertSpy).toHaveBeenCalledWith({
      workspace_id: "T_demo",
      slack_user_id: "U_alice",
      person_id: "p_alice",
    });
  });

  it("falls back to demoPersonId when email lookup fails (+ writes cache)", async () => {
    const { deps, upsertSpy } = makeDeps({
      demoPersonId: "p_demo",
    });
    const got = await resolvePerson(
      { ...baseExtracted, slack_user_email: "no-such@example.com" },
      deps,
    );
    expect(got).toBe("p_demo");
    expect(upsertSpy).toHaveBeenCalledWith({
      workspace_id: "T_demo",
      slack_user_id: "U_alice",
      person_id: "p_demo",
    });
  });

  it("returns undefined when no email, no cache, and no demoPersonId", async () => {
    const { deps, upsertSpy } = makeDeps({});
    expect(await resolvePerson(baseExtracted, deps)).toBeUndefined();
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
//  handleComposioSlackEvent — end-to-end
// ───────────────────────────────────────────────────────────────────────

describe("handleComposioSlackEvent", () => {
  it("ignores events that fail extraction (missing required fields)", async () => {
    const { deps } = makeDeps({});
    const out = await handleComposioSlackEvent(
      { payload: { user: "only-user-no-workspace" } },
      deps,
    );
    expect(out).toEqual({ status: "ignored", reason: "extract_failed" });
  });

  it("ignores the bot's own messages (loop prevention)", async () => {
    const { deps } = makeDeps({ botUserId: "U_bot" });
    const out = await handleComposioSlackEvent(
      dmEvent({ user: "U_bot" }),
      deps,
    );
    expect(out).toEqual({ status: "ignored", reason: "own_bot_message" });
  });

  it("drops channel messages when no bot_user_id is configured (DM-only mode)", async () => {
    const { deps } = makeDeps({});
    const out = await handleComposioSlackEvent(channelEvent(), deps);
    expect(out).toEqual({
      status: "ignored",
      reason: "channel_message_dropped_no_bot_user_id_configured",
    });
  });

  it("ignores top-level channel messages that do NOT @-mention the bot", async () => {
    const { deps } = makeDeps({ botUserId: "U_bot" });
    const out = await handleComposioSlackEvent(
      channelEvent({ text: "hello team, no mention here" }),
      deps,
    );
    expect(out).toEqual({
      status: "ignored",
      reason: "channel_message_not_mentioned",
    });
  });

  it("ignores thread replies without @-mention when bot is NOT engaged in that thread", async () => {
    const { deps } = makeDeps({ botUserId: "U_bot" /* no cachedConversation */ });
    const out = await handleComposioSlackEvent(
      channelEvent({
        text: "just chatting in this thread, no bot mention",
        thread_ts: "1700000000.111",
      }),
      deps,
    );
    expect(out).toEqual({
      status: "ignored",
      reason: "channel_thread_reply_bot_not_engaged",
    });
  });

  it("processes thread replies without @-mention when bot IS engaged in that thread (natural follow-up)", async () => {
    const { deps, dispatchSpy } = makeDeps({
      botUserId: "U_bot",
      cachedLink: {
        workspace_id: "T_demo",
        slack_user_id: "U_alice",
        person_id: "p_alice",
        created_at: new Date(),
      },
      cachedConversation: {
        workspace_id: "T_demo",
        channel: "C_launches",
        thread_bucket: "1700000000.111",
        prior_session_id: "sess_prior",
        last_used_at: new Date(),
        created_at: new Date(),
      },
      agentsForOwner: [agent("ag_team", "team")],
    });
    const out = await handleComposioSlackEvent(
      channelEvent({
        text: "ok now tweak the third bullet",
        thread_ts: "1700000000.111",
      }),
      deps,
    );
    expect(out.status).toBe("dispatched");
    // Should resume since cachedConversation existed.
    expect(dispatchSpy.mock.calls[0]![0].reason).toEqual({
      kind: "chat_continuation",
      prior_session_id: "sess_prior",
    });
  });

  it("ignores when the resolved person has no top-level agent", async () => {
    const { deps } = makeDeps({
      cachedLink: {
        workspace_id: "T_demo",
        slack_user_id: "U_alice",
        person_id: "p_alice",
        created_at: new Date(),
      },
      // No agents for that owner
      agentsForOwner: [],
    });
    const out = await handleComposioSlackEvent(dmEvent(), deps);
    expect(out).toEqual({
      status: "ignored",
      reason: "person_has_no_top_level_agent",
    });
  });

  it("ignores an unmapped slack user when no email + no demoPersonId", async () => {
    const { deps } = makeDeps({});
    const out = await handleComposioSlackEvent(dmEvent(), deps);
    expect(out).toEqual({ status: "ignored", reason: "unmapped_slack_user" });
  });

  it("dispatches to the person's team agent on a clean DM (happy path)", async () => {
    const { deps, dispatchSpy } = makeDeps({
      cachedLink: {
        workspace_id: "T_demo",
        slack_user_id: "U_alice",
        person_id: "p_alice",
        created_at: new Date(),
      },
      agentsForOwner: [agent("ag_team", "team")],
      dispatchReturns: { session: { id: "sess_42" } },
    });
    const out = await handleComposioSlackEvent(dmEvent(), deps);
    expect(out).toEqual({
      status: "dispatched",
      agent_id: "ag_team",
      person_id: "p_alice",
      session_id: "sess_42",
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const call = dispatchSpy.mock.calls[0]![0];
    expect(call.agentId).toBe("ag_team");
    expect(call.type).toBe("chat");
    expect(call.reason).toEqual({ kind: "fresh" });
    expect(call.intent).toContain("[Slack inbound]");
    expect(call.intent).toContain("hello bot");
    expect(call.intent).toContain("SLACKBOT_SEND_MESSAGE");
  });

  it("dispatches via email bridge + cache write on first-time DM from a known beevibe email", async () => {
    const { deps, upsertSpy, dispatchSpy } = makeDeps({
      personByEmail: person("p_alice", "alice@example.com"),
      agentsForOwner: [agent("ag_team", "team")],
    });
    const out = await handleComposioSlackEvent(
      dmEvent({ user_email: "alice@example.com" }),
      deps,
    );
    expect(out.status).toBe("dispatched");
    expect(upsertSpy).toHaveBeenCalledWith({
      workspace_id: "T_demo",
      slack_user_id: "U_alice",
      person_id: "p_alice",
    });
    expect(dispatchSpy).toHaveBeenCalled();
  });

  it("on cache hit: uses RESUMED intent + chat_continuation reason + bumps cache to new session", async () => {
    const { deps, dispatchSpy, conversationUpsertSpy } = makeDeps({
      cachedLink: {
        workspace_id: "T_demo",
        slack_user_id: "U_alice",
        person_id: "p_alice",
        created_at: new Date(),
      },
      cachedConversation: {
        workspace_id: "T_demo",
        channel: "D_alice_bot",
        thread_bucket: "dm",
        prior_session_id: "sess_prior",
        last_used_at: new Date(),
        created_at: new Date(),
      },
      agentsForOwner: [agent("ag_team", "team")],
      dispatchReturns: { session: { id: "sess_new" } },
    });

    const out = await handleComposioSlackEvent(
      dmEvent({ text: "ok now tweet about it" }),
      deps,
    );
    expect(out.status).toBe("dispatched");

    const call = dispatchSpy.mock.calls[0]![0];
    // chat_continuation with the prior session id.
    expect(call.reason).toEqual({
      kind: "chat_continuation",
      prior_session_id: "sess_prior",
    });
    // RESUMED template — has its own header, not the FRESH briefing block.
    expect(call.intent).toContain("[Slack continuation]");
    expect(call.intent).not.toContain("[Slack inbound]");
    expect(call.intent).toContain("ok now tweet about it");

    // Cache bumped to the NEW sessionId so the NEXT turn resumes from this one.
    expect(conversationUpsertSpy).toHaveBeenCalledWith({
      workspace_id: "T_demo",
      channel: "D_alice_bot",
      thread_bucket: "dm",
      prior_session_id: "sess_new",
    });
  });

  it("on cache miss: uses FRESH intent + writes initial cache entry", async () => {
    const { deps, dispatchSpy, conversationUpsertSpy } = makeDeps({
      cachedLink: {
        workspace_id: "T_demo",
        slack_user_id: "U_alice",
        person_id: "p_alice",
        created_at: new Date(),
      },
      agentsForOwner: [agent("ag_team", "team")],
      dispatchReturns: { session: { id: "sess_first" } },
    });

    const out = await handleComposioSlackEvent(dmEvent(), deps);
    expect(out.status).toBe("dispatched");

    const call = dispatchSpy.mock.calls[0]![0];
    expect(call.reason).toEqual({ kind: "fresh" });
    expect(call.intent).toContain("[Slack inbound]");

    expect(conversationUpsertSpy).toHaveBeenCalledWith({
      workspace_id: "T_demo",
      channel: "D_alice_bot",
      thread_bucket: "dm",
      prior_session_id: "sess_first",
    });
  });

  it("dispatches a mentioned channel message", async () => {
    const { deps, dispatchSpy } = makeDeps({
      cachedLink: {
        workspace_id: "T_demo",
        slack_user_id: "U_alice",
        person_id: "p_alice",
        created_at: new Date(),
      },
      agentsForOwner: [agent("ag_team", "team")],
      botUserId: "U_bot",
    });
    const out = await handleComposioSlackEvent(channelEvent(), deps);
    expect(out.status).toBe("dispatched");

    const intent = dispatchSpy.mock.calls[0]![0].intent;
    // Bot user id appears in the strip-mentions hint.
    expect(intent).toContain("U_bot");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  deriveThreadBucket + buildResumedIntent
// ───────────────────────────────────────────────────────────────────────

describe("deriveThreadBucket", () => {
  const dm: ExtractedSlackEvent = {
    workspace_id: "T",
    slack_user_id: "U",
    channel: "D_x",
    channel_kind: "dm",
    text: "",
    message_ts: "1.0",
  };

  it("returns 'dm' for DM channels (one rolling session per DM)", () => {
    expect(deriveThreadBucket(dm)).toBe("dm");
  });

  it("returns thread_ts for in-thread channel messages", () => {
    expect(
      deriveThreadBucket({
        ...dm,
        channel: "C_x",
        channel_kind: "channel",
        thread_ts: "1700000000.111",
      }),
    ).toBe("1700000000.111");
  });

  it("returns message_ts for top-level channel @-mentions (creates thread)", () => {
    expect(
      deriveThreadBucket({
        ...dm,
        channel: "C_x",
        channel_kind: "channel",
        message_ts: "1700000000.999",
        thread_ts: undefined,
      }),
    ).toBe("1700000000.999");
  });

  it("DM with thread_ts still buckets to 'dm' (DM-side threads collapse)", () => {
    expect(
      deriveThreadBucket({ ...dm, thread_ts: "1.5" }),
    ).toBe("dm");
  });
});

describe("buildResumedIntent", () => {
  const base: ExtractedSlackEvent = {
    workspace_id: "T",
    slack_user_id: "U_alice",
    channel: "D_alice_bot",
    channel_kind: "dm",
    text: "follow-up message",
    message_ts: "1.0",
  };

  it("is shorter than FRESH (no slug catalog or sandbox prohibition)", () => {
    const resumed = buildResumedIntent(base);
    const fresh = buildFreshIntent(base);
    expect(resumed.length).toBeLessThan(fresh.length);
    expect(resumed).not.toContain("Known authoritative slugs");
    expect(resumed).not.toContain("COMPOSIO_REMOTE_BASH_TOOL");
  });

  it("includes the [Slack continuation] header + channel + thread + sender + message", () => {
    const out = buildResumedIntent(base);
    expect(out).toContain("[Slack continuation]");
    expect(out).toContain("D_alice_bot");
    expect(out).toContain("U_alice");
    expect(out).toContain("follow-up message");
  });

  it("preserves thread_ts in the reply context when set", () => {
    const out = buildResumedIntent({ ...base, thread_ts: "1700000000.111" });
    expect(out).toContain("Thread: 1700000000.111");
  });

  it("includes the COMPOSIO_MULTI_EXECUTE_TOOL recipe so a fresh-spawned runtime can still reply", () => {
    // Critical: when chat_continuation is requested but the prior session
    // had no cli_session_id, the runtime spawns fresh and loses tool-use
    // context. The recipe in RESUMED guarantees the agent can still post.
    const out = buildResumedIntent(base);
    expect(out).toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(out).toContain("SLACKBOT_SEND_MESSAGE");
    expect(out).toContain(`channel: "${base.channel}"`);
  });
});
