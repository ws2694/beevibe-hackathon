import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { colors, fonts } from "./theme";

// A timed overlay that points at a moment in the underlying clip. Pass
// the frame offset (within the parent Sequence) when it should appear,
// how long it stays, and where on screen it sits. The component fades +
// springs in, holds, then fades out.

type Position = {
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
};

type Props = {
  startFrame: number;        // when the callout appears (frame offset within the scene)
  durationFrames: number;    // how long it stays visible
  position: Position;        // CSS positioning
  text: string;              // primary callout text
  caret?: "left" | "right" | "top" | "bottom" | "none";
  variant?: "info" | "success" | "warn";
  maxWidth?: number;         // default 320; raise for wider gutters
};

export const Callout: React.FC<Props> = ({
  startFrame,
  durationFrames,
  position,
  text,
  caret = "left",
  variant = "info",
  maxWidth = 320
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - startFrame;
  if (localFrame < -2 || localFrame > durationFrames + 8) return null;

  const fadeIn = spring({
    frame: localFrame,
    fps,
    config: { damping: 18, stiffness: 180 }
  });
  const fadeOut = interpolate(
    localFrame,
    [durationFrames - 6, durationFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const opacity = Math.min(fadeIn, fadeOut);

  const palette = {
    info: { bg: colors.bgAlt, border: colors.primary, text: colors.fg },
    success: { bg: colors.bgAlt, border: "#3fb950", text: colors.fg },
    warn: { bg: colors.bgAlt, border: "#f59e0b", text: colors.fg }
  }[variant];

  const caretGlyph = {
    left: "◂",
    right: "▸",
    top: "▴",
    bottom: "▾",
    none: ""
  }[caret];

  return (
    <div
      style={{
        position: "absolute",
        ...position,
        opacity,
        transform: `translateY(${(1 - fadeIn) * 10}px)`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderLeft: caret === "left" ? `4px solid ${palette.border}` : `1px solid ${palette.border}`,
        borderRight: caret === "right" ? `4px solid ${palette.border}` : `1px solid ${palette.border}`,
        padding: "14px 22px",
        borderRadius: 10,
        color: palette.text,
        fontFamily: fonts.sans,
        fontSize: 22,
        fontWeight: 500,
        maxWidth,
        boxShadow: "0 12px 36px rgba(0,0,0,0.45)",
        zIndex: 5
      }}
    >
      {caretGlyph && caret !== "right" ? (
        <span style={{ color: palette.border, fontSize: 26, lineHeight: 1 }}>{caretGlyph}</span>
      ) : null}
      <span>{text}</span>
      {caretGlyph && caret === "right" ? (
        <span style={{ color: palette.border, fontSize: 26, lineHeight: 1 }}>{caretGlyph}</span>
      ) : null}
    </div>
  );
};
