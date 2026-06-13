-- Slack conversation -> last-spawned beevibe session for resume.
-- One row per visible Slack "thread" of conversation:
--   DM:                bucket='dm' (one rolling session per DM channel)
--   Channel + thread:  bucket=thread_ts
--   Channel + new @:   bucket=message_ts (the @-mention starts a thread)
--
-- The webhook handler looks this up before dispatching: a hit means the
-- next dispatch uses `chat_continuation` so the runtime resumes the
-- prior CLI session (--resume / --session-id).
--
-- prior_session_id is the beevibe sessionId (not cli_session_id) — the
-- dispatchService translates that into runtime-level resume_session_id
-- using its existing chat_continuation path.

CREATE TABLE slack_conversation_session (
  workspace_id      TEXT NOT NULL,                          -- Slack team_id
  channel           TEXT NOT NULL,                          -- D_xxx or C_xxx
  thread_bucket     TEXT NOT NULL,                          -- 'dm' | thread_ts | message_ts
  prior_session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, channel, thread_bucket)
);

CREATE INDEX idx_slack_conversation_session_prior
  ON slack_conversation_session(prior_session_id);
