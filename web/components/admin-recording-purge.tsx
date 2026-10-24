"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { RecordingPurgeConfirm } from "@/lib/api-types";
import type { RecordingPurgeStatus } from "@/lib/api-types";
import { gbText } from "@/lib/recording-retention";
import { purgeCanStart, purgeConfirmMatches, purgePhaseLabel, purgeRunning } from "@/lib/recording-purge";
import { Button, Card, SectionTitle } from "./ui";

/* Admin -> Dashboard -> Danger zone: "Delete all recordings", every host's, for good
 * (api/internal/api/recording_purge.go). Shows what is stored now, arms only on the exact
 * phrase, then calls the purge step after step until the run is done, showing its progress,
 * and leaves the summary up. A run left unfinished (the tab closed) is carried on by the
 * server's maintenance pass; this card picks it up again when it is opened. */
export function AdminRecordingPurge() {
  const [status, setStatus] = useState<RecordingPurgeStatus | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api
      .adminRecordingPurge()
      .then((st) => {
        if (alive.current) setStatus(st);
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : "Could not read recording storage.");
      });
    return () => {
      alive.current = false;
    };
  }, []);

  async function run() {
    if (!purgeConfirmMatches(typed)) return;
    setBusy(true);
    setError(null);
    try {
      // Each call is one bounded step on the server; keep calling until the run is done.
      for (let i = 0; i < 10000 && alive.current; i++) {
        const st = await api.adminRunRecordingPurge(typed);
        if (!alive.current) return;
        setStatus(st);
        if (!purgeRunning(st.latest)) break;
        // Waiting for stopped recorders to upload: no point asking again straight away.
        await new Promise((r) => setTimeout(r, st.latest?.settleUntil ? 15000 : 500));
      }
      setTyped("");
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "The purge stopped. Press it again to carry on.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const t = status?.totals;
  const latest = status?.latest;
  const running = purgeRunning(latest);
  const sum = latest?.summary;

  return (
    <section className="mt-8">
      <SectionTitle>Danger zone</SectionTitle>
      <Card className="border-live/40 p-4">
        <h3 className="text-[14px] font-semibold text-live">Delete all recordings</h3>
        <p className="mt-1 text-[13px] text-ink-2">
          Permanently deletes every recording of every host from storage, with their clips, reels,
          highlights and uploaded videos, and any upload still in progress. Recordings in progress
          are stopped first. Scheduled Simulives that play one go back to draft. This cannot be undone.
        </p>
        <p className="mt-3 text-[13px] text-ink">
          {t ? (
            <>
              Stored now: <b>{t.recordings}</b> recording{t.recordings === 1 ? "" : "s"}, <b>{t.clips}</b> clip
              {t.clips === 1 ? "" : "s"}, <b>{t.uploads}</b> upload{t.uploads === 1 ? "" : "s"} in progress,{" "}
              <b>{gbText(t.bytes)}</b>.
            </>
          ) : (
            "Reading storage..."
          )}
        </p>

        {latest && sum && (
          <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-[12.5px] text-ink-2" aria-live="polite">
            <p className="font-medium text-ink">
              {running ? purgePhaseLabel(latest.phase) : "Last run finished"}
              {running && latest.settleUntil ? " (waiting for stopped recorders to finish uploading)" : ""}
            </p>
            <p className="mt-1">
              {sum.recordings} recordings, {sum.files} files ({gbText(sum.bytes)}), {sum.clips} clips,{" "}
              {sum.uploadsAborted} uploads aborted, {sum.simulivesAffected} Simulives affected,{" "}
              {sum.recordingsStopped} recordings stopped.
            </p>
            <p className="mt-1 text-ink-3">
              Started {new Date(latest.startedAt).toLocaleString()} by {latest.requestedBy || "an admin"}
              {latest.finishedAt ? `, finished ${new Date(latest.finishedAt).toLocaleString()}` : ""}.
            </p>
            {latest.lastError && <p className="mt-1 text-live">Last step failed: {latest.lastError}</p>}
          </div>
        )}

        <label className="mt-4 block text-[12.5px] text-ink-2" htmlFor="purge-confirm">
          Type <b className="font-mono text-ink">{RecordingPurgeConfirm}</b> to confirm
          {running ? " and carry on the run in progress" : ""}.
        </label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input
            id="purge-confirm"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            className="h-9 w-72 rounded-md border border-line bg-surface-0 px-2 font-mono text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-live/40"
          />
          <Button variant="destructive" size="sm" disabled={!purgeCanStart(status, typed, busy)} onClick={() => void run()}>
            {busy ? "Deleting..." : running ? "Carry on deleting" : "Delete all recordings"}
          </Button>
        </div>
        {error && <p className="mt-2 text-[12.5px] text-live">{error}</p>}
      </Card>
    </section>
  );
}
