import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { RegisterForm } from "@/components/register-form";
import { ParticipantHeader } from "@/components/participant-header";
import {
  Avatar,
  Badge,
  SectionTitle,
  TopicStripe,
  kindLabel,
} from "@/components/ui";
import { API_BASE, ApiError, api } from "@/lib/api";
import { bypassWebinar } from "@/lib/dev-bypass";
import { formatDay, formatDuration, formatTimeRange, tzLabel } from "@/lib/format";
import type { Person, Webinar } from "@/lib/api-types";

export default async function WebinarDetailPage({
  params,
}: PageProps<"/webinars/[id]">) {
  // Next 16: params is a Promise
  const { id } = await params;

  let w: Webinar;
  try {
    w = await api.getWebinar(id);
  } catch (err) {
    // Local UI preview has no API. The host screens already paint fixtures in
    // that mode; this page does the same so the attendee layout can be reviewed.
    if (process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "1") {
      const fixture = bypassWebinar(id);
      if (fixture && fixture.id === id) {
        w = fixture;
      } else if (err instanceof ApiError && err.status === 404) {
        notFound();
      } else {
        throw err;
      }
    } else if (err instanceof ApiError && err.status === 404) {
      // The API returns 404 for drafts too, so they stay private.
      notFound();
    } else {
      throw err;
    }
  }

  const kind = kindLabel(w);
  const ended = w.status === "ended";

  /* The participant landing page: registration form, confirmation, and the way into the
   * room. No TopNav and no "All webinars" link — this is reached from a registration link
   * somebody was sent, not from a catalogue they were browsing, and offering a route into the
   * host product is exactly what this page must not do.
   *
   * Full width of the window, not a centred column. The host portal already fills the
   * space beside its sidebar; this page has no sidebar, so the same cards run to the
   * edges of the padding. */
  return (
    <div className="flex min-h-full flex-1 flex-col bg-page [--color-brand:#2563EB] [--color-brand-hover:#1D4ED8] dark:[--color-brand:#93C5FD] dark:[--color-brand-hover:#BFDBFE]">
      <ParticipantHeader wide />
      <main className="w-full flex-1 px-4 py-6 sm:px-6">
        <div className="grid items-start gap-5 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
          {/* ---------------- main column ---------------- */}
          <div className="min-w-0">
            <Panel className="mb-4 overflow-hidden">
              {/* The host's own cover image when there is one; the thin gradient
                  accent otherwise — never both, and never a layout that leaves a
                  visible gap for a webinar that has no image. */}
              {w.imageUrl ? (
                // A cross-origin API URL, not something next/image's loader can optimize.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${API_BASE}${w.imageUrl}`}
                  alt=""
                  className="aspect-video w-full object-cover"
                />
              ) : (
                <TopicStripe webinar={w} />
              )}
              {ended && (
                <div className="border-b border-line px-5 py-4 sm:px-6">
                  <h2 className="text-[20px] leading-snug font-semibold tracking-[-0.015em]">
                    This webinar has ended
                  </h2>
                </div>
              )}
              <div className="p-5 sm:p-6">
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <Badge tone={kind.tone} dot={w.status === "live"}>
                    {kind.text}
                  </Badge>
                  {w.track ? <Badge>{w.track}</Badge> : null}
                  {w.options.qAndA && <Badge>Live Q&amp;A</Badge>}
                  {w.options.autoRecord && <Badge>Recorded</Badge>}
                  {w.options.captions && <Badge>Captions</Badge>}
                </div>

                <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.02em]">
                  {w.topic}
                </h1>
                {w.description ? (
                  <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
                    {w.description}
                  </p>
                ) : null}

                <dl className="mt-5 grid gap-x-8 border-t border-line pt-2 sm:grid-cols-2">
                  <div className="flex gap-3 py-2.5">
                    <dt className="w-28 shrink-0 text-[14px] text-ink-3">When</dt>
                    <dd className="min-w-0 text-[14px]">
                      {formatDay(w.startsAt, w.timeZone)}
                      <br />
                      <span className="text-ink-2">
                        {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
                        {tzLabel(w.startsAt, w.timeZone)}
                      </span>
                    </dd>
                  </div>
                  <div className="flex gap-3 py-2.5">
                    <dt className="w-28 shrink-0 text-[14px] text-ink-3">Duration</dt>
                    <dd className="min-w-0 text-[14px]">{formatDuration(w.durationMin)}</dd>
                  </div>
                  {/* No Webinar ID. It is the host's own reference for the session — it
                      appears in the host dashboard and in the invitation the host composes.
                      A participant reached this page from a link and needs the date, the
                      duration and the button; an internal identifier is host furniture.
                      No registered-seat count either — how many other people have signed
                      up is the host's business, not a number to show someone deciding
                      whether to register themselves. */}
                </dl>
              </div>
            </Panel>

            {w.takeaways.length > 0 && (
              <Panel className="mb-4 p-5 sm:p-6">
                <SectionTitle>What you&apos;ll walk away with</SectionTitle>
                <ul className="grid gap-2.5">
                  {w.takeaways.map((t) => (
                    <li key={t} className="flex gap-2.5 text-[14px] leading-relaxed">
                      <svg
                        viewBox="0 0 16 16"
                        className="mt-1 size-3.5 shrink-0 text-ok"
                        aria-hidden
                      >
                        <path
                          d="m3 8.5 3 3 7-7.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                        />
                      </svg>
                      <span className="text-ink-2">{t}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {w.agenda.length > 0 && (
              <Panel className="mb-4 p-5 sm:p-6">
                <SectionTitle>Agenda</SectionTitle>
                <ol className="grid">
                  {w.agenda.map((a, i) => (
                    <li
                      key={a.at + a.title}
                      className={`grid grid-cols-[58px_1fr] gap-4 py-3 ${
                        i < w.agenda.length - 1 ? "border-b border-line" : ""
                      }`}
                    >
                      <span className="pt-px text-[14px] tabular-nums text-ink-3">
                        {a.at}
                      </span>
                      <div>
                        <div className="text-[14px] font-medium">{a.title}</div>
                        {a.detail && (
                          <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                            {a.detail}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </Panel>
            )}

            <Panel className="p-5 sm:p-6">
              {/* "Presenters", not "Host and panelists". A participant needs to know who is
                  speaking; "Host" is the word this product uses for the dashboard and its
                  navigation, and reusing it here makes a speaker list look like a way in. */}
              <SectionTitle>Presenters</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2">
                <SpeakerRow person={w.host} label="Presenter" />
                {w.panelists.map((p) => (
                  <SpeakerRow key={p.id} person={p} label="Panelist" />
                ))}
              </div>
            </Panel>
          </div>

          {/* ---------------- registration rail ---------------- */}
          <div className="min-w-0 min-[900px]:sticky min-[900px]:top-6">
            <Panel className="p-5 sm:p-6">
              <RegisterForm webinar={w} />
            </Panel>
          </div>
        </div>
      </main>
    </div>
  );
}

function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[16px] border border-line bg-surface shadow-[0_1px_2px_rgba(19,22,25,0.04)] ${className}`}
    >
      {children}
    </section>
  );
}

function SpeakerRow({ person, label }: { person: Person; label: string }) {
  return (
    <div className="flex gap-3 rounded-lg border border-line p-3.5">
      <Avatar person={person} size={40} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium">{person.name}</span>
          <Badge tone={label === "Presenter" ? "brand" : "neutral"}>{label}</Badge>
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink-2">
          {person.title} · {person.org}
        </p>
      </div>
    </div>
  );
}
