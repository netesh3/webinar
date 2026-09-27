"use client";

import { useState } from "react";
import { LIMITS, STAR_LABELS, starLabel } from "@/lib/survey";
import { StarIcon } from "../icons";

/* The survey's inputs, each a native radio group under the paint, so arrow keys, Tab and a
 * screen reader behave the way they do for every other radio group — nothing here reimplements
 * keyboard handling. */

export function StarRating({
  name,
  value,
  onChange,
  disabled,
  size = "lg",
  labelledBy,
}: {
  name: string;
  value: number | null;
  onChange: (n: number) => void;
  disabled?: boolean;
  size?: "lg" | "md";
  labelledBy?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  const lg = size === "lg";
  return (
    <div className={lg ? "flex flex-col items-center" : "flex items-center gap-3"}>
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        className={`flex ${lg ? "gap-1.5 sm:gap-2" : "gap-1"}`}
        onMouseLeave={() => setHover(null)}
      >
        {STAR_LABELS.map((label, i) => {
          const n = i + 1;
          const on = n <= shown;
          return (
            <label
              key={n}
              onMouseEnter={() => !disabled && setHover(n)}
              className={`group grid cursor-pointer place-items-center rounded-xl transition-transform has-focus-visible:ring-2 has-focus-visible:ring-brand/50 motion-safe:active:scale-90 ${
                lg ? "size-12 sm:size-[52px]" : "size-9"
              } ${disabled ? "pointer-events-none opacity-60" : "motion-safe:hover:scale-110"}`}
            >
              <input
                type="radio"
                name={name}
                value={n}
                checked={value === n}
                disabled={disabled}
                onChange={() => onChange(n)}
                className="sr-only"
                aria-label={`${n} star${n === 1 ? "" : "s"} — ${label}`}
              />
              <StarIcon
                className={`transition-colors ${lg ? "size-10 sm:size-11" : "size-7"} ${
                  on ? "fill-warn text-warn" : "text-ink-3/70 group-hover:text-ink-2"
                }`}
              />
            </label>
          );
        })}
      </div>
      <p
        aria-live="polite"
        className={`text-[12.5px] font-medium ${lg ? "mt-2 h-5" : ""} ${shown ? "text-ink" : "text-ink-3"}`}
      >
        {shown ? starLabel(shown) : lg ? "Tap a star to rate" : ""}
      </p>
    </div>
  );
}

/** 0–10, "how likely are you to recommend". Eleven cells wrap to two rows on a phone. */
export function NpsScale({
  name,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  name: string;
  value: number | null;
  onChange: (n: number) => void;
  disabled?: boolean;
  labelledBy?: string;
}) {
  return (
    <div>
      <div role="radiogroup" aria-labelledby={labelledBy} className="grid grid-cols-6 gap-1.5 sm:grid-cols-11 sm:gap-1">
        {Array.from({ length: 11 }, (_, n) => {
          const selected = value === n;
          return (
            <label
              key={n}
              className={`grid h-10 cursor-pointer place-items-center rounded-lg border text-[13px] font-semibold tabular-nums transition-colors has-focus-visible:ring-2 has-focus-visible:ring-brand/40 sm:h-9 ${
                selected
                  ? "border-brand bg-brand text-stage"
                  : "border-line text-ink-2 hover:border-line-2 hover:bg-surface-2 hover:text-ink"
              } ${disabled ? "pointer-events-none opacity-60" : ""}`}
            >
              <input
                type="radio"
                name={name}
                value={n}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(n)}
                className="sr-only"
              />
              {n}
            </label>
          );
        })}
      </div>
      <div aria-hidden className="mt-1.5 flex justify-between text-[11px] text-ink-3">
        <span>Not likely</span>
        <span>Very likely</span>
      </div>
    </div>
  );
}

export function TextAnswer({
  id,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  labelledBy?: string;
}) {
  const used = [...value].length;
  const near = used > LIMITS.text * 0.8;
  return (
    <div>
      <textarea
        id={id}
        rows={3}
        value={value}
        disabled={disabled}
        aria-labelledby={labelledBy}
        maxLength={LIMITS.text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type your answer…"
        className="block w-full resize-y rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
      />
      {near && (
        <p className="mt-1 text-right text-[11px] tabular-nums text-ink-3">
          {used} / {LIMITS.text}
        </p>
      )}
    </div>
  );
}
