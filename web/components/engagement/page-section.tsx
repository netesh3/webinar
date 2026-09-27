"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FOLDABLE, foldStore } from "@/lib/engagement/folds";
import { sectionDomId, type SectionId } from "@/lib/engagement/sections";
import { Icon } from "./primitives";

/** One titled block of the Engagement tab. The sections simply follow one another down the
 *  page; the id keeps each one linkable (#eng-qa), and scroll-mt keeps the portal's sticky
 *  top bar (h-14) off its heading when it is.
 *
 *  Every section but Overview folds. Its heading is then one big button: a chevron, the
 *  title, and — folded — a one-line `summary` so a folded section still says what is in it
 *  ("12 questions · 3 unanswered"). The body is not rendered until it is first opened, so a
 *  section folded for good costs nothing, and it slides rather than jumps. */
export function PageSection({
  id,
  title,
  hint,
  action,
  summary,
  children,
}: {
  id: SectionId;
  title: string;
  hint?: string;
  action?: ReactNode;
  /** What a folded section shows beside its title. */
  summary?: ReactNode;
  children: ReactNode;
}) {
  const dom = sectionDomId(id);
  if (!FOLDABLE.includes(id)) {
    return (
      <section id={dom} aria-labelledby={`${dom}-title`} className="min-w-0 scroll-mt-20 py-3">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h2 id={`${dom}-title`} className="text-[16px] font-semibold tracking-[-0.01em]">
              {title}
            </h2>
            {hint && <p className="mt-0.5 max-w-2xl text-[12.5px] text-ink-2">{hint}</p>}
          </div>
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <Foldable id={id} title={title} hint={hint} action={action} summary={summary}>
      {children}
    </Foldable>
  );
}

export function useFolded(): readonly SectionId[] {
  return useSyncExternalStore(foldStore.subscribe, foldStore.get, foldStore.server);
}

/** Unfolds a section, then scrolls to it once it has a body to land on. */
export function revealSection(id: SectionId, behavior: ScrollBehavior = "smooth") {
  foldStore.set(id, false);
  requestAnimationFrame(() => {
    document.getElementById(sectionDomId(id))?.scrollIntoView({ behavior, block: "start" });
  });
}

function Foldable({
  id,
  title,
  hint,
  action,
  summary,
  children,
}: {
  id: SectionId;
  title: string;
  hint?: string;
  action?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const dom = sectionDomId(id);
  const bodyId = useId();
  const open = !useFolded().includes(id);

  // Mounted from the first time it is open, and kept, so filters and scroll inside survive a
  // fold. Adjusted during render rather than in an effect, so opening paints the body at once.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  // Clipped only while moving or folded: an open body must not cut off its own menus.
  const [moving, setMoving] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setMoving(true);
    const t = window.setTimeout(() => setMoving(false), 320);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <section
      id={dom}
      aria-labelledby={`${dom}-title`}
      className={`group/fold min-w-0 scroll-mt-20 rounded-2xl border transition-colors duration-200 ${
        open ? "border-transparent py-4" : "border-line bg-surface hover:border-line-2"
      }`}
    >
      <div className={`flex items-center gap-2 ${open ? "" : "pr-3"}`}>
        {/* The WAI accordion shape: the heading holds the button, so it still reads as a heading. */}
        <h2 id={`${dom}-title`} className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => foldStore.set(id, open)}
          className={`flex w-full min-w-0 items-center gap-3 rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            open ? "py-1 pr-2" : "px-3 py-3 sm:px-4"
          }`}
        >
          <span
            aria-hidden
            className={`grid size-7 shrink-0 place-items-center rounded-lg border transition-colors ${
              open
                ? "border-line bg-surface text-ink-2 group-hover/fold:border-line-2 group-hover/fold:text-ink"
                : "border-transparent bg-surface-2 text-ink-2 group-hover/fold:text-ink"
            }`}
          >
            <Icon
              name="expand_more"
              className={`!text-[18px] transition-transform duration-300 motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-[16px] font-semibold tracking-[-0.01em]">{title}</span>
              {!open && summary && (
                <span className="min-w-0 truncate text-[12.5px] font-normal text-ink-2 tabular-nums">{summary}</span>
              )}
            </span>
            {open && hint && <span className="mt-0.5 block max-w-2xl text-[12.5px] font-normal text-ink-2">{hint}</span>}
          </span>
        </button>
        </h2>
        {open ? action : (
          <span aria-hidden className="hidden text-[12px] font-medium text-ink-3 group-hover/fold:text-brand sm:inline">
            Show
          </span>
        )}
      </div>

      <div
        id={bodyId}
        inert={!open}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className={`min-h-0 min-w-0 ${open && !moving ? "" : "overflow-hidden"}`}>
          {mounted && <div className="pt-3">{children}</div>}
        </div>
      </div>
    </section>
  );
}

/** Fold or unfold every section at once: for a host who wants just the headlines, or all of it. */
export function FoldAllButton() {
  const folded = useFolded();
  const all = folded.length === FOLDABLE.length;
  return (
    <button
      type="button"
      onClick={() => foldStore.all(!all)}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-ink-2 outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <Icon name={all ? "unfold_more" : "unfold_less"} />
      {all ? "Expand all" : "Collapse all"}
    </button>
  );
}

/** Renders `children` once the placeholder comes within ~one screen of the viewport.
 *  Below-the-fold sections cost nothing — including the attendee list's request — until
 *  somebody scrolls toward them. */
export function Deferred({ children, minHeight = 320 }: { children: ReactNode; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  if (seen) return <>{children}</>;
  return <div ref={ref} style={{ minHeight }} aria-hidden className="rounded-xl bg-surface-2/40" />;
}
