import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { NebiusLlmProvider } from "./llm-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../../../.env") });

describe("NebiusLlmProvider", () => {
  it("complete returns assistant text and token usage (Llama-3.3-70B)", async () => {
    const llm = new NebiusLlmProvider();
    const res = await llm.complete({
      system: "You answer with a single word.",
      prompt: "Return the word 'pong' with no punctuation.",
      maxTokens: 20,
      temperature: 0,
    });
    expect(res.text.toLowerCase()).toContain("pong");
    expect(res.usage.input_tokens).toBeGreaterThan(0);
    expect(res.usage.output_tokens).toBeGreaterThan(0);
    // Nebius echoes the full model id (provider/name) in responses.
    expect(res.usage.model).toMatch(/Llama|Qwen|DeepSeek|meta-llama/i);
  }, 30_000);

  it("completeStructured returns a typed object conforming to the schema", async () => {
    const llm = new NebiusLlmProvider();
    interface ColorPref {
      color: string;
      confidence: number;
    }
    const res = await llm.completeStructured<ColorPref>({
      system: "You extract the user's color preference from a short statement.",
      prompt: "I really love the color green. It makes me happy.",
      maxTokens: 100,
      temperature: 0,
      schema_name: "color_preference",
      schema_description: "The user's stated color preference.",
      schema: {
        type: "object",
        properties: {
          color: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["color", "confidence"],
        additionalProperties: false,
      },
    });
    expect(typeof res.value.color).toBe("string");
    expect(res.value.color.toLowerCase()).toContain("green");
    expect(typeof res.value.confidence).toBe("number");
    expect(res.usage.input_tokens).toBeGreaterThan(0);
  }, 30_000);

  it("throws when no API key is configured", () => {
    const saved = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = "";
    try {
      expect(() => new NebiusLlmProvider()).toThrow(/NEBIUS_API_KEY/);
    } finally {
      process.env.NEBIUS_API_KEY = saved;
    }
  });

  it("honors per-request model override (DeepSeek-V3.2-fast — documented fallback)", async () => {
    const llm = new NebiusLlmProvider();
    const res = await llm.complete({
      system: "You answer with a single word.",
      prompt: "Return the word 'ok' with no punctuation.",
      maxTokens: 20,
      temperature: 0,
      model: "deepseek-ai/DeepSeek-V3.2-fast",
    });
    expect(res.text.toLowerCase()).toContain("ok");
    expect(res.usage.model).toMatch(/deepseek/i);
  }, 30_000);

  it("reports its identity via the type field", () => {
    const llm = new NebiusLlmProvider();
    expect(llm.type).toBe("nebius");
  });

  it("uses configured baseURL over env default when both provided", () => {
    const llm = new NebiusLlmProvider({
      baseURL: "https://custom.example/v1",
    });
    // The OpenAI client exposes its baseURL; not part of LlmProvider port
    // but a useful smoke check that the constructor wiring is correct.
    expect(
      (llm as unknown as { client: { baseURL: string } }).client.baseURL,
    ).toBe("https://custom.example/v1");
  });
});
