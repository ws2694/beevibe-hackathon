import { useEffect, useState } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { LaunchIntro } from "./scenes/LaunchIntro";
import { ProblemFrame } from "./scenes/ProblemFrame";
import { LaunchOutro } from "./scenes/LaunchOutro";
import { VideoScene } from "./VideoScene";
import { CLIPS, SCENE_SECONDS, colors, secondsToFrames } from "./theme";

const introF = secondsToFrames(SCENE_SECONDS.intro);
const problemF = secondsToFrames(SCENE_SECONDS.problem);
const generalF = secondsToFrames(SCENE_SECONDS.general);
const assignF = secondsToFrames(SCENE_SECONDS.assign);
const askF = secondsToFrames(SCENE_SECONDS.ask);
const negotiateF = secondsToFrames(SCENE_SECONDS.negotiate);
const escalationF = secondsToFrames(SCENE_SECONDS.escalation);
const outroF = secondsToFrames(SCENE_SECONDS.outro);

const at = {
  intro: 0,
  problem: introF,
  general: introF + problemF,
  assign: introF + problemF + generalF,
  ask: introF + problemF + generalF + assignF,
  negotiate: introF + problemF + generalF + assignF + askF,
  escalation: introF + problemF + generalF + assignF + askF + negotiateF,
  outro: introF + problemF + generalF + assignF + askF + negotiateF + escalationF
};

export const TOTAL_FRAMES = at.outro + outroF;

// Audio bed files (both optional — drop them in public/ when ready):
//   - public/voiceover.wav  — narration; generate with scripts/generate-vo.py
//   - public/music.mp3      — background music bed (any royalty-free loop)
// Each Audio element only mounts after a HEAD probe confirms the file
// exists — otherwise mediabunny throws a 404 into Studio's error overlay.
const MUSIC_FILE = "music.mp3";
const VO_FILE = "voiceover.wav";

const useFileExists = (url: string) => {
  const [exists, setExists] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    fetch(url, { method: "HEAD" })
      .then((res) => {
        if (!cancelled) setExists(res.ok);
      })
      .catch(() => {
        if (!cancelled) setExists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return exists;
};

export const BeevibeLaunch: React.FC<{ music?: boolean }> = ({ music = true }) => {
  const musicUrl = staticFile(MUSIC_FILE);
  const voUrl = staticFile(VO_FILE);
  const hasMusic = useFileExists(musicUrl);
  const hasVO = useFileExists(voUrl);

  // Auto-duck music when narration is present so the voice stays on top.
  const musicVolume = hasVO ? 0.08 : 0.18;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      {hasVO ? <Audio src={voUrl} volume={1.0} /> : null}
      {music && hasMusic ? <Audio src={musicUrl} volume={musicVolume} /> : null}

      <Sequence from={at.intro} durationInFrames={introF} name="Intro">
        <LaunchIntro />
      </Sequence>

      <Sequence from={at.problem} durationInFrames={problemF} name="Problem">
        <ProblemFrame />
      </Sequence>

      <Sequence from={at.general} durationInFrames={generalF} name="01 · Shared workspace">
        <VideoScene
          number="01"
          title="Shared workspace"
          subtitle="People + agents, one surface"
          clipFile={CLIPS.general.file}
          clipStartSec={CLIPS.general.startSec}
          durationSec={CLIPS.general.durationSec}
          playbackRate={CLIPS.general.playbackRate}
          crop={CLIPS.general.crop}
          headline="One workspace. People and AI agents."
          subhead="Agents, Memory, Mesh, Tasks — shared by the whole team."
          callouts={[
            {
              startSec: 2,
              durationSec: 6,
              position: { top: 150, right: 80 },
              text: "Every agent on the team — same surface as people.",
              variant: "info"
            },
            {
              startSec: 10,
              durationSec: 6,
              position: { bottom: 240, left: 80 },
              text: "Sessions, runtime, review policy — configurable per agent.",
              caret: "right",
              variant: "success"
            }
          ]}
        />
      </Sequence>

      <Sequence from={at.assign} durationInFrames={assignF} name="02 · Assign & automate">
        <VideoScene
          number="02"
          title="Assign & automate"
          subtitle="One ask, three specialists, three tasks live"
          clipFile={CLIPS.assign.file}
          clipStartSec={CLIPS.assign.startSec}
          durationSec={CLIPS.assign.durationSec}
          playbackRate={CLIPS.assign.playbackRate}
          crop={CLIPS.assign.crop}
          headline="Tasks split, scoped, and dispatched — live."
          subhead="Positioning · Growth · Brand — three tasks minted in seconds."
          callouts={[
            {
              startSec: 1,
              durationSec: 5,
              position: { top: 150, right: 80 },
              text: "Three specialists picked, three tasks minted.",
              variant: "info"
            },
            {
              startSec: 8,
              durationSec: 5,
              position: { bottom: 240, left: 80 },
              text: "Each agent runs its own session — in parallel.",
              caret: "right",
              variant: "info"
            },
            {
              startSec: 13,
              durationSec: 4,
              position: { bottom: 240, right: 80 },
              text: "Kanban — three tasks in progress, no babysitting.",
              variant: "success"
            }
          ]}
        />
      </Sequence>

      <Sequence from={at.ask} durationInFrames={askF} name="03 · Mesh ask">
        <VideoScene
          number="03"
          title="Mesh ask"
          subtitle="Agents reach out to other agents"
          clipFile={CLIPS.ask.file}
          clipStartSec={CLIPS.ask.startSec}
          durationSec={CLIPS.ask.durationSec}
          playbackRate={CLIPS.ask.playbackRate}
          crop={CLIPS.ask.crop}
          headline="Need cross-team context? Ask another agent."
          subhead="The mesh routes the question and brings the answer back."
          callouts={[
            {
              startSec: 1,
              durationSec: 5,
              position: { top: 150, right: 80 },
              text: "Agent reads code, surveys the team — gets to work.",
              variant: "info"
            },
            {
              startSec: 7,
              durationSec: 5,
              position: { bottom: 240, left: 80 },
              text: "\"Asked another agent\" — mesh routes the hop.",
              caret: "right",
              variant: "info"
            },
            {
              startSec: 11,
              durationSec: 3,
              position: { bottom: 240, right: 80 },
              text: "Answer lands inside the same thread.",
              variant: "success"
            }
          ]}
        />
      </Sequence>

      <Sequence from={at.negotiate} durationInFrames={negotiateF} name="04 · Mesh negotiate">
        <VideoScene
          number="04"
          title="Mesh negotiate"
          subtitle="Structured agent-to-agent alignment"
          clipFile={CLIPS.negotiate.file}
          clipStartSec={CLIPS.negotiate.startSec}
          durationSec={CLIPS.negotiate.durationSec}
          playbackRate={CLIPS.negotiate.playbackRate}
          crop={CLIPS.negotiate.crop}
          headline="When agents disagree, they negotiate — and converge."
          subhead="Proposal · counter · evidence · decision."
          callouts={[
            {
              startSec: 1,
              durationSec: 5,
              position: { top: 150, right: 80 },
              text: "Mesh negotiation flow — proposal & counter.",
              variant: "warn"
            },
            {
              startSec: 7,
              durationSec: 4,
              position: { bottom: 240, left: 80 },
              text: "Specific proposals, traced rounds — no deadlock.",
              caret: "right",
              variant: "info"
            },
            {
              startSec: 11,
              durationSec: 3,
              position: { bottom: 240, right: 80 },
              text: "Decisions land in shared memory — visible to the whole team.",
              variant: "success"
            }
          ]}
        />
      </Sequence>

      <Sequence from={at.escalation} durationInFrames={escalationF} name="05 · Escalation">
        <VideoScene
          number="05"
          title="Escalation"
          subtitle="You stay in the loop — by design"
          clipFile={CLIPS.escalation.file}
          clipStartSec={CLIPS.escalation.startSec}
          durationSec={CLIPS.escalation.durationSec}
          playbackRate={CLIPS.escalation.playbackRate}
          crop={CLIPS.escalation.crop}
          headline="When agents can't agree, you decide."
          subhead="Both positions side-by-side. Pick a proposal. Both sides resume."
          callouts={[
            {
              startSec: 1,
              durationSec: 5,
              position: { top: 150, right: 80 },
              text: "Marketing vs Backend — stuck on 2 of 5 positioning calls.",
              variant: "warn"
            },
            {
              startSec: 8,
              durationSec: 5,
              position: { bottom: 240, left: 80 },
              text: "Pick a proposal or write your own → Resolve & dispatch.",
              caret: "right",
              variant: "success"
            }
          ]}
        />
      </Sequence>

      <Sequence from={at.outro} durationInFrames={outroF} name="Outro">
        <LaunchOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
