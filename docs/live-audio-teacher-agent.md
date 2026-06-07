# Live Audio Teacher Browser Agent

Goal: a browser-side teacher that can talk with the user in real time while
grounding its explanations in the page, app, article, code review, chart, or
search result the user is currently viewing.

## Current Repo Foundation

BeeVibe can now detect and launch a `hermes` runtime through the local daemon.
The adapter runs Hermes in one-shot chat mode:

```bash
hermes chat --quiet --source beevibe --toolsets browser,web,terminal,skills -q "<prompt>"
```

Hermes still owns its own setup under `~/.hermes`: provider auth, Browser Use
credentials, browser/CDP settings, skills, memory, and MCP catalog. BeeVibe's job
is to select Hermes as a runtime and dispatch work to it.

Useful Hermes setup paths:

- Browser Use cloud: configure `BROWSER_USE_API_KEY` and set
  `browser.cloud_provider: browser-use` in Hermes.
- Local visible browser: attach Hermes to a Chromium-family browser through CDP
  when the teaching session should share the user's live browser identity.
- Camofox/noVNC: useful when the agent owns a visible browser session and the
  user watches it.

References:

- Hermes Browser Automation:
  https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/browser.md
- Browser Use Hermes integration:
  https://docs.browser-use.com/cloud/tutorials/integrations/hermes-agent
- Hermes CLI command reference:
  https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md

## Product Shape

There are three distinct loops:

1. Audio loop: browser UI connects to a realtime speech model over WebRTC. This
   is what makes the teacher feel live instead of like a chat turn.
2. Page-context loop: a browser extension, content script, or CDP attachment
   sends the current URL, title, selected text, focused element, visible text,
   accessibility snapshot, and optional screenshot thumbnail.
3. Agent loop: Hermes uses browser tools for deeper inspection or actions when
   the teacher needs more than the lightweight page context.

For the user's own current tab, start with a browser extension/content script.
Browser Use cloud is better when the agent should drive its own browser; it is
not enough by itself to know what the user is looking at in their personal tab.

## MVP Architecture

```text
Chrome/Brave extension
  -> captures current tab context on URL/scroll/selection/focus changes
  -> sends compact context events to Teacher API

Teacher web client
  -> captures microphone
  -> plays teacher audio
  -> sends page-context events over the realtime data channel

Teacher API
  -> mints short-lived realtime tokens
  -> stores the active lesson state
  -> dispatches Hermes turns for deep page inspection or browser actions

Hermes runtime
  -> browser_snapshot / browser_vision / browser_click / browser_type
  -> Browser Use cloud, local CDP, or Camofox depending on setup
```

## Teacher Prompt

Use this as the session-level teacher behavior:

```text
You are a live audio teacher sitting beside the learner while they browse.
Explain only what is grounded in the current page context. Keep turns short,
conversational, and adaptive. Prefer asking one small check-for-understanding
question over giving a long lecture. If the learner is reading, clarify the next
concept. If they are stuck, diagnose the missing prerequisite. Do not click,
type, submit forms, purchase, log in, or navigate unless the learner explicitly
asks you to take that action.
```

Context event shape:

```json
{
  "type": "page_context",
  "url": "https://example.com/article",
  "title": "Article title",
  "selection": "highlighted text if any",
  "visible_text": "compact visible text or accessibility snapshot",
  "focused_element": "search box, code block, chart, etc.",
  "scroll_percent": 42
}
```

## Build Order

1. Configure Hermes Browser Use or local CDP and verify:
   `hermes chat --toolsets browser,web,terminal,skills -q "open github.com/trending and summarize it"`.
2. Run `beevibe-daemon sync` so the daemon registers `hermes`, then bind a test
   agent to that runtime.
3. Add a minimal teacher API endpoint that creates a realtime audio session.
4. Add a teacher page with mic on/off, transcript, current page title, and a
   privacy pause.
5. Add a browser extension content script that streams compact context events.
6. Add a Hermes handoff path for "inspect this deeper" and "show me where" turns.

## Mandarin Language Support

The teacher ships with first-class Mandarin Chinese support. All session config
is passed to `POST /teacher/session`; the server builds the right system prompt
and mints an ephemeral OpenAI Realtime token.

### Session parameters

```json
{
  "language": "zh-CN",
  "character_mode": "simplified",
  "pinyin_enabled": true,
  "page_context": { "url": "...", "title": "...", "selection": "..." }
}
```

| Field | Values | Default |
|---|---|---|
| `language` | `zh-CN`, `zh-TW`, `en` | `zh-CN` |
| `character_mode` | `simplified`, `traditional` | `simplified` for zh-CN, `traditional` for zh-TW |
| `pinyin_enabled` | `true`, `false` | `true` |

### Mandarin teacher prompt

```text
You are a live Mandarin Chinese teacher sitting beside the learner while they browse.
Speak and respond primarily in Mandarin Chinese (普通话). Use Simplified Chinese
characters (简体中文). When you introduce a new word or phrase, always include pinyin
romanization in parentheses immediately after the characters, e.g. 你好 (nǐ hǎo).
Explain only what is grounded in the current page context. Keep turns short,
conversational, and adaptive. Prefer asking one small check-for-understanding question
over giving a long lecture. If the learner is reading Chinese text, clarify vocabulary,
grammar patterns, or pronunciation. If they are stuck, diagnose the missing prerequisite
concept and teach it with a brief example. When introducing new vocabulary, give the
character, pinyin, and English meaning together. Adjust your language level dynamically —
use more English scaffolding for beginners, pure Mandarin for advanced learners. Do not
click, type, submit forms, purchase, log in, or navigate unless the learner explicitly
asks you to take that action.
```

### Voice

Mandarin sessions use `shimmer` (handles tonal language well). English sessions default
to `alloy`. Model is `gpt-4o-realtime-preview-2024-12-17`.

### Browser WebRTC setup

1. `POST /teacher/session` → returns `realtime.client_secret.value` (short-lived token)
2. Browser creates `RTCPeerConnection`, adds mic track, creates `oai-events` data channel
3. Browser POSTs SDP offer to `https://api.openai.com/v1/realtime?model=<model>` with
   the ephemeral token as `Authorization: Bearer <token>`
4. Sets the SDP answer and the audio session begins
5. Data channel `oai-events` delivers transcript deltas:
   - `response.audio_transcript.delta` — teacher speech (text)
   - `conversation.item.input_audio_transcription.completed` — learner speech (text)

### Web UI route

`/teacher` — language picker, character/pinyin toggles, mic controls, and live transcript.

## Safety Defaults

- Never send password fields, hidden inputs, cookies, local storage, payment
  forms, or private/incognito tabs.
- Require explicit confirmation before browser actions.
- Keep page-context snapshots small and replace them on navigation instead of
  growing an unbounded transcript.
- Treat screenshots as opt-in because they can include private information that
  text extraction would skip.
