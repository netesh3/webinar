"use client";

/* The host's "Audience layout" picker, in Host controls.
 *
 * Chooses how the composite arranges the stage (SessionControls.audienceLayout): the picture
 * edge viewers, CDN viewers and the recording get. Saved through PATCH /controls, which pushes
 * room metadata; the egress page is in the room and re-lays the composite live.
 *
 * Shown only while there is a composite to arrange: an edge webinar, or a meeting's or
 * simulive's recording running. Not in a live WebRTC webinar, where every viewer picks their
 * own view (29 Oct 2026). The thumbnails are each
 * layout's own place() on a sample stage (lib/composite-layouts.ts), so they cannot drift from
 * what the egress draws. */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { LAYOUTS, layoutById, SHARE_ID, thumbnailFor, type CompositeLayoutDef } from "@/lib/composite-layouts";
import { Alert, InfoTip, Spinner } from "../controls";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

export const AUDIENCE_LAYOUT_TIP =
  "How viewers of the live stream and the recording see the stage. Your panelists' own view doesn't change.";

/** Whether this session has an edge mix: asked once, the host's own status endpoint. */
function useEdgeDelivery(slug: string, skip: boolean): boolean {
  const [edge, setEdge] = useState(false);
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    api
      .hostEdgeStatus(slug)
      .then((s) => {
        if (!cancelled) setEdge(s.delivery === "edge");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug, skip]);
  return edge;
}

export function AudienceLayoutPicker() {
  const { slug, controls, join, recording, isHost } = useRoomUI();
  const meeting = join.meeting === true;
  const edge = useEdgeDelivery(slug, meeting || !isHost);
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* A live WebRTC webinar has no picker (29 Oct 2026): each viewer arranges their own stage,
   * and its recording keeps the layout it has (Auto unless set before). Meetings and simulive
   * still arrange their recording here. */
  const simulive = join.simulive === true;
  if (!isHost || !((edge && !meeting) || (recording && (meeting || simulive)))) return null;
  const current = layoutById(controls.audienceLayout).id;

  async function choose(def: CompositeLayoutDef) {
    if (def.id === current || busy) return;
    setBusy(def.id);
    setError(null);
    try {
      await api.updateControls(slug, { audienceLayout: def.id } satisfies ControlsPatch);
      notify(`Audience layout: ${def.label}.`, "ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't apply.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
        Audience layout
        <InfoTip text={AUDIENCE_LAYOUT_TIP} />
      </h3>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Audience layout">
        {LAYOUTS.map((def) => {
          const selected = def.id === current;
          return (
            <button
              key={def.id}
              type="button"
              role="radio"
              aria-checked={selected}
              title={def.description}
              disabled={busy !== null}
              onClick={() => void choose(def)}
              className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[11px] font-medium transition-colors disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                selected
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-line-2 text-ink-2 hover:bg-surface-2"
              }`}
            >
              <LayoutThumbnail def={def} />
              <span className="flex items-center gap-1 leading-tight">
                {busy === def.id && <Spinner className="size-3" />}
                {def.label}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function LayoutThumbnail({ def }: { def: CompositeLayoutDef }) {
  const { placements } = thumbnailFor(def);
  // Base layer first so a PiP is drawn on top.
  const ordered = [...placements].sort((a, b) => a.z - b.z);
  return (
    <svg viewBox="0 0 160 90" className="w-full rounded bg-zinc-900" aria-hidden>
      {ordered.map((p) => (
        <rect
          key={p.id}
          x={p.rect.x}
          y={p.rect.y}
          width={p.rect.w}
          height={p.rect.h}
          rx={p.role === "pip" ? 4 : 2}
          className={
            p.id === SHARE_ID
              ? "fill-sky-500/70"
              : p.role === "main" || p.role === "pip"
                ? "fill-zinc-300"
                : "fill-zinc-500"
          }
          stroke={p.role === "pip" ? "#18181b" : undefined}
          strokeWidth={p.role === "pip" ? 2 : undefined}
        />
      ))}
    </svg>
  );
}
