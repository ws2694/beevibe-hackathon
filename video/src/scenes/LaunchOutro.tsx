import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { colors, fonts } from "../theme";

// Closing card: CTA + clone command + license tag.

export const LaunchOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: { damping: 16, stiffness: 110 } });
  const cmdOpacity = interpolate(frame, [22, 40], [0, 1], { extrapolateRight: "clamp" });
  const linkOpacity = interpolate(frame, [50, 70], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 36
      }}
    >
      <div
        style={{
          fontFamily: fonts.mono,
          color: colors.accent,
          fontSize: 22,
          letterSpacing: "0.28em",
          textTransform: "uppercase",
          opacity: cmdOpacity
        }}
      >
        Beevibe
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          color: colors.fg,
          fontSize: 80,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          textAlign: "center",
          maxWidth: 1500,
          lineHeight: 1.05,
          transform: `translateY(${(1 - headlineSpring) * 30}px)`,
          opacity: headlineSpring
        }}
      >
        Where your team<br />and its agents work together.
      </div>

      <div
        style={{
          fontFamily: fonts.mono,
          color: colors.fg,
          fontSize: 26,
          padding: "18px 30px",
          backgroundColor: colors.bgAlt,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          opacity: cmdOpacity
        }}
      >
        <span style={{ color: colors.primary }}>$</span>{" "}
        git clone github.com/beevibe-ai/beevibe
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          opacity: linkOpacity
        }}
      >
        <div
          style={{
            fontFamily: fonts.mono,
            color: colors.accent,
            fontSize: 38,
            fontWeight: 600
          }}
        >
          beevibe.ai
        </div>
        <div
          style={{
            fontFamily: fonts.sans,
            color: colors.muted,
            fontSize: 20,
            letterSpacing: "0.18em",
            textTransform: "uppercase"
          }}
        >
          Open source · Apache-2.0 · Self-hosted
        </div>
      </div>
    </AbsoluteFill>
  );
};
