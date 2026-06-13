-- Cache table linking Slack identity to a beevibe person.
-- Populated dynamically by the Composio Slack inbound handler on first
-- DM/@mention via the email bridge (Slack email -> person.email match).
-- Never seeded manually. Drops if all linked persons are deleted via CASCADE.

CREATE TABLE slack_person_link (
  workspace_id   TEXT NOT NULL,                          -- Slack team_id (T_xxx)
  slack_user_id  TEXT NOT NULL,                          -- Slack user id (U_xxx)
  person_id      TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, slack_user_id)
);

-- Reverse lookup: "which slack identities are linked to this person?"
-- Useful for debugging and future multi-workspace mapping.
CREATE INDEX idx_slack_person_link_person ON slack_person_link(person_id);
