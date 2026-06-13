/**
 * Real-time trajectory tailer for OpenClaw sessions.
 *
 * OpenClaw doesn't stream events on stdout — it writes them line-by-line
 * to a per-session JSONL file at
 *   ~/.openclaw/agents/<agent>/sessions/<uuid>.trajectory.jsonl
 *
 * We tail this file while the subprocess is alive, parse each event, and
 * call `onStep` so the agent-session layer can persist them to
 * `session_event`. This is the OpenClaw equivalent of what the Claude
 * Code / Codex / OpenCode adapters do with their stream-json stdout
 * parsers — same outcome, different transport.
 *
 * Two-phase operation:
 *
 *   Phase 1 — Discovery
 *     We don't know the session UUID before the spawn — OpenClaw derives
 *     it. So we snapshot the contents of the sessions dir BEFORE spawning
 *     and poll for any new `*.trajectory.jsonl` file that appears
 *     afterward. The newest one is ours.
 *
 *   Phase 2 — Tail
 *     Once discovered, we re-read the file and walk new bytes since the
 *     last poll. Each new line gets JSON-parsed and converted to one or
 *     more RuntimeStep events.
 *
 * Stops when the abort signal fires (subprocess exited or was cancelled).
 * The caller awaits this and we drain any final lines before returning.
 */

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeStep } from "../../ports/runtime.js";
import type { SessionEventKind } from "../../domain/session.js";

const POLL_INTERVAL_MS = 200;

export interface TrajectoryTailerOptions {
  /** Default: `<homedir>/.openclaw/agents/beevibe/sessions`. */
  sessionsDir?: string;
  /** Steps are emitted via this callback as new trajectory lines arrive. */
  onStep: (step: RuntimeStep) => void;
  /** Stops the tailer (e.g. when the subprocess exits). */
  abortSignal?: AbortSignal;
}

const DEFAULT_SESSIONS_DIR = join(
  homedir(),
  ".openclaw",
  "agents",
  "beevibe",
  "sessions",
);

/**
 * Start tailing. Returns a promise that resolves when the abort fires
 * (so callers can await it as a cleanup hook). Tailer drains any final
 * lines from the trajectory file on shutdown.
 */
export async function tailTrajectory(
  opts: TrajectoryTailerOptions,
): Promise<void> {
  const dir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  const before = await snapshotDir(dir);
  let trajectoryFile: string | undefined;
  let position = 0;
  let lastMessageIndex = 0;

  const isAborted = (): boolean => opts.abortSignal?.aborted ?? false;

  // Phase 1 — discovery
  while (!trajectoryFile && !isAborted()) {
    const current = await snapshotDir(dir);
    const fresh = [...current].filter(
      (f) => f.endsWith(".trajectory.jsonl") && !before.has(f),
    );
    if (fresh.length > 0) {
      fresh.sort();
      trajectoryFile = join(dir, fresh[fresh.length - 1]!);
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!trajectoryFile) return;

  // Phase 2 — tail until abort, then one final read to capture trailing lines.
  while (!isAborted()) {
    const update = await readNew(trajectoryFile, position);
    if (update.bytesRead > 0) {
      lastMessageIndex = emitNewLines(
        update.newContent,
        lastMessageIndex,
        opts.onStep,
      );
      position = update.totalSize;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Final drain.
  const final = await readNew(trajectoryFile, position);
  if (final.bytesRead > 0) {
    emitNewLines(final.newContent, lastMessageIndex, opts.onStep);
  }
}

// ─────────────────────────────────────────────────────────────────────

async function snapshotDir(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

interface ReadUpdate {
  newContent: string;
  bytesRead: number;
  totalSize: number;
}

async function readNew(path: string, fromPosition: number): Promise<ReadUpdate> {
  try {
    const full = await readFile(path, "utf-8");
    if (full.length <= fromPosition) {
      return { newContent: "", bytesRead: 0, totalSize: full.length };
    }
    return {
      newContent: full.slice(fromPosition),
      bytesRead: full.length - fromPosition,
      totalSize: full.length,
    };
  } catch {
    return { newContent: "", bytesRead: 0, totalSize: fromPosition };
  }
}

/**
 * Walk new JSONL lines and emit RuntimeSteps. Returns the updated
 * `lastMessageIndex` so the next call only emits incrementally-new
 * messages from each `model.completed` event's snapshot.
 */
function emitNewLines(
  newContent: string,
  lastMessageIndex: number,
  onStep: (step: RuntimeStep) => void,
): number {
  let cursor = lastMessageIndex;
  for (const line of newContent.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    cursor = emitEvent(parsed, cursor, onStep);
  }
  return cursor;
}

/**
 * Convert one trajectory event into 0+ RuntimeSteps and emit them.
 * Returns the new `lastMessageIndex`.
 *
 * Exported for unit testing.
 */
export function emitEvent(
  evt: Record<string, unknown>,
  lastMessageIndex: number,
  onStep: (step: RuntimeStep) => void,
): number {
  const ts = typeof evt.ts === "string" ? evt.ts : new Date().toISOString();
  const type = typeof evt.type === "string" ? evt.type : "";

  if (type === "session.started") {
    const modelId = pickStr(evt, "modelId");
    onStep({
      kind: "agent",
      description: modelId
        ? `Session started — ${modelId}`
        : "Session started",
      timestamp: ts,
    });
    return lastMessageIndex;
  }

  if (type === "model.completed") {
    const data = isRecord(evt.data) ? evt.data : {};
    const msgs = Array.isArray(data.messagesSnapshot)
      ? data.messagesSnapshot
      : [];
    let cursor = lastMessageIndex;
    for (let i = lastMessageIndex; i < msgs.length; i++) {
      const m = msgs[i];
      if (!isRecord(m)) continue;
      const role = typeof m.role === "string" ? m.role : "";
      const content = m.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!isRecord(c)) continue;
          const blockType = typeof c.type === "string" ? c.type : "";
          if (blockType === "text" && role === "assistant") {
            const txt = typeof c.text === "string" ? c.text : "";
            if (txt.trim().length > 0) {
              onStep({ kind: "agent", description: txt, timestamp: ts });
            }
          } else if (blockType === "toolCall" || blockType === "tool_use") {
            const name =
              typeof c.name === "string" ? c.name : "(unknown_tool)";
            const args = isRecord(c.arguments)
              ? c.arguments
              : isRecord(c.input)
                ? c.input
                : {};
            onStep({
              kind: "tool_call",
              tool: name,
              description: jsonOneLine(args, 200),
              timestamp: ts,
            });
          } else if (
            blockType === "tool_result" ||
            blockType === "toolResult"
          ) {
            const text = pickToolResultText(c);
            onStep({
              kind: "tool_result",
              tool: typeof c.tool_name === "string" ? c.tool_name : undefined,
              description: text.slice(0, 300),
              timestamp: ts,
            });
          }
        }
      }
      // The `toolResult` ROLE (not block type) — OpenClaw also emits
      // tool results as top-level messages with role="toolResult".
      if (role === "toolResult") {
        const text = Array.isArray(content)
          ? content
              .map((c) =>
                isRecord(c) && typeof c.text === "string" ? c.text : "",
              )
              .join("")
          : typeof content === "string"
            ? content
            : "";
        if (text.trim().length > 0) {
          onStep({
            kind: "tool_result",
            description: text.slice(0, 300),
            timestamp: ts,
          });
        }
      }
      cursor = i + 1;
    }
    return cursor;
  }

  if (type === "session.ended") {
    onStep({
      kind: "summary" satisfies SessionEventKind,
      description: "Session ended",
      timestamp: ts,
    });
  }

  return lastMessageIndex;
}

// ─────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function pickToolResultText(c: Record<string, unknown>): string {
  const v = c.content;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((x) =>
        isRecord(x) && typeof x.text === "string" ? x.text : JSON.stringify(x),
      )
      .join("");
  }
  return JSON.stringify(v);
}

function jsonOneLine(obj: unknown, maxLen: number): string {
  const s = JSON.stringify(obj);
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
