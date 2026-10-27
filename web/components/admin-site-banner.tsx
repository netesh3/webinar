"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { SiteBannerDefaultMessage, SiteBannerMaxRunes } from "@/lib/api-types";
import type { SiteBanner } from "@/lib/api-types";
import { Button, Card, SectionTitle } from "./ui";

/* Admin -> Dashboard: the site-wide maintenance banner (components/site-banner.tsx). Everyone
 * but admins sees it while it is on; open pages pick a change up within about a minute. */
export function AdminSiteBanner() {
  const [saved, setSaved] = useState<SiteBanner | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .siteBanner()
      .then((b) => {
        setSaved(b);
        setEnabled(b.enabled);
        setMessage(b.message === SiteBannerDefaultMessage ? "" : b.message);
      })
      .catch(() => setNote("Could not read the banner."));
  }, []);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const b = await api.adminSetSiteBanner({ enabled, message });
      setSaved(b);
      setNote(b.enabled ? "Banner is on. Open pages show it within a minute." : "Banner is off.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not save the banner.");
    } finally {
      setBusy(false);
    }
  }

  const preview = message.trim() || SiteBannerDefaultMessage;
  return (
    <Card className="mt-6 p-5">
      <SectionTitle>Maintenance banner</SectionTitle>
      <p className="mt-1 text-[13px] text-ink-3">
        A notice across the whole site for everyone except admins. Currently{" "}
        <b className={saved?.enabled ? "text-amber-700" : "text-ink-2"}>{saved?.enabled ? "ON" : "off"}</b>.
      </p>
      <label className="mt-4 flex items-center gap-2 text-[14px] font-medium text-ink-1">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Show the maintenance banner
      </label>
      <label className="mt-4 block text-[13px] font-medium text-ink-2" htmlFor="site-banner-message">
        Message (leave empty for the default)
      </label>
      <textarea
        id="site-banner-message"
        value={message}
        maxLength={SiteBannerMaxRunes}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        placeholder={SiteBannerDefaultMessage}
        className="mt-1 w-full rounded-md border border-line bg-surface-0 px-3 py-2 text-[14px] text-ink-1"
      />
      <p className="mt-1 text-right text-[12px] text-ink-3">
        {message.length}/{SiteBannerMaxRunes}
      </p>
      <p className="mt-3 text-[12px] font-medium uppercase tracking-wide text-ink-3">Preview</p>
      <div className="mt-1 rounded-md bg-amber-300 px-4 py-2 text-[13px] font-medium text-amber-950">{preview}</div>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {note && <span className="text-[13px] text-ink-2">{note}</span>}
      </div>
    </Card>
  );
}
