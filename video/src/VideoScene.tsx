import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import { SceneFrame } from "./SceneFrame";
import { Callout } from "./Callout";
import { CLIP_FRAME, ClipCrop, colors, computeClipStyle, fonts, secondsToFrames } from "./theme";

// Generic scene for the launch reel: plays a landscape product-demo clip
// in a centered framed window, with a feature headline beneath the clip
// and 1-3 floating Callouts in the side gutters to walk the viewer
// through what's happening on screen.

export type CalloutSpec = {
  startSec: number;
  durationSec: number;
  position: { top?: number; bottom?: number; left?: number; right?: number };
  text: string;
  caret?: "left" | "right" | "top" | "bottom" | "none";
  variant?: "info" | "success" | "warn";
  maxWidth?: number;
};

type Props = {
  number: string;
  title: string;
  subtitle?: string;
  clipFile: string;                // staticFile-relative path, e.g. "clips/foo.mov"
  clipStartSec: number;            // in-point in the source clip
  durationSec: number;             // length of this scene (== Sequence duration / fps)
  playbackRate?: number;           // speed up the source clip (>1 = faster); default 1
  headline: string;
  subhead?: string;
  callouts?: CalloutSpec[];
  crop?: ClipCrop;                 // per-clip edge crop (% per side); defaults to top:13 chrome
};

export const VideoScene: React.FC<Props> = ({
  number,
  title,
  subtitle,
  clipFile,
  clipStartSec,
  durationSec,
  playbackRate = 1,
  headline,
  subhead,
  callouts = [],
  crop = { top: 13 }
}) => {
  const { aspectRatio, videoStyle } = computeClipStyle(crop);
  // Source span consumed = durationSec * playbackRate. With rate > 1 we
  // need a longer source window than the scene wall-clock to keep the
  // video playing through the full scene.
  const sourceSpanSec = durationSec * playbackRate;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Headline fades up after a short beat so the viewer registers the clip
  // first, then the line that says what they're looking at.
  const headlineOpacity = interpolate(frame, [12, 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });

  // Tail fade so cuts between scenes feel like a soft dip rather than a hard cut.
  const totalFrames = secondsToFrames(durationSec);
  const tail = interpolate(
    frame,
    [totalFrames - 10, totalFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <SceneFrame number={number} title={title} subtitle={subtitle}>
      <AbsoluteFill style={{ opacity: tail }}>
        {/* Clip — positioned near the top so headline has room below.
            Container is more landscape than source (cropped chrome); the
            video uses cover + bottom-anchor to discard the browser chrome
            that the recording captured at the top. */}
        <div
          style={{
            position: "absolute",
            top: 90,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center"
          }}
        >
          <div
            style={{
              height: CLIP_FRAME.height,
              aspectRatio,
              borderRadius: CLIP_FRAME.cornerRadius,
              overflow: "hidden",
              position: "relative",
              boxShadow: CLIP_FRAME.shadow,
              backgroundColor: colors.bgAlt
            }}
          >
            <OffthreadVideo
              src={staticFile(clipFile)}
              startFrom={Math.round(clipStartSec * fps)}
              endAt={Math.round((clipStartSec + sourceSpanSec) * fps)}
              playbackRate={playbackRate}
              muted
              style={videoStyle}
            />
          </div>
        </div>

        {/* Headline strip below the clip */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            opacity: headlineOpacity
          }}
        >
          <div
            style={{
              fontFamily: fonts.sans,
              color: colors.fg,
              fontSize: 38,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              textAlign: "center"
            }}
          >
            {headline}
          </div>
          {subhead ? (
            <div
              style={{
                fontFamily: fonts.sans,
                color: colors.muted,
                fontSize: 22,
                fontWeight: 400,
                textAlign: "center"
              }}
            >
              {subhead}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>

      {callouts.map((c, i) => (
        <Callout
          key={i}
          startFrame={secondsToFrames(c.startSec)}
          durationFrames={secondsToFrames(c.durationSec)}
          position={c.position}
          text={c.text}
          caret={c.caret ?? "left"}
          variant={c.variant ?? "info"}
          maxWidth={c.maxWidth ?? 320}
        />
      ))}
    </SceneFrame>
  );
};
