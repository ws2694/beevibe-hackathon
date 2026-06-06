import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useVideoConfig
} from "remotion";
import { ClipCrop, colors, computeClipStyle } from "./theme";

// Chrome-less scene used for the per-feature WebM exports. No scene strip,
// no headline, no callouts — just the cropped source clip, sized to fill
// the composition exactly. Use one of the `scene-<key>` compositions in
// Root.tsx to render these for embedding on the landing page / docs /
// README.

type Props = {
  clipFile: string;
  clipStartSec: number;
  durationSec: number;
  playbackRate?: number;
  crop?: ClipCrop;
};

export const BareScene: React.FC<Props> = ({
  clipFile,
  clipStartSec,
  durationSec,
  playbackRate = 1,
  crop = { top: 13 }
}) => {
  const { fps } = useVideoConfig();
  const { videoStyle } = computeClipStyle(crop);
  const sourceSpanSec = durationSec * playbackRate;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bgAlt,
        overflow: "hidden"
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
    </AbsoluteFill>
  );
};
