/**
 * Teacher browser session surface.
 *
 * POST /teacher/session
 *   Creates a teacher session config for a given language (default zh-CN).
 *   Mints an OpenAI Realtime ephemeral token so the browser can open a
 *   WebRTC audio session directly with the speech model — the secret never
 *   touches client-side code outside the short expiry window.
 *
 * The session carries:
 *   - Mandarin-specific system prompt (or English fallback)
 *   - character_mode: simplified | traditional
 *   - pinyin_enabled: include pinyin alongside characters
 *   - realtime: ephemeral client_secret + model + voice for WebRTC setup
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { RequestHandler } from "express";
import { requireHuman } from "../auth/middleware.js";

export type TeacherLanguage = "zh-CN" | "zh-TW" | "en";
export type CharacterMode = "simplified" | "traditional";

export interface TeacherSessionRequest {
  language?: TeacherLanguage;
  character_mode?: CharacterMode;
  pinyin_enabled?: boolean;
  page_context?: {
    url?: string;
    title?: string;
    selection?: string;
    visible_text?: string;
    focused_element?: string;
    scroll_percent?: number;
  };
}

export interface TeacherRealtimeConfig {
  client_secret: { value: string; expires_at: number };
  model: string;
  voice: string;
}

export interface TeacherSessionResponse {
  ok: true;
  session_id: string;
  language: TeacherLanguage;
  character_mode: CharacterMode;
  pinyin_enabled: boolean;
  system_prompt: string;
  realtime?: TeacherRealtimeConfig;
}

export interface TeacherRoutesDeps {
  authMiddleware: RequestHandler;
  openaiApiKey: string;
}

function buildMandarinPrompt(opts: {
  character_mode: CharacterMode;
  pinyin_enabled: boolean;
}): string {
  const charNote =
    opts.character_mode === "traditional"
      ? "Use Traditional Chinese characters (繁體中文)."
      : "Use Simplified Chinese characters (简体中文).";
  const pinyinNote = opts.pinyin_enabled
    ? "When you introduce a new word or phrase, always include pinyin romanization in parentheses immediately after the characters, e.g. 你好 (nǐ hǎo)."
    : "Do not include pinyin unless the learner explicitly asks for it.";

  return `You are a live Mandarin Chinese teacher sitting beside the learner while they browse.
Speak and respond primarily in Mandarin Chinese (普通话). ${charNote}
${pinyinNote}
Explain only what is grounded in the current page context. Keep turns short, conversational, and adaptive.
Prefer asking one small check-for-understanding question over giving a long lecture.
If the learner is reading Chinese text, clarify vocabulary, grammar patterns, or pronunciation.
If they are stuck, diagnose the missing prerequisite concept and teach it with a brief example.
When introducing new vocabulary, give the character, pinyin, and English meaning together.
Adjust your language level dynamically — use more English scaffolding for beginners, pure Mandarin for advanced learners.
Do not click, type, submit forms, purchase, log in, or navigate unless the learner explicitly asks you to take that action.`;
}

function buildEnglishPrompt(): string {
  return `You are a live audio teacher sitting beside the learner while they browse.
Explain only what is grounded in the current page context. Keep turns short, conversational, and adaptive.
Prefer asking one small check-for-understanding question over giving a long lecture.
If the learner is reading, clarify the next concept. If they are stuck, diagnose the missing prerequisite.
Do not click, type, submit forms, purchase, log in, or navigate unless the learner explicitly asks you to take that action.`;
}

async function mintRealtimeToken(opts: {
  apiKey: string;
  systemPrompt: string;
  language: TeacherLanguage;
  voice: string;
  model: string;
}): Promise<TeacherRealtimeConfig | undefined> {
  const body: Record<string, unknown> = {
    model: opts.model,
    voice: opts.voice,
    instructions: opts.systemPrompt,
  };

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[teacher] realtime token mint failed:", res.status, text);
      return undefined;
    }

    const data = (await res.json()) as {
      client_secret: { value: string; expires_at: number };
    };
    return {
      client_secret: data.client_secret,
      model: opts.model,
      voice: opts.voice,
    };
  } catch (err) {
    console.error("[teacher] realtime token mint error:", err);
    return undefined;
  }
}

export function createTeacherRouter(deps: TeacherRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.post("/session", async (req, res) => {
    if (!requireHuman(req, res)) return;

    const body = req.body as TeacherSessionRequest;
    const language: TeacherLanguage = body.language ?? "zh-CN";
    const character_mode: CharacterMode =
      body.character_mode ?? (language === "zh-TW" ? "traditional" : "simplified");
    const pinyin_enabled = body.pinyin_enabled ?? true;

    const system_prompt =
      language === "en"
        ? buildEnglishPrompt()
        : buildMandarinPrompt({ character_mode, pinyin_enabled });

    // Mandarin sessions use "shimmer" which handles tonal languages well.
    // English sessions default to "alloy".
    const voice = language.startsWith("zh") ? "shimmer" : "alloy";
    const model = "gpt-4o-realtime-preview-2024-12-17";

    const realtime = await mintRealtimeToken({
      apiKey: deps.openaiApiKey,
      systemPrompt: system_prompt,
      language,
      voice,
      model,
    });

    const response: TeacherSessionResponse = {
      ok: true,
      session_id: randomUUID(),
      language,
      character_mode,
      pinyin_enabled,
      system_prompt,
      ...(realtime ? { realtime } : {}),
    };

    res.json(response);
  });

  return router;
}
