/**
 * Slack identity -> beevibe person mapping.
 *
 * Cache populated by the Composio Slack inbound handler. Composite key
 * (workspace_id, slack_user_id) so the same Slack user across multiple
 * workspaces maps to one row per workspace.
 */
export interface SlackPersonLink {
  /** Slack team_id (T_xxx). */
  workspace_id: string;
  /** Slack user id (U_xxx). */
  slack_user_id: string;
  /** beevibe person.id this Slack identity resolves to. */
  person_id: string;
  created_at: Date;
}
