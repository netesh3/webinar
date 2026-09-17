import Link from "next/link";
import { ScheduleForm } from "@/components/schedule-form";

export default function ScheduleWebinarPage() {
  return (
    <>
      <Link
        href="/host"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        ← Host Webinar
      </Link>
      <h1 className="mb-6 text-[24px] font-semibold tracking-[-0.02em]">
        Schedule a webinar
      </h1>
      <ScheduleForm />
    </>
  );
}
