"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ExportOption } from "@/lib/engagement/exports";
import { ChevronDownIcon } from "@/components/icons";
import { Icon } from "./primitives";

/** One Export button for every download the Engagement tab offers. Items are real links
 *  (the server answers with an attachment), so middle-click and "copy link" still work. */
export function ExportMenu({ options }: { options: ExportOption[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    wrap.current?.querySelector<HTMLAnchorElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (options.length === 0) return null;

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLAnchorElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-[12.5px] font-medium text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <Icon name="download" />
        <span className="hidden sm:inline">Export</span>
        <ChevronDownIcon className="size-3.5 text-ink-3" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Export"
          onKeyDown={onMenuKey}
          className="absolute right-0 z-50 mt-1.5 w-[18rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl"
        >
          {options.map((o) => (
            <a
              key={o.id}
              role="menuitem"
              href={o.href}
              onClick={() => setOpen(false)}
              className="flex min-h-11 flex-col justify-center px-3 py-2 text-[13px] text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              <span className="font-medium">{o.label}</span>
              <span className="mt-0.5 text-[11px] text-ink-3">{o.hint}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
