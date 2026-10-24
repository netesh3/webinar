"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { SimuliveAutoAnswer, Webinar } from "@/lib/api-types";
import { assistantSignature, autoAnswerDisclosure } from "@/lib/qa-auto";
import { Spinner, Toggle } from "./controls";
import { useToast } from "./providers";
import { Card, SectionTitle } from "./ui";

/* A simulive's Auto mode on its Setup tab, beside the engagement replay: the assistant answers
 * new audience questions from the host's AI knowledge while the host is away, signed as the
 * assistant (api/internal/api/qa_auto.go). Needs the account features ai and replay_engage;
 * the server says whether this account has them (a co-host may be looking). */
export function SimuliveAutoCard({ webinar: w }: { webinar: Webinar }) {
  const { notify } = useToast();
  const [state, setState] = useState<SimuliveAutoAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .simuliveAuto(w.id)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        if (!cancelled) setState({ enabled: false, available: false, label: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [w.id]);

  const set = async (next: boolean) => {
    setBusy(true);
    try {
      setState(await api.setSimuliveAuto(w.id, next));
      notify(next ? "Auto mode is on." : "Auto mode is off.", "info");
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not change Auto mode.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (state == null) {
    return (
      <Card className="p-5">
        <SectionTitle>✨ Auto mode</SectionTitle>
        <Spinner className="size-5 text-ink-3" />
      </Card>
    );
  }

  const label = assistantSignature(state.label) ?? "✨ Assistant";
  return (
    <Card className="p-5">
      <SectionTitle>✨ Auto mode</SectionTitle>
      {state.available ? (
        <>
          <Toggle
            checked={state.enabled}
            disabled={busy}
            onChange={(next) => void set(next)}
            label="✨ Auto mode — the assistant answers new questions from your knowledge"
            description="While the simulive plays, new Q&A questions your AI knowledge (documents and approved past answers) covers are answered within seconds, without waiting for you. Chat is never auto-answered."
          />
          <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
            {autoAnswerDisclosure(label)} If you drop in, you can edit or retract any answer marked
            &ldquo;✨ Auto-answered&rdquo;.
          </p>
        </>
      ) : (
        <p className="text-[12.5px] text-ink-2">
          Let an assistant answer new questions from your AI knowledge while the simulive plays. Auto
          mode isn&apos;t switched on for this account (it needs AI, engagement replay and Auto mode)
          — ask us to turn it on.
        </p>
      )}
    </Card>
  );
}
