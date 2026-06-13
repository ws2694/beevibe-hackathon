import { describe, expect, it } from "vitest";
import type { RuntimeContext } from "../../ports/runtime.js";
import {
  buildAgentArgs,
  composeOpenClawEnv,
  injectNebiusOpenAiCompat,
  OpenClawRuntime,
  parseAgentResult,
} from "./runtime.js";

function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "say hello",
    workspace: { path: "/tmp/test-workspace" },
    system_prompt_append: "",
    ...overrides,
  };
}

describe("OpenClawRuntime", () => {
  it("reports its identity as 'openclaw'", () => {
    expect(new OpenClawRuntime().type).toBe("openclaw");
  });

  it("skillsDir is workspace-scoped under .openclaw/skills", () => {
    const rt = new OpenClawRuntime();
    expect(rt.skillsDir({ path: "/ws" })).toBe("/ws/.openclaw/skills");
  });
});

describe("buildAgentArgs", () => {
  it("includes the always-on flags: agent --local --json --timeout --model --session-key --message", () => {
    const args = buildAgentArgs(makeContext({ intent: "hi" }), {});
    expect(args[0]).toBe("agent");
    expect(args).toContain("--local");
    expect(args).toContain("--json");
    expect(args).toContain("--timeout");
    expect(args).toContain("--model");
    expect(args).toContain("--session-key");
    expect(args).toContain("--message");
    expect(args[args.length - 1]).toBe("hi");
  });

  it("uses configured timeoutSeconds over the default", () => {
    const args = buildAgentArgs(makeContext(), { timeoutSeconds: 120 });
    const idx = args.indexOf("--timeout");
    expect(args[idx + 1]).toBe("120");
  });

  it("uses context.model when set, falling back to config.model, then env, then DEFAULT_MODEL", () => {
    const savedEnv = process.env.BEEVIBE_OPENCLAW_MODEL;
    try {
      delete process.env.BEEVIBE_OPENCLAW_MODEL;
      const fromCtx = buildAgentArgs(
        makeContext({ model: "openai/explicit-ctx" }),
        { model: "openai/cfg" },
      );
      expect(modelArg(fromCtx)).toBe("openai/explicit-ctx");

      const fromCfg = buildAgentArgs(makeContext(), { model: "openai/cfg" });
      expect(modelArg(fromCfg)).toBe("openai/cfg");

      const fromDefault = buildAgentArgs(makeContext(), {});
      // DEFAULT_MODEL is the hackathon Nebius default.
      expect(modelArg(fromDefault)).toMatch(/^nebius\//);
    } finally {
      process.env.BEEVIBE_OPENCLAW_MODEL = savedEnv;
    }
  });

  it("BEEVIBE_OPENCLAW_MODEL env: bare vendor/model gets `nebius/` prepended", () => {
    const saved = process.env.BEEVIBE_OPENCLAW_MODEL;
    try {
      process.env.BEEVIBE_OPENCLAW_MODEL = "meta-llama/Llama-3.3-70B-Instruct";
      const args = buildAgentArgs(makeContext(), {});
      expect(modelArg(args)).toBe("nebius/meta-llama/Llama-3.3-70B-Instruct");
    } finally {
      process.env.BEEVIBE_OPENCLAW_MODEL = saved;
    }
  });

  it("BEEVIBE_OPENCLAW_MODEL env: nebius-qualified passes through unchanged", () => {
    const saved = process.env.BEEVIBE_OPENCLAW_MODEL;
    try {
      process.env.BEEVIBE_OPENCLAW_MODEL = "nebius/Qwen/Qwen3.5-397B-A17B-fast";
      const args = buildAgentArgs(makeContext(), {});
      expect(modelArg(args)).toBe("nebius/Qwen/Qwen3.5-397B-A17B-fast");
    } finally {
      process.env.BEEVIBE_OPENCLAW_MODEL = saved;
    }
  });

  it("BEEVIBE_OPENCLAW_MODEL env: any other known provider prefix passes through", () => {
    const saved = process.env.BEEVIBE_OPENCLAW_MODEL;
    try {
      // claude-cli is one of OpenClaw's built-in providers; users may want
      // to override BEEVIBE_OPENCLAW_MODEL to fall back to that.
      process.env.BEEVIBE_OPENCLAW_MODEL = "claude-cli/claude-opus-4-7";
      const args = buildAgentArgs(makeContext(), {});
      expect(modelArg(args)).toBe("claude-cli/claude-opus-4-7");
    } finally {
      process.env.BEEVIBE_OPENCLAW_MODEL = saved;
    }
  });

  it("adds --session-id (no --session-key) when context.resume_session_id is set", () => {
    const args = buildAgentArgs(
      makeContext({ resume_session_id: "sess_abc" }),
      {},
    );
    const idx = args.indexOf("--session-id");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("sess_abc");
    // Resume mode doesn't also synthesize a session-key.
    expect(args.includes("--session-key")).toBe(false);
  });

  it("adds --session-key (no --session-id) for fresh sessions", () => {
    const args = buildAgentArgs(makeContext({ resume_session_id: undefined }), {});
    expect(args.includes("--session-id")).toBe(false);
    const idx = args.indexOf("--session-key");
    expect(idx).toBeGreaterThan(-1);
    // OpenClaw expects the `agent:<id>:<key>` format.
    expect(args[idx + 1]).toMatch(/^agent:beevibe:[0-9a-f]+$/);
  });

  it("wraps system_prompt_append in beevibe_system_context delimiters before the intent", () => {
    const args = buildAgentArgs(
      makeContext({
        intent: "Do the thing",
        system_prompt_append: "You are agent_alice.",
      }),
      {},
    );
    const msg = args[args.length - 1] ?? "";
    expect(msg).toContain("<beevibe_system_context>");
    expect(msg).toContain("You are agent_alice.");
    expect(msg).toContain("</beevibe_system_context>");
    expect(msg).toContain("Do the thing");
    // intent comes AFTER the system block, not before.
    expect(msg.indexOf("Do the thing")).toBeGreaterThan(
      msg.indexOf("</beevibe_system_context>"),
    );
  });

  it("passes raw intent when system_prompt_append is empty (no wrapping noise)", () => {
    const args = buildAgentArgs(
      makeContext({ intent: "hi", system_prompt_append: "" }),
      {},
    );
    expect(args[args.length - 1]).toBe("hi");
  });
});

describe("parseAgentResult", () => {
  it("returns empty output for empty stdout", () => {
    expect(parseAgentResult("")).toEqual({ output: "" });
  });

  it("falls back to raw text when stdout is not JSON", () => {
    expect(parseAgentResult("just some text response")).toEqual({
      output: "just some text response",
    });
  });

  it("extracts payloads[0].text + meta.agentMeta.sessionId (native OpenClaw 2026.6.5 shape)", () => {
    const stdout = JSON.stringify({
      payloads: [{ text: "Today you have 1 event…", mediaUrl: null }],
      meta: {
        agentMeta: {
          sessionId: "44d3fcbc-8a98-4acb-a2f3-20f4b44f5000",
          provider: "nebius",
          model: "Qwen/Qwen3.5-397B-A17B-fast",
        },
        durationMs: 8761,
      },
    });
    expect(parseAgentResult(stdout)).toEqual({
      output: "Today you have 1 event…",
      session_id: "44d3fcbc-8a98-4acb-a2f3-20f4b44f5000",
    });
  });

  it("falls back to top-level message + session_id when payloads/meta absent", () => {
    const stdout = JSON.stringify({
      message: "hello back",
      session_id: "sess_42",
    });
    expect(parseAgentResult(stdout)).toEqual({
      output: "hello back",
      session_id: "sess_42",
    });
  });

  it("recognizes alternate field names (reply / text / content / output)", () => {
    expect(parseAgentResult(JSON.stringify({ reply: "r" })).output).toBe("r");
    expect(parseAgentResult(JSON.stringify({ text: "t" })).output).toBe("t");
    expect(parseAgentResult(JSON.stringify({ content: "c" })).output).toBe("c");
    expect(parseAgentResult(JSON.stringify({ output: "o" })).output).toBe("o");
  });

  it("recognizes camelCase sessionId", () => {
    const stdout = JSON.stringify({ message: "x", sessionId: "sess_camel" });
    expect(parseAgentResult(stdout).session_id).toBe("sess_camel");
  });

  it("recognizes nested session.id form", () => {
    const stdout = JSON.stringify({
      message: "x",
      session: { id: "sess_nested" },
    });
    expect(parseAgentResult(stdout).session_id).toBe("sess_nested");
  });

  it("parses NDJSON: picks the LAST line as the final result", () => {
    const stdout = [
      JSON.stringify({ event: "start" }),
      JSON.stringify({ event: "tool_call", tool: "x" }),
      JSON.stringify({ message: "final", session_id: "sess_last" }),
    ].join("\n");
    expect(parseAgentResult(stdout)).toEqual({
      output: "final",
      session_id: "sess_last",
    });
  });

  it("survives partial JSON in tail by falling back to earlier lines", () => {
    // Last line malformed -> walk backwards. The earlier intermediate
    // event has no recognized output field, so it returns text-only
    // (just the event JSON without message).
    const stdout = [
      JSON.stringify({ message: "good", session_id: "sess_good" }),
      "{ not really json",
    ].join("\n");
    expect(parseAgentResult(stdout).output).toBe("good");
    expect(parseAgentResult(stdout).session_id).toBe("sess_good");
  });
});

describe("injectNebiusOpenAiCompat", () => {
  it("sets OPENAI_API_KEY and OPENAI_BASE_URL from NEBIUS_* when destinations are unset", () => {
    const savedKey = process.env.NEBIUS_API_KEY;
    const savedUrl = process.env.NEBIUS_BASE_URL;
    try {
      process.env.NEBIUS_API_KEY = "nbk_test";
      process.env.NEBIUS_BASE_URL = "https://nebius.example/v1";
      const env: Record<string, string | undefined> = {};
      injectNebiusOpenAiCompat(env);
      expect(env.OPENAI_API_KEY).toBe("nbk_test");
      expect(env.OPENAI_BASE_URL).toBe("https://nebius.example/v1");
    } finally {
      process.env.NEBIUS_API_KEY = savedKey;
      process.env.NEBIUS_BASE_URL = savedUrl;
    }
  });

  it("respects existing OPENAI_* values (doesn't overwrite explicit overrides)", () => {
    const savedKey = process.env.NEBIUS_API_KEY;
    const savedUrl = process.env.NEBIUS_BASE_URL;
    try {
      process.env.NEBIUS_API_KEY = "nbk_test";
      process.env.NEBIUS_BASE_URL = "https://nebius.example/v1";
      const env: Record<string, string | undefined> = {
        OPENAI_API_KEY: "preset_key",
        OPENAI_BASE_URL: "https://preset.example",
      };
      injectNebiusOpenAiCompat(env);
      expect(env.OPENAI_API_KEY).toBe("preset_key");
      expect(env.OPENAI_BASE_URL).toBe("https://preset.example");
    } finally {
      process.env.NEBIUS_API_KEY = savedKey;
      process.env.NEBIUS_BASE_URL = savedUrl;
    }
  });

  it("no-ops when NEBIUS_* vars are unset", () => {
    const savedKey = process.env.NEBIUS_API_KEY;
    const savedUrl = process.env.NEBIUS_BASE_URL;
    try {
      delete process.env.NEBIUS_API_KEY;
      delete process.env.NEBIUS_BASE_URL;
      const env: Record<string, string | undefined> = {};
      injectNebiusOpenAiCompat(env);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENAI_BASE_URL).toBeUndefined();
    } finally {
      process.env.NEBIUS_API_KEY = savedKey;
      process.env.NEBIUS_BASE_URL = savedUrl;
    }
  });
});

function modelArg(args: string[]): string | undefined {
  const idx = args.indexOf("--model");
  return idx === -1 ? undefined : args[idx + 1];
}

describe("composeOpenClawEnv — Nebius cred leak protection", () => {
  // Snapshot + restore the env vars these tests mutate, so we don't
  // pollute later tests.
  function withEnv<T>(
    overrides: Record<string, string | undefined>,
    fn: () => T,
  ): T {
    const keys = Object.keys(overrides);
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it("strips shell OPENAI_API_KEY and replaces with Nebius (THE CORE BUG)", () => {
    withEnv(
      {
        // Shell already has a real OpenAI key — the bug case.
        OPENAI_API_KEY: "sk-real-openai",
        OPENAI_BASE_URL: undefined,
        NEBIUS_API_KEY: "nbk_test",
        NEBIUS_BASE_URL: "https://api.studio.nebius.com/v1",
      },
      () => {
        const env = composeOpenClawEnv({});
        // Critical: NOT the shell OpenAI key.
        expect(env.OPENAI_API_KEY).toBe("nbk_test");
        expect(env.OPENAI_API_KEY).not.toBe("sk-real-openai");
        // And the base URL is now Nebius, so requests go to studio.nebius.com.
        expect(env.OPENAI_BASE_URL).toBe("https://api.studio.nebius.com/v1");
      },
    );
  });

  it("strips OPENAI_BASE_URL too (otherwise Nebius base URL injection skipped)", () => {
    withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: "https://leaked.openai.example/v1",
        NEBIUS_API_KEY: "nbk_test",
        NEBIUS_BASE_URL: "https://api.studio.nebius.com/v1",
      },
      () => {
        const env = composeOpenClawEnv({});
        expect(env.OPENAI_BASE_URL).toBe("https://api.studio.nebius.com/v1");
      },
    );
  });

  it("strips OPENAI_AUTH_TOKEN (codex-style subscription token leak)", () => {
    withEnv(
      {
        OPENAI_AUTH_TOKEN: "tok_leaked",
        NEBIUS_API_KEY: "nbk_test",
        NEBIUS_BASE_URL: undefined,
      },
      () => {
        const env = composeOpenClawEnv({});
        expect(env.OPENAI_AUTH_TOKEN).toBeUndefined();
      },
    );
  });

  it("context.env explicit override wins over Nebius default", () => {
    withEnv(
      {
        OPENAI_API_KEY: "sk-real-openai",
        NEBIUS_API_KEY: "nbk_test",
        NEBIUS_BASE_URL: "https://api.studio.nebius.com/v1",
      },
      () => {
        const env = composeOpenClawEnv({
          env: {
            OPENAI_API_KEY: "sk-test-explicit",
            OPENAI_BASE_URL: "https://explicit.example/v1",
          },
        });
        // Explicit override beats Nebius default.
        expect(env.OPENAI_API_KEY).toBe("sk-test-explicit");
        expect(env.OPENAI_BASE_URL).toBe("https://explicit.example/v1");
      },
    );
  });

  it("when Nebius vars are absent, OPENAI_* stays undefined (subprocess fails loudly, no leak)", () => {
    withEnv(
      {
        OPENAI_API_KEY: "sk-real-openai",
        OPENAI_BASE_URL: "https://leak.example",
        NEBIUS_API_KEY: undefined,
        NEBIUS_BASE_URL: undefined,
      },
      () => {
        const env = composeOpenClawEnv({});
        // No fallback to the shell value — OpenClaw will fail to
        // auth and the operator gets a clear error instead of a
        // silent OpenAI bill.
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.OPENAI_BASE_URL).toBeUndefined();
      },
    );
  });

  it("preserves non-OpenAI env vars from process.env (PATH, HOME, BEEVIBE_*)", () => {
    withEnv(
      {
        OPENAI_API_KEY: "sk-real-openai",
        NEBIUS_API_KEY: "nbk_test",
        NEBIUS_BASE_URL: "https://api.studio.nebius.com/v1",
      },
      () => {
        const env = composeOpenClawEnv({});
        // PATH and HOME are stable on test machines; just check they exist.
        expect(env.PATH).toBeDefined();
        expect(env.HOME).toBeDefined();
      },
    );
  });
});
