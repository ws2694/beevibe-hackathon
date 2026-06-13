import type { SlackPersonLink } from "../domain/slack-person-link.js";

export type NewSlackPersonLink = Omit<SlackPersonLink, "created_at">;

export interface SlackPersonLinkRepository {
  /** Cache hit lookup by composite key. */
  find(
    workspaceId: string,
    slackUserId: string,
  ): Promise<SlackPersonLink | undefined>;

  /**
   * Insert or update the link. Idempotent: re-linking the same Slack
   * identity to a different person_id updates the row (rare but valid
   * — supports correcting a mistaken match).
   */
  upsert(input: NewSlackPersonLink): Promise<SlackPersonLink>;
}
