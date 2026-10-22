import Link from "next/link";
import { ScheduleForm } from "@/components/schedule/schedule-form";

/* Scheduling a meeting: the schedule form in its meeting shape — a topic and a time, and
 * nothing about registration, delivery or messages, because a meeting has none of those. Its
 * own address rather than a ?kind= on /host/new, so the page needs no search params to know
 * what it is and a webinar's half-written draft never opens here. */
export default function ScheduleMeetingPage() {
  return (
    <>
      <Link
        href="/host/meetings"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        ← Your meetings
      </Link>
      <h1 className="mb-1 text-[24px] font-semibold tracking-[-0.02em]">
        Schedule a meeting
      </h1>
      <ScheduleForm meeting />
    </>
  );
}
