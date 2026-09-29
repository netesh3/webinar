"use client";

import { useMemo, useState } from "react";
import type { EngagementActivity, EngagementMarker, EngagementPoint } from "@/lib/api-types";
import { BAND_META, type Band } from "@/lib/engagement/score";
import {
  activityAlpha,
  areaPath,
  linePath,
  linear,
  minuteLabel,
  minuteTicks,
  nearestIndex,
  niceMax,
  pct,
  NOT_PRESENT,
} from "@/lib/engagement/viz";

/* Hand-rolled SVG charts. A retention curve with markers and a minute heatmap are simpler
 * and crisper drawn directly than through a chart library, and render identically on the
 * server and client. */

export const MARKER_COLOR: Record<string, string> = {
  poll: "#a15c00",
  quiz: "#7c3aed",
  qa: "#0e7490",
  offer: "#0b8a4b",
  rating: "#be185d",
};
const markerColor = (kind: string) => MARKER_COLOR[kind] ?? "#5c6670";

export function ScoreGauge({ score, band, size = 176 }: { score: number; band: Band; size?: number }) {
  const meta = BAND_META[band];
  const len = Math.PI * 70;
  return (
    <div className="relative" style={{ width: size, height: size * 0.62 }}>
      <svg viewBox="0 0 180 110" className="h-full w-full" role="img" aria-label={`Engagement index ${score} out of 100, ${meta.label}`}>
        <path d="M20 95 A70 70 0 0 1 160 95" fill="none" stroke="#e5e9ec" strokeWidth="14" strokeLinecap="round" />
        <path
          d="M20 95 A70 70 0 0 1 160 95"
          fill="none"
          stroke={meta.color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${(Math.max(0, Math.min(100, score)) / 100) * len} ${len}`}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center" aria-hidden>
        <div className="text-[34px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{score}</div>
        <div className={`mt-1 text-[12px] font-semibold ${meta.tone}`}>{meta.label}</div>
      </div>
    </div>
  );
}

const W = 720;
const H = 220;
const PAD = { l: 34, r: 12, t: 26, b: 26 };

/** People in the room minute by minute, lobby shaded, the session's moments marked. */
export function RetentionChart({
  series,
  markers,
  sessionMin,
  attended,
}: {
  series: EngagementPoint[];
  markers: EngagementMarker[];
  sessionMin: number;
  attended: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const chart = useMemo(() => {
    const from = Math.min(0, series[0]?.minute ?? 0);
    const peak = Math.max(1, ...series.map((s) => s.live));
    const yMax = niceMax(peak);
    const x = linear(from, sessionMin, PAD.l, W - PAD.r);
    const y = linear(0, yMax, H - PAD.b, PAD.t);
    const pts = series.map((s) => ({ x: x(s.minute), y: y(s.live) }));
    return {
      from,
      peak,
      yMax,
      x,
      y,
      line: linePath(pts),
      area: areaPath(pts, y(0)),
      minutes: series.map((s) => s.minute),
      ticks: minuteTicks(from, sessionMin),
    };
  }, [series, sessionMin]);

  if (series.length === 0) return <p className="py-10 text-center text-[13px] text-ink-3">No one has been in the room yet.</p>;
  const h = hover == null ? null : series[hover];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full select-none"
        role="img"
        aria-label={`Audience over time. Peak ${chart.peak} live.`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const minute = chart.from + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (sessionMin - chart.from);
          setHover(nearestIndex(chart.minutes, minute));
        }}
      >
        <defs>
          <linearGradient id="ret-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#0b5cff" stopOpacity="0.22" />
            <stop offset="1" stopColor="#0b5cff" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {chart.from < 0 && (
          <>
            <rect x={chart.x(chart.from)} y={PAD.t} width={chart.x(0) - chart.x(chart.from)} height={H - PAD.t - PAD.b} fill={NOT_PRESENT} />
            <text x={(chart.x(chart.from) + chart.x(0)) / 2} y={H - PAD.b - 6} textAnchor="middle" fontSize="10" fill="#8a9199">
              Lobby
            </text>
          </>
        )}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={chart.y(chart.yMax * f)} y2={chart.y(chart.yMax * f)} stroke="#e5e9ec" />
            <text x={PAD.l - 6} y={chart.y(chart.yMax * f) + 3} textAnchor="end" fontSize="10" fill="#8a9199">
              {Math.round(chart.yMax * f)}
            </text>
          </g>
        ))}
        {chart.ticks.map((m) => (
          <text key={m} x={chart.x(m)} y={H - 8} textAnchor="middle" fontSize="10" fill="#8a9199">
            {m}m
          </text>
        ))}
        <path d={chart.area} fill="url(#ret-fill)" />
        <path d={chart.line} fill="none" stroke="#0b5cff" strokeWidth="2" strokeLinejoin="round" />
        {markers.map((mk) => (
          <g key={`${mk.kind}-${mk.minute}`}>
            <line x1={chart.x(mk.minute)} x2={chart.x(mk.minute)} y1={PAD.t - 6} y2={H - PAD.b} stroke={markerColor(mk.kind)} strokeDasharray="3 3" strokeOpacity="0.7" />
            <circle cx={chart.x(mk.minute)} cy={PAD.t - 10} r="5" fill={markerColor(mk.kind)}>
              <title>{`${mk.minute} min · ${mk.label}`}</title>
            </circle>
          </g>
        ))}
        {h && (
          <g>
            <line x1={chart.x(h.minute)} x2={chart.x(h.minute)} y1={PAD.t} y2={H - PAD.b} stroke="#131619" strokeOpacity="0.25" />
            <circle cx={chart.x(h.minute)} cy={chart.y(h.live)} r="4" fill="#fff" stroke="#0b5cff" strokeWidth="2" />
          </g>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] shadow-lg"
          style={{ left: `${Math.min(78, (chart.x(h.minute) / W) * 100)}%` }}
        >
          <div className="font-semibold tabular-nums">{h.minute < 0 ? `Lobby ${minuteLabel(h.minute)}` : `${h.minute} min`}</div>
          <div className="text-ink-2 tabular-nums">
            {h.live} live · {pct(h.live, attended)}% of attendees
          </div>
        </div>
      )}
      {markers.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-ink-2">
          {markers.map((mk) => (
            <li key={`${mk.kind}-${mk.minute}`} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: markerColor(mk.kind) }} aria-hidden />
              <span className="tabular-nums text-ink-3">{mk.minute}m</span> {mk.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  color?: string;
}

export function Bars({ data, color = "#0b5cff", height = 120 }: { data: BarDatum[]; color?: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="flex items-end gap-1.5" style={{ height }}>
      {data.map((d) => (
        <li key={d.key} className="flex min-w-0 flex-1 flex-col items-center gap-1" aria-label={`${d.label}: ${d.value}`}>
          <span className="text-[11px] font-medium tabular-nums text-ink-2" aria-hidden>
            {d.value}
          </span>
          <div className="w-full rounded-t-md" style={{ height: Math.max(3, (d.value / max) * (height - 38)), background: d.color ?? color }} />
          <span className="w-full truncate text-center text-[10.5px] text-ink-3" aria-hidden>
            {d.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function HBar({
  label,
  value,
  total,
  color = "#0b5cff",
  suffix = "",
  highlight = false,
}: {
  label: string;
  value: number;
  total: number;
  color?: string;
  suffix?: string;
  highlight?: boolean;
}) {
  const share = pct(value, total);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className={`min-w-0 truncate ${highlight ? "font-semibold text-ink" : "text-ink-2"}`}>{label}</span>
        <span className="shrink-0 tabular-nums text-ink-2">
          {share}% <span className="text-ink-3">· {value}{suffix}</span>
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full" style={{ width: `${share}%`, background: color }} />
      </div>
    </div>
  );
}

const ACTIVITY_ROWS = [
  { key: "chat", label: "Chat", rgb: "11,92,255" },
  { key: "qa", label: "Q&A", rgb: "14,116,144" },
  { key: "poll", label: "Polls & quizzes", rgb: "161,92,0" },
  { key: "reaction", label: "Reactions", rgb: "190,24,93" },
] as const;

/** Interactions per bucket, one row per type, opacity normalised per row. */
export function ActivityHeatmap({
  activity,
  markers,
  sessionMin,
}: {
  activity: EngagementActivity;
  markers: EngagementMarker[];
  sessionMin: number;
}) {
  const rows = useMemo(
    () => ACTIVITY_ROWS.map((r) => ({ ...r, values: activity[r.key], max: Math.max(0, ...activity[r.key]) })),
    [activity],
  );
  const columns = activity.chat.length;
  const span = Math.max(1, columns * activity.bucketMin);
  const ticks = useMemo(() => minuteTicks(0, Math.min(span, sessionMin)), [span, sessionMin]);
  if (columns === 0) return <p className="py-8 text-center text-[13px] text-ink-3">No interactions yet.</p>;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="relative ml-[118px] h-5">
          {markers
            .filter((mk) => mk.minute >= 0 && mk.minute < span)
            .map((mk) => (
              <span
                key={`${mk.kind}-${mk.minute}`}
                className="absolute top-1 size-2.5 -translate-x-1/2 rounded-full ring-2 ring-surface"
                style={{ left: `${((mk.minute + 0.5) / span) * 100}%`, background: markerColor(mk.kind) }}
                title={`${mk.minute} min · ${mk.label}`}
              />
            ))}
        </div>
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 py-[3px]">
            <div className="w-[110px] shrink-0 text-[12px] text-ink-2">{r.label}</div>
            <div className="grid flex-1 gap-[2px]" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {r.values.map((v, i) => (
                <div
                  key={i}
                  className="h-6 rounded-[3px]"
                  style={{ background: v ? `rgba(${r.rgb},${activityAlpha(v, r.max)})` : NOT_PRESENT }}
                  title={`${i * activity.bucketMin} min · ${v} ${r.label.toLowerCase()}`}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="relative ml-[118px] h-5 text-[10.5px] text-ink-3 tabular-nums">
          {ticks.map((m) => (
            <span key={m} className="absolute top-1 -translate-x-1/2" style={{ left: `${(m / span) * 100}%` }}>
              {m}m
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
