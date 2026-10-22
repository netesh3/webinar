"use client";

/** The players' captions switch: "CC", marked when on (lib/caption-track.ts). */
export function CcButton({
  on,
  onToggle,
  className = "",
}: {
  on: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? "Turn captions off" : "Turn captions on"}
      title={on ? "Captions off" : "Captions on"}
      className={`rounded px-1 text-[11px] font-bold leading-4 tracking-wide transition-colors ${
        on ? "bg-white text-black" : "border border-white/70 text-white/80 hover:text-white"
      } ${className}`}
    >
      CC
    </button>
  );
}
