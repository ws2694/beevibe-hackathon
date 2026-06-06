// Beevibe brand palette + typography. Mirrors the marketing site so the
// video reads as the same product.

export const colors = {
  bg: "#0d1117",
  bgAlt: "#161b22",
  fg: "#e6edf3",
  muted: "#9198a1",
  accent: "#facc15",       // Beevibe yellow (matches landing CTAs)
  accentSoft: "#fde68a",
  primary: "#3aada4",      // Beevibe teal (matches the brain node)
  border: "#30363d"
} as const;

export const fonts = {
  sans: "-apple-system, BlinkMacSystemFont, Inter, 'Segoe UI', Roboto, system-ui, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, ui-monospace, monospace"
} as const;

export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30
} as const;

export const secondsToFrames = (s: number) => Math.round(s * VIDEO.fps);

// --- BeevibeLaunch composition ---
//
// Demo & launch video covering: shared workspace overview → assign/automate
// tasks → mesh ask → mesh negotiate → escalation → CTA. Source clips live
// in public/clips/ as hardlinks to the developer's local Downloads folder.

// Total 93s (1:33). Adjust here AND mirror the values in SCRIPT.md's
// '## scene-name (Ns)' headers so the voiceover stays in sync.
export const SCENE_SECONDS = {
  intro: 5,
  problem: 6,
  general: 17,
  assign: 17,
  ask: 14,
  negotiate: 14,
  escalation: 14,
  outro: 6
} as const;

// Per-clip crop: % of source to chop off each edge. `top` defaults to 13
// (browser chrome). Override `left`/`right` per clip when the recording
// captured ugly window edges or sidebar elements you want to lose.
export type ClipCrop = {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
};

// `startSec` skips boring setup at the start of each source clip and
// puts the camera on the action. `playbackRate` (>1) compresses more
// source content into the scene window — viewers see the intermediate
// step AND the final output, not just the user typing.
//
// Effective source window per scene:  startSec → startSec + durationSec * playbackRate
// Uniform crop for all scenes: drop browser chrome (top) AND the Beevibe
// app sidebar (left — nav menu, "New chat" button, user avatar) plus the
// right-edge browser viewport line. The main content area (the part that
// actually shows the feature) ends up zoomed in and readable inside the
// landing-page carousel tile.
const STANDARD_CROP: ClipCrop = { top: 13, left: 18, right: 2 };

export const CLIPS = {
  general: {
    // Agents list → click into agent → recent sessions + CLI hookup.
    file: "clips/general_showing_wth_escalation.mov",
    startSec: 3,
    durationSec: SCENE_SECONDS.general,
    playbackRate: 1.5,
    crop: STANDARD_CROP
  },
  assign: {
    // Skip user typing. Open on the agent splitting work → "Minted a
    // task" ×3 → session detail → kanban with three in-progress.
    file: "clips/assign_task___task_automation.mov",
    startSec: 58,
    durationSec: SCENE_SECONDS.assign,
    playbackRate: 4,
    crop: STANDARD_CROP
  },
  ask: {
    // Skip user prompt. Open on agent reasoning + tool calls →
    // "Asked another agent" event → marketing answer comes back.
    file: "clips/mesh_ask.mov",
    startSec: 58,
    durationSec: SCENE_SECONDS.ask,
    playbackRate: 3.5,
    crop: STANDARD_CROP
  },
  negotiate: {
    // Skip user prompt + agent's ramp-up. Open on mesh negotiation flow →
    // "Negotiating with peer" → multiple rounds → shared Memory outcome.
    file: "clips/mesh_negotiate.mov",
    startSec: 85,
    durationSec: SCENE_SECONDS.negotiate,
    playbackRate: 7,
    crop: STANDARD_CROP
  },
  escalation: {
    // Source is only 38s total. 2× covers the entire clip — escalation
    // summary, both positions, Resolution UI.
    file: "clips/escalation_showcase.mov",
    startSec: 3,
    durationSec: SCENE_SECONDS.escalation,
    playbackRate: 2,
    crop: STANDARD_CROP
  }
} as const;

// Source clips are 2880×1800 landscape Retina screen recordings (display
// aspect ~16:10 after the .mov rotation matrix is applied). They include
// the browser chrome (tabs, address bar, Chinese "完成更新" extension
// button) and sometimes the window edges and sidebar avatar. Per-clip
// crop trims those off — see `crop` in CLIPS above and `computeClipStyle`
// below for how it's applied.
export const CLIP_FRAME = {
  height: 870,                              // px of canvas height the clip occupies
  cornerRadius: 18,
  shadow: "0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05) inset"
} as const;

// Source dimensions (display aspect after .mov rotation matrix).
const SOURCE_W = 2880;
const SOURCE_H = 1800;

// Compute the container aspect + video positioning CSS for a given crop.
// The container hides everything outside the visible region; the inner
// <video> is sized + offset so that the visible region exactly fills
// the container. No objectFit needed.
export const computeClipStyle = (crop: ClipCrop) => {
  const top = crop.top ?? 0;
  const right = crop.right ?? 0;
  const bottom = crop.bottom ?? 0;
  const left = crop.left ?? 0;
  const visW = 100 - left - right;
  const visH = 100 - top - bottom;

  // Container aspect: shape of the visible source region.
  const aspectRatio = `${visW * SOURCE_W} / ${visH * SOURCE_H}`;

  // Video sized up so its visible (post-crop) region matches container.
  // Both axes scale by the same factor since container aspect = visible aspect.
  const videoStyle = {
    position: "absolute" as const,
    width: `${(100 * 100) / visW}%`,
    height: `${(100 * 100) / visH}%`,
    left: `${-(left * 100) / visW}%`,
    top: `${-(top * 100) / visH}%`,
    objectFit: "fill" as const
  };

  return { aspectRatio, videoStyle };
};
