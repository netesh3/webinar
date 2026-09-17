/* Next.js shows this the instant the "Schedule a webinar" link is clicked —
 * before ScheduleForm's own JS chunk (951 lines, the timezone list, the
 * image picker) has finished downloading and hydrating. Without it the click
 * felt like it had done nothing for a beat; this is what fills that beat.
 *
 * Shaped like the real form (title, then stacked card sections) rather than
 * a spinner, so there's no layout jump when ScheduleForm actually mounts. */
export default function Loading() {
  return (
    <>
      <div className="mb-4 h-[17px] w-20 animate-pulse rounded bg-surface-2" />
      <div className="mb-6 h-[29px] w-64 animate-pulse rounded bg-surface-2" />
      <div className="grid gap-5">
        {[168, 220, 140, 110, 96].map((h, i) => (
          <div
            key={i}
            className="animate-pulse rounded-xl border border-line bg-surface p-5"
            style={{ height: h }}
          />
        ))}
      </div>
    </>
  );
}
