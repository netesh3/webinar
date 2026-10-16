/* Retention for finished bot conversations.
 *
 * crm_bot_sessions keeps a row for every conversation a contact ever had with a bot.
 * A finished one (done, handoff, stopped) is read for two things only:
 *   - the retry guard in the inbound path, which compares Meta's redelivery with the
 *     newest session's last_wamid. Meta stops redelivering within days, and with no
 *     session at all a new message starts a bot exactly as a finished one does;
 *   - the bot page's per-state counts, which are lifetime totals.
 * So finished sessions are deleted 30 days after they ended (store.PruneFinishedBotSessions),
 * and each one deleted is added to its bot's pruned_* counter in the same statement, which
 * the counts include. The bot's recent-sessions list keeps showing the last month.
 *
 * crm_drip_enrollments is deliberately not pruned: its unique (drip_id, contact_id) row is
 * what stops a sequence restarting for somebody who already went through it, and the drip
 * page's sent/failed totals are read through it (and notifications cascade from it).
 */
ALTER TABLE crm_bots
    ADD COLUMN pruned_done integer NOT NULL DEFAULT 0,
    ADD COLUMN pruned_handoff integer NOT NULL DEFAULT 0,
    ADD COLUMN pruned_stopped integer NOT NULL DEFAULT 0;

CREATE INDEX crm_bot_sessions_finished ON crm_bot_sessions (updated_at)
    WHERE state IN ('done', 'handoff', 'stopped');
