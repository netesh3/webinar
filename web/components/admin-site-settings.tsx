"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SiteSettings } from "@/lib/api-types";
import { Toggle } from "./controls";
import { Card, SectionTitle } from "./ui";

/* Admin -> Dashboard: site-wide switches (api/internal/api/site_settings.go). Each one saves
 * as it is flipped. Everyone else reads them from /api/config, so a change reaches open
 * pages within the web's config cache (five minutes, lib/http.ts TTL_CONFIG), no deploy. */
export function AdminSiteSettings() {
  const [saved, setSaved] = useState<SiteSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminSiteSettings()
      .then(setSaved)
      .catch(() => setNote("Could not read the site settings."));
  }, []);

  async function setDownloads(next: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const s = await api.adminSetSiteSettings({ downloadsVisible: next });
      setSaved(s);
      setNote(
        s.downloadsVisible
          ? "Downloads page is visible. Everyone sees it and its links within five minutes."
          : "Downloads page is hidden. Its links disappear within five minutes.",
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const visible = saved?.downloadsVisible === true;
  return (
    <Card className="mt-6 p-5">
      <SectionTitle>Site settings</SectionTitle>
      <div className="mt-2">
        <Toggle
          checked={visible}
          disabled={busy || saved === null}
          onChange={(next) => void setDownloads(next)}
          label={
            <>
              Downloads page:{" "}
              <b className={visible ? "text-ink" : "text-amber-700"}>
                {saved === null ? "…" : visible ? "visible to everyone" : "hidden"}
              </b>
            </>
          }
          description={
            <>
              When hidden, <Link href="/download" className="text-brand hover:underline">/download</Link> sends
              visitors home and every &ldquo;Get the app&rdquo; link is removed; admins can still open it to
              preview. Installed apps keep updating either way.
            </>
          }
        />
      </div>
      {note && <p className="mt-2 text-[13px] text-ink-2">{note}</p>}
    </Card>
  );
}
