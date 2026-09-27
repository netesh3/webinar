"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { SECTIONS, activeSection, sectionDomId, type SectionId } from "@/lib/engagement/sections";

/* The sticky in-page nav: one chip per section, the current one highlighted as you scroll.
 * It sits under the portal's sticky top bar (h-14), scrolls sideways on a phone, and keeps
 * the active chip in view. `actions` is the Export menu and friends, on the right. */

const TOP_BAR = 56;
const NAV = 52;
const READING_LINE = TOP_BAR + NAV + 24;

export function SectionNav({
  sections = SECTIONS,
  actions,
  onJump,
}: {
  sections?: readonly { id: SectionId; label: string }[];
  actions?: ReactNode;
  /** Called before scrolling, so lazily mounted sections can render first. */
  onJump?: (id: SectionId) => void;
}) {
  const [active, setActive] = useState<SectionId | null>(sections[0]?.id ?? null);
  const chips = useRef<Record<string, HTMLAnchorElement | null>>({});

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const tops = sections.flatMap((s) => {
        const el = document.getElementById(sectionDomId(s.id));
        return el ? [{ id: s.id, top: el.getBoundingClientRect().top }] : [];
      });
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActive(atBottom ? (tops.at(-1)?.id ?? null) : activeSection(tops, READING_LINE));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sections]);

  useEffect(() => {
    if (active) chips.current[active]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const jump = (id: SectionId) => {
    onJump?.(id);
    // A frame later, so a section that just mounted has its real height.
    requestAnimationFrame(() => {
      const el = document.getElementById(sectionDomId(id));
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      el.focus({ preventScroll: true });
      setActive(id);
    });
  };

  return (
    <div className="sticky top-14 z-20 -mx-4 border-b border-line bg-page/95 px-4 backdrop-blur sm:-mx-5 sm:px-5">
      <div className="flex h-[52px] items-center gap-3">
        <nav aria-label="Engagement sections" className="min-w-0 flex-1">
          <ul className="flex items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sections.map((s) => {
              const on = s.id === active;
              return (
                <li key={s.id} className="shrink-0">
                  <a
                    ref={(el) => {
                      chips.current[s.id] = el;
                    }}
                    href={`#${sectionDomId(s.id)}`}
                    aria-current={on ? "location" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      jump(s.id);
                    }}
                    className={`inline-flex h-8 items-center rounded-full px-3 text-[12.5px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 ${
                      on ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {s.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** A titled block the nav can jump to. Focusable (tabindex -1) so a jump moves the screen
 *  reader's position too, and offset so the sticky bars don't cover its heading. */
export function PageSection({
  id,
  title,
  hint,
  action,
  children,
}: {
  id: SectionId;
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const dom = sectionDomId(id);
  return (
    <section id={dom} aria-labelledby={`${dom}-title`} tabIndex={-1} className="min-w-0 scroll-mt-[124px] outline-none">
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

/** Renders `children` once the placeholder comes within ~one screen of the viewport, or
 *  when `force` is set (a nav jump). Below-the-fold sections cost nothing — including the
 *  attendee list's request — until somebody scrolls toward them. */
export function Deferred({ children, force = false, minHeight = 320 }: { children: ReactNode; force?: boolean; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const show = seen || force;

  useEffect(() => {
    if (show) return;
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
  }, [show]);

  if (show) return <>{children}</>;
  return <div ref={ref} style={{ minHeight }} aria-hidden className="rounded-xl bg-surface-2/40" />;
}
