/* Next.js shows this the instant the "Schedule a webinar" link is clicked —
 * before ScheduleForm's own JS chunk (the timezone list, the image picker)
 * has finished downloading and hydrating. Without it the click felt like it
 * had done nothing for a beat; this is what fills that beat.
 *
 * Shaped like the real form (title, three grouped cards) rather
 * than a spinner, so there's no layout jump when ScheduleForm actually mounts. */
export default function Loading() {
  return (
    <>
      <div className="mb-4 h-[17px] w-28 animate-pulse rounded bg-surface-2" />
      <div className="mb-1 h-7 w-64 animate-pulse rounded bg-surface-2" />
      <div className="mt-3 mb-5 h-9 w-full max-w-xl animate-pulse rounded-lg bg-surface-2" />
      <div className="grid gap-5 pb-48 lg:pb-24">
        {[320, 420, 280].map((h) => (
          <div
            key={h}
            className="animate-pulse rounded-xl border border-line bg-surface"
            style={{ height: h }}
          />
        ))}
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface">
        <div className="mx-auto flex w-full max-w-6xl justify-end gap-2 px-4 py-2.5 sm:px-5 lg:py-3">
          <div className="h-11 flex-1 animate-pulse rounded-lg bg-surface-2 lg:flex-none lg:w-32" />
          <div className="h-11 flex-1 animate-pulse rounded-lg bg-surface-2 lg:flex-none lg:w-28" />
        </div>
      </div>
    </>
  );
}
