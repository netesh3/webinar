"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { FeatureReplayEngage } from "@/lib/api-types";
import { SIMULIVE_PICKER_HREF, simuliveExplainer } from "@/lib/simulive-discover";
import { Modal } from "./controls";
import { InfoIcon } from "./icons";
import { useSession } from "./providers";
import { Badge } from "./ui";

/* "What's a Simulive?": the ⓘ next to every place simulive is offered (the create option,
 * a recording's "Replay as Simulive", the schedule and edit headings, the Results card). Its
 * own file so the recordings tab can use it without importing the picker that imports it. */

export function useReplayEngage(): boolean {
  const { account } = useSession();
  return (account?.features ?? []).includes(FeatureReplayEngage);
}

/** The explainer's body: four short points, with the engagement-replay one tagged Premium on
 *  an account without replay_engage. */
export function SimuliveExplainer() {
  const points = simuliveExplainer(useReplayEngage());
  return (
    <ul className="grid gap-2.5 py-1 text-[13px] leading-relaxed text-ink-2">
      {points.map((p) => (
        <li key={p.text} className="flex gap-2">
          <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-brand" />
          <span>
            {p.text}
            {p.premium && (
              <>
                {" "}
                <Badge tone="warn">Premium</Badge>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** ⓘ, or a short "What's a Simulive?" text link, that opens the explainer. */
export function SimuliveInfoButton({
  variant = "icon",
  className = "",
}: {
  variant?: "icon" | "link";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="What's a Simulive?"
          title="What's a Simulive?"
          className={`inline-grid size-6 shrink-0 place-items-center rounded-full text-ink-3 outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 ${className}`}
        >
          <InfoIcon className="size-4" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`inline-flex items-center gap-1 text-[12px] font-medium text-ink-3 outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/40 ${className}`}
        >
          <InfoIcon className="size-3.5" />
          What&apos;s a Simulive?
        </button>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="What's a Simulive?"
        description="A past recording, run again as a scheduled live session."
        size="sm"
      >
        <SimuliveExplainer />
      </Modal>
    </>
  );
}

/** The "Simulive" create option on the Webinars home: a card to the recording picker, with
 *  "What's a Simulive?" under it (a button cannot sit inside the card's link). */
export function SimuliveCreateCard({
  cardClass,
  children,
}: {
  cardClass: string;
  /** The card's body, in the same shape as its neighbours (ActionCardBody). */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Link href={SIMULIVE_PICKER_HREF} className={cardClass}>
        {children}
      </Link>
      <SimuliveInfoButton variant="link" className="self-start px-1" />
    </div>
  );
}
