import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { colors, fonts } from "../theme";

// Title card: brand tag · headline · supporting line · feature ticker.

export const LaunchIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const tagSpring = spring({ frame, fps, config: { damping: 18, stiffness: 130 } });
  const titleSpring = spring({ frame: frame - 8, fps, config: { damping: 16, stiffness: 110 } });
  const subOpacity = interpolate(frame, [30, 50], [0, 1], { extrapolateRight: "clamp" });
  const tickerOpacity = interpolate(frame, [60, 80], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28
      }}
    >
      <div
        style={{
          fontFamily: fonts.mono,
          color: colors.accent,
          fontSize: 26,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          opacity: tagSpring,
          transform: `translateY(${(1 - tagSpring) * 10}px)`
        }}
      >
        Beevibe
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          color: colors.fg,
          fontSize: 104,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          textAlign: "center",
          maxWidth: 1500,
          lineHeight: 1.04,
          transform: `translateY(${(1 - titleSpring) * 30}px)`,
          opacity: titleSpring
        }}
      >
        The agent-native<br />
        operating system for teams.
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          color: colors.muted,
          fontSize: 30,
          fontWeight: 400,
          maxWidth: 1300,
          textAlign: "center",
          opacity: subOpacity
        }}
      >
        One workspace. People and AI agents. Shared memory. Real handoffs.
      </div>
      <div
        style={{
          marginTop: 28,
          fontFamily: fonts.mono,
          color: colors.primary,
          fontSize: 18,
          letterSpacing: "0.20em",
          textTransform: "uppercase",
          opacity: tickerOpacity
        }}
      >
        Assign · Automate · Ask · Negotiate · Escalate
      </div>
    </AbsoluteFill>
  );
};
