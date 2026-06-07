"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Mic,
  MicOff,
  PauseCircle,
  PhoneOff,
  PlayCircle,
} from "lucide-react";
import {
  api,
  type TeacherLanguage,
  type TeacherCharacterMode,
  type TeacherSessionResponse,
} from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { isApiConfigured } from "@/lib/api/config";

type SessionState = "idle" | "connecting" | "live" | "paused" | "error";

interface TranscriptEntry {
  id: string;
  role: "user" | "teacher";
  text: string;
  timestamp: Date;
}

interface PageContext {
  url: string;
  title: string;
  selection?: string;
  visible_text?: string;
  scroll_percent?: number;
}

const LANGUAGE_OPTIONS: { value: TeacherLanguage; label: string; native: string }[] = [
  { value: "zh-CN", label: "Mandarin (Simplified)", native: "普通话（简体）" },
  { value: "zh-TW", label: "Mandarin (Traditional)", native: "普通話（繁體）" },
  { value: "en", label: "English", native: "English" },
];

export function TeacherClient() {
  const [language, setLanguage] = useState<TeacherLanguage>("zh-CN");
  const [characterMode, setCharacterMode] = useState<TeacherCharacterMode>("simplified");
  const [pinyinEnabled, setPinyinEnabled] = useState(true);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [sessionConfig, setSessionConfig] = useState<TeacherSessionResponse | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Sync character mode default when language changes
  useEffect(() => {
    if (language === "zh-TW") setCharacterMode("traditional");
    else if (language === "zh-CN") setCharacterMode("simplified");
  }, [language]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript]);

  const appendTranscript = useCallback((role: "user" | "teacher", text: string) => {
    setTranscript((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role, text, timestamp: new Date() },
    ]);
  }, []);

  const teardown = useCallback(() => {
    micTrackRef.current?.stop();
    micTrackRef.current = null;
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    setSessionState("idle");
    setSessionConfig(null);
    setIsMuted(false);
  }, []);

  const startSession = useCallback(async () => {
    if (!isApiConfigured) return;
    setError(null);
    setSessionState("connecting");
    setTranscript([]);

    try {
      const config = await api.teacher.createSession({
        language,
        character_mode: characterMode,
        pinyin_enabled: pinyinEnabled,
        ...(pageContext ? { page_context: pageContext } : {}),
      });
      setSessionConfig(config);

      if (!config.realtime) {
        // API is configured but OpenAI Realtime isn't available (e.g. key lacks
        // Realtime access). Show the system prompt so the session is still useful
        // as a text reference.
        setSessionState("live");
        appendTranscript(
          "teacher",
          "Realtime audio isn't available — your system prompt is ready above. You can use the text transcript below to practice.",
        );
        return;
      }

      // WebRTC setup against OpenAI Realtime API
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Outbound audio → teacher hears the learner
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const [micTrack] = stream.getAudioTracks();
      micTrackRef.current = micTrack;
      pc.addTrack(micTrack);

      // Inbound audio → learner hears the teacher
      if (!audioRef.current) {
        audioRef.current = new Audio();
        audioRef.current.autoplay = true;
      }
      pc.ontrack = (e) => {
        if (audioRef.current) audioRef.current.srcObject = e.streams[0] ?? null;
      };

      // Data channel — receives transcript delta events from the model
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data as string) as Record<string, unknown>;
          handleRealtimeEvent(event, appendTranscript);
        } catch {
          // non-JSON frames are safe to ignore
        }
      };

      // SDP negotiation
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const { client_secret, model } = config.realtime;
      const sdpRes = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${client_secret.value}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        },
      );

      if (!sdpRes.ok) {
        throw new Error(`Realtime SDP exchange failed: ${sdpRes.status}`);
      }

      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setSessionState("live");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setSessionState("error");
      teardown();
    }
  }, [language, characterMode, pinyinEnabled, pageContext, appendTranscript, teardown]);

  const endSession = useCallback(() => {
    teardown();
  }, [teardown]);

  const togglePause = useCallback(() => {
    if (!micTrackRef.current) return;
    const next = sessionState === "live" ? "paused" : "live";
    micTrackRef.current.enabled = next === "live";
    setSessionState(next);
  }, [sessionState]);

  const toggleMute = useCallback(() => {
    if (!micTrackRef.current) return;
    const next = !isMuted;
    micTrackRef.current.enabled = !next;
    setIsMuted(next);
  }, [isMuted]);

  if (!isApiConfigured) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-md text-center text-sm text-muted-foreground">
          <BookOpen className="h-6 w-6 mx-auto mb-2 text-muted-foreground/60" />
          <div className="text-foreground font-medium mb-1">Teacher not connected</div>
          Set <span className="font-mono">NEXT_PUBLIC_BV_API_URL</span> in{" "}
          <span className="font-mono">.env.local</span> to start a lesson.
        </div>
      </div>
    );
  }

  const isRunning = sessionState === "live" || sessionState === "paused";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 border-b border-border/60 flex items-center gap-3">
        <BookOpen className="h-5 w-5 text-muted-foreground/70 shrink-0" />
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold tracking-tight">Mandarin Teacher</h1>
          <p className="text-xs text-muted-foreground/70 mt-0.5">
            Live audio tutor grounded in what you&apos;re reading
          </p>
        </div>
        {isRunning && (
          <SessionBadge state={sessionState} />
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: config + controls */}
        <div className="w-72 shrink-0 border-r border-border/60 flex flex-col overflow-y-auto">
          {!isRunning ? (
            <ConfigPanel
              language={language}
              setLanguage={setLanguage}
              characterMode={characterMode}
              setCharacterMode={setCharacterMode}
              pinyinEnabled={pinyinEnabled}
              setPinyinEnabled={setPinyinEnabled}
              pageContext={pageContext}
              setPageContext={setPageContext}
              onStart={startSession}
              loading={sessionState === "connecting"}
            />
          ) : (
            <LiveControls
              sessionConfig={sessionConfig}
              sessionState={sessionState}
              isMuted={isMuted}
              onTogglePause={togglePause}
              onToggleMute={toggleMute}
              onEnd={endSession}
              pageContext={pageContext}
              setPageContext={setPageContext}
            />
          )}
        </div>

        {/* Right panel: transcript */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* System prompt preview when session is live */}
          {sessionConfig && (
            <div className="px-5 pt-4 pb-3 border-b border-border/60">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/50 mb-1.5">
                Teacher persona
              </div>
              <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-3">
                {sessionConfig.system_prompt}
              </p>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="mx-5 mt-4 rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-xs">
              <div className="flex items-center gap-1.5 text-status-failed font-medium mb-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                Session error
              </div>
              <div className="text-muted-foreground">{error}</div>
            </div>
          )}

          {/* Transcript */}
          <div
            ref={transcriptRef}
            className="flex-1 overflow-y-auto px-5 py-4"
          >
            {transcript.length === 0 ? (
              <EmptyTranscript isRunning={isRunning} sessionState={sessionState} />
            ) : (
              <div className="space-y-3 max-w-2xl">
                {transcript.map((entry) => (
                  <TranscriptBubble key={entry.id} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionBadge({ state }: { state: SessionState }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        state === "live"
          ? "bg-green-500/10 text-green-600 dark:text-green-400"
          : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          state === "live" ? "bg-green-500 animate-pulse" : "bg-yellow-500",
        )}
      />
      {state === "live" ? "Live" : "Paused"}
    </div>
  );
}

function ConfigPanel({
  language,
  setLanguage,
  characterMode,
  setCharacterMode,
  pinyinEnabled,
  setPinyinEnabled,
  pageContext,
  setPageContext,
  onStart,
  loading,
}: {
  language: TeacherLanguage;
  setLanguage: (l: TeacherLanguage) => void;
  characterMode: TeacherCharacterMode;
  setCharacterMode: (m: TeacherCharacterMode) => void;
  pinyinEnabled: boolean;
  setPinyinEnabled: (v: boolean) => void;
  pageContext: PageContext | null;
  setPageContext: (ctx: PageContext | null) => void;
  onStart: () => void;
  loading: boolean;
}) {
  const isMandarin = language !== "en";

  return (
    <div className="flex flex-col gap-5 p-4">
      <Section title="Language">
        <div className="space-y-1">
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setLanguage(opt.value)}
              className={cn(
                "w-full text-left rounded-lg px-3 py-2 text-sm transition-colors",
                language === opt.value
                  ? "bg-secondary/70 text-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
              )}
            >
              <div>{opt.label}</div>
              <div className="text-[11px] text-muted-foreground/60 mt-0.5">{opt.native}</div>
            </button>
          ))}
        </div>
      </Section>

      {isMandarin && (
        <Section title="Mandarin options">
          <div className="space-y-3">
            <div>
              <div className="text-[11px] text-muted-foreground/60 mb-1.5">Characters</div>
              <div className="flex rounded-lg border border-border/60 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setCharacterMode("simplified")}
                  className={cn(
                    "flex-1 py-1.5 text-center transition-colors",
                    characterMode === "simplified"
                      ? "bg-secondary/70 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-secondary/40",
                  )}
                >
                  简体
                </button>
                <button
                  type="button"
                  onClick={() => setCharacterMode("traditional")}
                  className={cn(
                    "flex-1 py-1.5 text-center border-l border-border/60 transition-colors",
                    characterMode === "traditional"
                      ? "bg-secondary/70 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-secondary/40",
                  )}
                >
                  繁體
                </button>
              </div>
            </div>

            <Toggle
              label="Show pinyin"
              sublabel="romanization alongside characters"
              value={pinyinEnabled}
              onChange={setPinyinEnabled}
            />
          </div>
        </Section>
      )}

      <Section title="Page context (optional)">
        <PageContextInput pageContext={pageContext} setPageContext={setPageContext} />
      </Section>

      <button
        type="button"
        onClick={onStart}
        disabled={loading}
        className="mt-2 w-full rounded-xl bg-foreground text-background py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Connecting…" : "Start lesson"}
      </button>
    </div>
  );
}

function LiveControls({
  sessionConfig,
  sessionState,
  isMuted,
  onTogglePause,
  onToggleMute,
  onEnd,
  pageContext,
  setPageContext,
}: {
  sessionConfig: TeacherSessionResponse | null;
  sessionState: SessionState;
  isMuted: boolean;
  onTogglePause: () => void;
  onToggleMute: () => void;
  onEnd: () => void;
  pageContext: PageContext | null;
  setPageContext: (ctx: PageContext | null) => void;
}) {
  return (
    <div className="flex flex-col gap-5 p-4">
      {sessionConfig && (
        <Section title="Session">
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Language</span>
              <span className="text-foreground font-medium">
                {LANGUAGE_OPTIONS.find((o) => o.value === sessionConfig.language)?.label}
              </span>
            </div>
            {sessionConfig.language !== "en" && (
              <>
                <div className="flex items-center justify-between">
                  <span>Characters</span>
                  <span className="text-foreground font-medium">
                    {sessionConfig.character_mode === "simplified" ? "简体" : "繁體"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Pinyin</span>
                  <span className="text-foreground font-medium">
                    {sessionConfig.pinyin_enabled ? "On" : "Off"}
                  </span>
                </div>
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="Controls">
        <div className="space-y-2">
          <button
            type="button"
            onClick={onToggleMute}
            className={cn(
              "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
              isMuted
                ? "bg-status-failed/10 text-status-failed"
                : "bg-secondary/50 text-foreground hover:bg-secondary/70",
            )}
          >
            {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            {isMuted ? "Unmute mic" : "Mute mic"}
          </button>

          <button
            type="button"
            onClick={onTogglePause}
            className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm bg-secondary/50 text-foreground hover:bg-secondary/70 transition-colors"
          >
            {sessionState === "paused" ? (
              <PlayCircle className="h-4 w-4" />
            ) : (
              <PauseCircle className="h-4 w-4" />
            )}
            {sessionState === "paused" ? "Resume" : "Pause session"}
          </button>

          <button
            type="button"
            onClick={onEnd}
            className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm bg-status-failed/8 text-status-failed hover:bg-status-failed/15 transition-colors"
          >
            <PhoneOff className="h-4 w-4" />
            End session
          </button>
        </div>
      </Section>

      <Section title="Page context (optional)">
        <PageContextInput pageContext={pageContext} setPageContext={setPageContext} />
      </Section>

      <div className="mt-auto pt-2 text-[10px] text-muted-foreground/50 leading-relaxed">
        Password fields, cookies, local storage, and private tabs are never shared with the teacher.
      </div>
    </div>
  );
}

function PageContextInput({
  pageContext,
  setPageContext,
}: {
  pageContext: PageContext | null;
  setPageContext: (ctx: PageContext | null) => void;
}) {
  const [url, setUrl] = useState(pageContext?.url ?? "");
  const [title, setTitle] = useState(pageContext?.title ?? "");
  const [selection, setSelection] = useState(pageContext?.selection ?? "");

  const apply = () => {
    if (!url.trim()) {
      setPageContext(null);
      return;
    }
    setPageContext({
      url: url.trim(),
      title: title.trim() || url.trim(),
      selection: selection.trim() || undefined,
    });
  };

  return (
    <div className="space-y-2">
      <div>
        <label className="text-[11px] text-muted-foreground/60 block mb-1">Page URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={apply}
          placeholder="https://…"
          className="w-full rounded-md bg-secondary/40 border border-border/40 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40"
        />
      </div>
      <div>
        <label className="text-[11px] text-muted-foreground/60 block mb-1">Selected text</label>
        <textarea
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
          onBlur={apply}
          placeholder="Paste text you want to discuss…"
          rows={3}
          className="w-full rounded-md bg-secondary/40 border border-border/40 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40 resize-none"
        />
      </div>
      {pageContext && (
        <div className="text-[10px] text-green-600 dark:text-green-400">
          Context saved — teacher knows what you&apos;re reading.
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  sublabel,
  value,
  onChange,
}: {
  label: string;
  sublabel?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 bg-secondary/30 hover:bg-secondary/50 transition-colors text-left"
    >
      <div>
        <div className="text-sm text-foreground">{label}</div>
        {sublabel && <div className="text-[11px] text-muted-foreground/60">{sublabel}</div>}
      </div>
      <div
        className={cn(
          "h-5 w-9 rounded-full transition-colors shrink-0",
          value ? "bg-foreground" : "bg-border/60",
        )}
      >
        <div
          className={cn(
            "h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
            value ? "translate-x-4" : "translate-x-0",
          )}
        />
      </div>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/50 mb-2 px-1">
        {title}
      </div>
      {children}
    </div>
  );
}

function EmptyTranscript({
  isRunning,
  sessionState,
}: {
  isRunning: boolean;
  sessionState: SessionState;
}) {
  if (sessionState === "connecting") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground/60 italic">
        <span className="animate-pulse">Connecting to teacher…</span>
      </div>
    );
  }
  if (!isRunning) {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted-foreground/50 max-w-xs">
        <p>Configure your language settings on the left, then start a lesson.</p>
        <p className="text-xs">
          The teacher listens to your microphone and grounds explanations in the page you&apos;re
          reading.
        </p>
      </div>
    );
  }
  return (
    <div className="text-sm text-muted-foreground/50 italic">
      Session live — start speaking to begin.
    </div>
  );
}

function TranscriptBubble({ entry }: { entry: TranscriptEntry }) {
  const isUser = entry.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="h-6 w-6 rounded-full bg-secondary/70 flex items-center justify-center mr-2 shrink-0 mt-0.5">
          <BookOpen className="h-3 w-3 text-muted-foreground/70" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3.5 py-2 text-sm",
          isUser ? "glass-bubble-user" : "bg-secondary/40 text-foreground/90",
        )}
      >
        {entry.text}
      </div>
    </div>
  );
}

/**
 * Handles OpenAI Realtime API data channel events and extracts transcript text.
 * Relevant events: response.audio_transcript.delta, input_audio_buffer.speech_started, etc.
 */
function handleRealtimeEvent(
  event: Record<string, unknown>,
  appendTranscript: (role: "user" | "teacher", text: string) => void,
): void {
  const type = event.type as string | undefined;
  if (!type) return;

  if (type === "response.audio_transcript.delta") {
    const delta = event.delta as string | undefined;
    if (delta) appendTranscript("teacher", delta);
  } else if (type === "conversation.item.input_audio_transcription.completed") {
    const transcript = event.transcript as string | undefined;
    if (transcript) appendTranscript("user", transcript);
  }
}
