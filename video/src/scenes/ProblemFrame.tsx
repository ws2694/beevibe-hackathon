import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { colors, fonts } from "../theme";

// Beat between the intro title and the first feature clip. States the
// problem in two contrasting lines so the rest of the video reads as
// the answer.

export const ProblemFrame: React.FC = () => {
  const frame = useCurrentFrame();

  const line1 = interpolate(frame, [4, 24], [0, 1], { extrapolateRight: "clamp" });
  const line2 = interpolate(frame, [60, 90], [0, 1], { extrapolateRight: "clamp" });
  const line3 = interpolate(frame, [140, 170], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 36,
        padding: "0 160px"
      }}
    >
      <div
        style={{
          fontFamily: fonts.sans,
          color: colors.muted,
          fontSize: 52,
          fontWeight: 500,
          textAlign: "center",
          opacity: line1
        }}
      >
        Your team uses AI every day.
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          color: colors.fg,
          fontSize: 64,
          fontWeight: 700,
          textAlign: "center",
          opacity: line2,
          letterSpacing: "-0.01em",
          lineHeight: 1.15
        }}
      >
        Your AI doesn't know your team.
      </div>
      <div
        style={{
          marginTop: 18,
          fontFamily: fonts.mono,
          color: colors.accent,
          fontSize: 22,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          opacity: line3
        }}
      >
        Beevibe fixes that.
      </div>
    </AbsoluteFill>
  );
};
