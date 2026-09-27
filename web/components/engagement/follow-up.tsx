"use client";

import { useMemo, useState } from "react";
import type { EngagementTierCounts } from "@/lib/api-types";
import { Modal } from "@/components/controls";
import { Button } from "@/components/ui";
import { TIER_META, TIER_ORDER, type Tier } from "@/lib/engagement/score";
import { pct } from "@/lib/engagement/viz";
import { SoonBadge } from "./primitives";

/* Follow-up by engagement level. WhatsApp scheduling is Phase 2, so the composer is a
 * preview: nothing here sends, schedules or calls the network. */

export type SegmentId = Tier | "no_show";

interface Segment {
  id: SegmentId;
  label: string;
  count: number;
  suggestion: string;
  template: string;
  dot: string;
}

const SUGGEST: Record<SegmentId, { text: string; template: string }> = {
  high: { text: "Send the offer while interest is hot", template: "thanks_offer" },
  engaged: { text: "Thank them and share the replay + offer", template: "thanks_offer" },
  passive: { text: "Share the replay with the key moment timestamp", template: "replay_ready" },
  risk: { text: "Send the replay — they left early", template: "replay_ready" },
  no_show: { text: "“We missed you” with the replay link", template: "missed_you" },
};

/* Stand-ins for Meta-approved templates; the real list comes from the CRM's template cache. */
const TEMPLATES = [
  { name: "replay_ready", category: "Utility", body: "Hi {{1}}, thanks for registering for “{{2}}”. The replay is ready: {{3}}", params: ["first_name", "webinar_title", "replay_link"] },
  { name: "thanks_offer", category: "Marketing", body: "Hi {{1}}, loved having you at “{{2}}” 🙌 Doors close Friday — grab your spot: {{3}}", params: ["first_name", "webinar_title", "offer_link"] },
  { name: "missed_you", category: "Marketing", body: "Hi {{1}}, we missed you at “{{2}}”. Catch the highlights here: {{3}}", params: ["first_name", "webinar_title", "replay_link"] },
] as const;

export function useSegments(tiers: EngagementTierCounts): Segment[] {
  return useMemo(
    () => [
      ...TIER_ORDER.map((t) => ({
        id: t,
        label: TIER_META[t].label,
        count: tiers[t],
        suggestion: SUGGEST[t].text,
        template: SUGGEST[t].template,
        dot: TIER_META[t].dot,
      })),
      { id: "no_show" as const, label: "No-shows", count: tiers.noShow, suggestion: SUGGEST.no_show.text, template: SUGGEST.no_show.template, dot: "bg-ink-3" },
    ],
    [tiers],
  );
}

export function TierLevels({ tiers }: { tiers: EngagementTierCounts }) {
  const attended = TIER_ORDER.reduce((s, t) => s + tiers[t], 0);
  return (
    <>
      <div className="flex h-4 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {TIER_ORDER.map((t) => (
          <div key={t} style={{ width: `${pct(tiers[t], attended)}%`, background: TIER_META[t].color }} />
        ))}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-3">
        {TIER_ORDER.map((t) => (
          <li key={t} className="rounded-lg border border-line px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <span className={`size-2 rounded-full ${TIER_META[t].dot}`} aria-hidden />
              {TIER_META[t].label}
            </div>
            <div className="mt-0.5 text-[20px] font-semibold tabular-nums">
              {tiers[t]} <span className="text-[12px] font-normal text-ink-3">· {pct(tiers[t], attended)}%</span>
            </div>
            <div className="text-[11px] text-ink-3">{TIER_META[t].hint}</div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-ink-3">
        Plus {tiers.noShow} registrants who never joined — they&apos;re in the follow-up list.
      </p>
    </>
  );
}

export function FollowUpPanel({ tiers, onCompose }: { tiers: EngagementTierCounts; onCompose: (s: SegmentId) => void }) {
  const segments = useSegments(tiers);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">Follow up</h2>
        <SoonBadge />
      </div>
      <p className="mt-1 text-[12px] text-ink-2">Message each group on WhatsApp, based on how they took part.</p>
      <ul className="mt-3 divide-y divide-line">
        {segments.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2.5">
            <span className={`size-2.5 shrink-0 rounded-full ${s.dot}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[13px]">
                <span className="font-medium">{s.label}</span>
                <span className="tabular-nums text-ink-3">{s.count}</span>
              </div>
              <p className="truncate text-[11.5px] text-ink-3">{s.suggestion}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => onCompose(s.id)} aria-label={`Schedule WhatsApp message to ${s.label}`}>
              Schedule
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const fieldBase =
  "h-9 rounded-lg border border-line-2 bg-surface px-2.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export function WhatsAppComposer({
  initial,
  tiers,
  webinarTitle,
  onClose,
}: {
  initial: SegmentId;
  tiers: EngagementTierCounts;
  webinarTitle: string;
  onClose: () => void;
}) {
  const segments = useSegments(tiers);
  const [segId, setSegId] = useState<SegmentId>(initial);
  const [tpl, setTpl] = useState<string>(SUGGEST[initial].template);
  const [when, setWhen] = useState<"after" | "at">("after");
  const [delay, setDelay] = useState("2h");
  const [at, setAt] = useState("");
  const [quiet, setQuiet] = useState(true);

  const seg = segments.find((s) => s.id === segId) ?? segments[0];
  const template = TEMPLATES.find((t) => t.name === tpl) ?? TEMPLATES[0];
  const values: Record<string, string> = {
    first_name: "Aarav",
    webinar_title: webinarTitle,
    replay_link: "…/replay",
    offer_link: "…/offer",
  };
  const preview = template.body.replace(/\{\{(\d)\}\}/g, (_, n: string) => values[template.params[Number(n) - 1]] ?? "…");

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Schedule a WhatsApp message"
      description="Preview only — this shows how follow-ups will work. Nothing is sent."
      footer={
        <>
          <span className="mr-auto self-center">
            <SoonBadge />
          </span>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button disabled title="Coming soon">
            Schedule for {seg.count} {seg.count === 1 ? "person" : "people"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-2">Who</span>
            <select className={`${fieldBase} w-full`} value={segId} onChange={(e) => setSegId(e.target.value as SegmentId)}>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.count} people
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11.5px] text-ink-3">Only people who agreed to WhatsApp messages at registration will receive it.</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-2">Approved template</span>
            <select className={`${fieldBase} w-full`} value={tpl} onChange={(e) => setTpl(e.target.value)}>
              {TEMPLATES.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} · {t.category}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend className="mb-1 text-[12px] font-medium text-ink-2">When</legend>
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="radio" name="when" checked={when === "after"} onChange={() => setWhen("after")} className="accent-brand" />
                After the webinar ends
              </label>
              <select className={fieldBase} value={delay} onChange={(e) => setDelay(e.target.value)} disabled={when !== "after"} aria-label="Delay after end">
                {["30m", "2h", "1d", "2d"].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="radio" name="when" checked={when === "at"} onChange={() => setWhen("at")} className="accent-brand" />
                On a date
              </label>
              <input type="datetime-local" className={fieldBase} value={at} onChange={(e) => setAt(e.target.value)} disabled={when !== "at"} aria-label="Send at" />
            </div>
            <label className="mt-3 flex items-start gap-2 text-[12.5px] text-ink-2">
              <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} className="mt-0.5 accent-brand" />
              Respect quiet hours (9 pm – 9 am in each person&apos;s time zone)
            </label>
          </fieldset>
        </div>
        <div>
          <span className="mb-1 block text-[12px] font-medium text-ink-2">Preview</span>
          <div className="rounded-2xl bg-[#e7ded5] p-3">
            <div className="rounded-lg rounded-tl-none bg-white px-3 py-2 text-[13px] leading-snug text-[#111b21] shadow-sm">
              {preview}
              <div className="mt-1 text-right text-[10.5px] text-[#667781]">10:00 ✓✓</div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
