import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { colors, fonts } from "./theme";

// Per-scene chrome: top-left scene number + title strip, top-right brand,
// bottom hairline, dark background. Content goes in `children`; absolute-
// positioned Callouts sit on top of it.

type Props = {
  number: string;          // "01"
  title: string;           // "Shared workspace"
  subtitle?: string;       // "People + agents, one surface"
  brand?: string;          // top-right strip
  children: React.ReactNode;
};

export const SceneFrame: React.FC<Props> = ({
  number,
  title,
  subtitle,
  brand = "Beevibe / Launch reel",
  children
}) => {
  const frame = useCurrentFrame();

  // Strip fades in over 12 frames at the start of every scene so cuts
  // don't feel abrupt.
  const stripOpacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      <AbsoluteFill>{children}</AbsoluteFill>

      {/* Top strip */}
      <div
        style={{
          position: "absolute",
          top: 32,
          left: 48,
          right: 48,
          display: "flex",
          alignItems: "baseline",
          gap: 18,
          opacity: stripOpacity,
          fontFamily: fonts.mono,
          color: colors.muted,
          fontSize: 18,
          letterSpacing: "0.12em",
          textTransform: "uppercase"
        }}
      >
        <span style={{ color: colors.accent, fontWeight: 700 }}>{number}</span>
        <span style={{ color: colors.fg, fontWeight: 600 }}>{title}</span>
        {subtitle ? <span>· {subtitle}</span> : null}
        <span style={{ marginLeft: "auto", color: colors.muted, opacity: 0.6 }}>
          {brand}
        </span>
      </div>

      {/* Bottom hairline */}
      <div
        style={{
          position: "absolute",
          left: 48,
          right: 48,
          bottom: 24,
          height: 1,
          backgroundColor: colors.border,
          opacity: stripOpacity
        }}
      />
    </AbsoluteFill>
  );
};
