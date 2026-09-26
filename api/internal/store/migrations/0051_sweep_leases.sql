/* Leases for the background sweep: at most one runner per job, across instances.
 *
 * The sweep (reminders, drips, bots, outboxes, meeting limits) used to be a goroutine per
 * instance with nothing between them. Two warm Cloud Run instances — or an instance and
 * the Cloud Scheduler tick — could read the same due row in the same second and both send
 * it: a WhatsApp reminder charged twice and delivered twice.
 *
 * A row per job name, not a Postgres advisory lock: a session-level lock needs a held
 * session, which Supabase's transaction pooler (:6543, allowed by deploy/SUPABASE.md) does
 * not give, and a lock that leaks there is held by nobody and released by nothing. A lease
 * expires on its own, so an instance killed mid-pass (a scale-in, a redeploy) delays the
 * next pass by at most one TTL rather than stopping it for good.
 */
CREATE TABLE IF NOT EXISTS sweep_leases (
    name       text PRIMARY KEY,
    -- Random per acquisition, so release can only drop the lease it took.
    holder     text NOT NULL,
    expires_at timestamptz NOT NULL
);

REVOKE ALL ON sweep_leases FROM anon, authenticated, PUBLIC;
