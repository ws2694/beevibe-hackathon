import { describe, expect, it } from "vitest";
import { buildMcpConfig, readExtraMcpServersFromEnv } from "./manager.js";

const API_KEY = "bv_a_test";
const MCP_URL = "http://localhost:3000/mcp";

function parse(json: string): {
  mcpServers: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(json);
}

describe("buildMcpConfig", () => {
  it("emits only the beevibe entry when no extras passed (backward compat)", () => {
    const got = parse(buildMcpConfig(API_KEY, MCP_URL));
    expect(Object.keys(got.mcpServers)).toEqual(["beevibe"]);
    expect(got.mcpServers.beevibe).toEqual({
      type: "http",
      url: MCP_URL,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "X-Beevibe-Session": "${BEEVIBE_SESSION_ID}",
      },
    });
  });

  it("emits the same shape when extras is the empty object", () => {
    const original = buildMcpConfig(API_KEY, MCP_URL);
    const withEmptyExtras = buildMcpConfig(API_KEY, MCP_URL, {});
    expect(withEmptyExtras).toBe(original);
  });

  it("adds composio entry with x-consumer-api-key header when set", () => {
    const got = parse(
      buildMcpConfig(API_KEY, MCP_URL, {
        composio: {
          url: "https://connect.composio.dev/mcp",
          consumerKey: "ck_test",
        },
      }),
    );
    expect(got.mcpServers.composio).toEqual({
      type: "http",
      url: "https://connect.composio.dev/mcp",
      headers: { "x-consumer-api-key": "ck_test" },
    });
    // Critical: NOT using Authorization: Bearer
    expect(
      (got.mcpServers.composio.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("adds tavily entry with api key embedded in URL when set", () => {
    const got = parse(
      buildMcpConfig(API_KEY, MCP_URL, {
        tavily: { apiKey: "tvly_test" },
      }),
    );
    expect(got.mcpServers.tavily).toEqual({
      type: "http",
      url: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly_test",
    });
  });

  it("emits beevibe + composio + tavily when all set", () => {
    const got = parse(
      buildMcpConfig(API_KEY, MCP_URL, {
        composio: { url: "https://c.dev/mcp", consumerKey: "ck" },
        tavily: { apiKey: "tvly" },
      }),
    );
    expect(Object.keys(got.mcpServers).sort()).toEqual([
      "beevibe",
      "composio",
      "tavily",
    ]);
  });

  it("preserves trailing newline for predictable file diff", () => {
    expect(buildMcpConfig(API_KEY, MCP_URL).endsWith("\n")).toBe(true);
    expect(
      buildMcpConfig(API_KEY, MCP_URL, {
        tavily: { apiKey: "x" },
      }).endsWith("\n"),
    ).toBe(true);
  });
});

describe("readExtraMcpServersFromEnv", () => {
  it("returns empty when none of the relevant env vars are set", () => {
    expect(readExtraMcpServersFromEnv({})).toEqual({});
  });

  it("populates composio only when BOTH URL and consumer key are set", () => {
    expect(
      readExtraMcpServersFromEnv({
        COMPOSIO_MCP_URL: "https://x",
        COMPOSIO_MCP_CONSUMER_KEY: "ck_x",
      }),
    ).toEqual({
      composio: { url: "https://x", consumerKey: "ck_x" },
    });
  });

  it("omits composio if only URL set (avoid unauthenticated calls)", () => {
    expect(
      readExtraMcpServersFromEnv({
        COMPOSIO_MCP_URL: "https://x",
      }),
    ).toEqual({});
  });

  it("omits composio if only consumer key set (no URL to call)", () => {
    expect(
      readExtraMcpServersFromEnv({
        COMPOSIO_MCP_CONSUMER_KEY: "ck_x",
      }),
    ).toEqual({});
  });

  it("populates tavily when api key is set", () => {
    expect(
      readExtraMcpServersFromEnv({ TAVILY_API_KEY: "tvly_x" }),
    ).toEqual({
      tavily: { apiKey: "tvly_x" },
    });
  });

  it("treats whitespace-only env values as unset and trims valid ones", () => {
    expect(
      readExtraMcpServersFromEnv({
        COMPOSIO_MCP_URL: "  https://x  ",
        COMPOSIO_MCP_CONSUMER_KEY: "ck_x",
        TAVILY_API_KEY: "   ",
      }),
    ).toEqual({
      composio: { url: "https://x", consumerKey: "ck_x" },
    });
  });

  it("treats empty string as unset", () => {
    expect(
      readExtraMcpServersFromEnv({
        COMPOSIO_MCP_URL: "",
        COMPOSIO_MCP_CONSUMER_KEY: "ck",
        TAVILY_API_KEY: "",
      }),
    ).toEqual({});
  });
});
