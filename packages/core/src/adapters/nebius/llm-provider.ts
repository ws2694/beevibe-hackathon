import OpenAI from "openai";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmUsage,
} from "../../ports/llm-provider.js";

const DEFAULT_BASE_URL = "https://api.studio.nebius.com/v1";
// PONG-verified live 2026-06-11 — also serves as the safe fallback if the
// configured model is unavailable. Larger Qwen / DeepSeek / Kimi options
// are listed in the project's BEEVIBE_OPENCLAW_MODEL env doc (M5).
const DEFAULT_MODEL = "meta-llama/Llama-3.3-70B-Instruct";

export interface NebiusLlmProviderConfig {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

/**
 * Nebius Token Factory (formerly AI Studio) inference adapter. Nebius
 * exposes an OpenAI-compatible API at `api.studio.nebius.com/v1`, so we
 * reuse the `openai` SDK with `baseURL` overridden.
 *
 * Supports the same `complete` and `completeStructured` paths as the
 * OpenAI adapter. Structured output uses `response_format.json_schema`
 * with `strict: true` — Nebius's compatibility layer enforces it
 * server-side for models that support it (Llama-3.3-70B-Instruct is
 * known-good). Models without strict-schema support will fall back to
 * the model's best-effort JSON generation, which the adapter still
 * parses but cannot guarantee.
 */
export class NebiusLlmProvider implements LlmProvider {
  readonly type = "nebius";

  private client: OpenAI;
  private defaultModel: string;

  constructor(config: NebiusLlmProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env.NEBIUS_API_KEY;
    if (!apiKey) {
      throw new Error("NebiusLlmProvider: NEBIUS_API_KEY missing");
    }
    this.client = new OpenAI({
      apiKey,
      baseURL:
        config.baseURL ?? process.env.NEBIUS_BASE_URL ?? DEFAULT_BASE_URL,
      timeout: config.timeoutMs ?? 30_000,
    });
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Use legacy `max_tokens` instead of OpenAI 6's `max_completion_tokens`:
    // Nebius's `-fast` model variants (Qwen3.5-397B-A17B-fast,
    // DeepSeek-V3.2-fast, etc.) use strict request validation and reject
    // `max_completion_tokens` as an unknown field. `max_tokens` is
    // deprecated in upstream OpenAI but universally accepted across the
    // Nebius catalog. Confirmed via curl probes 2026-06-11.
    const response = await this.client.chat.completions.create({
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.2,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    });
    const choice = response.choices[0];
    return {
      text: choice?.message.content ?? "",
      usage: buildUsage(response),
      stop_reason: choice?.finish_reason ?? undefined,
    };
  }

  async completeStructured<T>(
    req: LlmStructuredRequest,
  ): Promise<LlmStructuredResponse<T>> {
    const response = await this.client.chat.completions.create({
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: req.schema_name,
          description: req.schema_description,
          schema: req.schema,
          strict: true,
        },
      },
    });
    const choice = response.choices[0];
    const text = choice?.message.content ?? "{}";
    return {
      value: JSON.parse(text) as T,
      usage: buildUsage(response),
      stop_reason: choice?.finish_reason ?? undefined,
    };
  }
}

function buildUsage(response: OpenAI.Chat.Completions.ChatCompletion): LlmUsage {
  return {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
    model: response.model,
  };
}
