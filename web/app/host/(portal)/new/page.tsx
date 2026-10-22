import Link from "next/link";
import { ScheduleForm } from "@/components/schedule/schedule-form";
import { ScheduleHeading } from "@/components/simulive-discover";

export default function ScheduleWebinarPage() {
  return (
    <>
      <Link
        href="/host"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        ← Your webinars
      </Link>
      {/* "Schedule a Simulive", with its explainer, when opened for a recording. */}
      <ScheduleHeading />
      <ScheduleForm />
    </>
  );
}
