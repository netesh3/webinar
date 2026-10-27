"use client";

/* The host's captions language, in Host controls. Saved through PATCH /controls
 * (captionsLanguage), which stores it with the webinar and pushes room metadata; the caption
 * agent reconnects its Deepgram streams in the new language, so it applies from the next
 * thing said. Never for a simulive, which is not captioned live. */

import { useState } from "react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { Alert } from "../controls";
import { CaptionsLanguageSelect } from "../captions-language-select";
import { useAppConfig, useToast } from "../providers";
import { useRoomUI } from "./context";

export function CaptionsLanguagePicker() {
  const { slug, controls, join, isHost } = useRoomUI();
  const config = useAppConfig();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isHost || join.simulive || join.simuliveLive) return null;

  async function choose(code: string) {
    if (code === controls.captionsLanguage || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateControls(slug, { captionsLanguage: code } satisfies ControlsPatch);
      const l = config.captionLanguages.find((x) => x.code === code);
      notify(`Captions language: ${l?.label ?? code}.`, "ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't apply.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      {error && <Alert tone="error">{error}</Alert>}
      <CaptionsLanguageSelect
        value={controls.captionsLanguage}
        onChange={(code) => void choose(code)}
        disabled={busy}
        noun={join.meeting === true ? "meeting" : "webinar"}
      />
    </section>
  );
}
