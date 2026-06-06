import { Composition } from "remotion";
import { BeevibeLaunch, TOTAL_FRAMES } from "./BeevibeLaunch";
import { BareScene } from "./BareScene";
import { CLIPS, ClipCrop, VIDEO, secondsToFrames } from "./theme";

// Compute composition dimensions for a chrome-less scene. The composition
// height matches the cropped clip's aspect at 1920px wide, rounded down
// to an even number (VP9 requires even pixel dimensions).
const dimsForCrop = (crop: ClipCrop) => {
  const visW = 100 - (crop.left ?? 0) - (crop.right ?? 0);
  const visH = 100 - (crop.top ?? 0) - (crop.bottom ?? 0);
  const aspect = (visW * 2880) / (visH * 1800);
  const width = 1920;
  const heightRaw = Math.round(width / aspect);
  const height = heightRaw % 2 === 0 ? heightRaw : heightRaw - 1;
  return { width, height };
};

// Generate one scene-<key> composition per feature, each cropped to its
// own aspect ratio. These render to WebM/VP9 for embedding in landing
// pages, docs, and READMEs.
const sceneKeys = ["general", "assign", "ask", "negotiate", "escalation"] as const;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="BeevibeLaunch"
        component={BeevibeLaunch}
        durationInFrames={TOTAL_FRAMES}
        fps={VIDEO.fps}
        width={VIDEO.width}
        height={VIDEO.height}
        defaultProps={{ music: true }}
      />
      {sceneKeys.map((key) => {
        const clip = CLIPS[key];
        const { width, height } = dimsForCrop(clip.crop);
        return (
          <Composition
            key={key}
            id={`scene-${key}`}
            component={BareScene}
            durationInFrames={secondsToFrames(clip.durationSec)}
            fps={VIDEO.fps}
            width={width}
            height={height}
            defaultProps={{
              clipFile: clip.file,
              clipStartSec: clip.startSec,
              durationSec: clip.durationSec,
              playbackRate: clip.playbackRate,
              crop: clip.crop
            }}
          />
        );
      })}
    </>
  );
};
