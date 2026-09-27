"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { sectionDomId, type SectionId } from "@/lib/engagement/sections";

/** One titled block of the Engagement tab. The sections simply follow one another down the
 *  page; the id keeps each one linkable (#eng-qa), and scroll-mt keeps the portal's sticky
 *  top bar (h-14) off its heading when it is. */
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
    <section id={dom} aria-labelledby={`${dom}-title`} className="min-w-0 scroll-mt-20">
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
