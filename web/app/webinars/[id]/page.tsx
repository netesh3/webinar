import { notFound } from "next/navigation";
import { RegisterForm } from "@/components/register-form";
import { ParticipantHeader } from "@/components/participant-header";
import {
  Avatar,
  Badge,
  Card,
  Field,
  SectionTitle,
  TopicStripe,
  kindLabel,
} from "@/components/ui";
import { API_BASE, ApiError, api } from "@/lib/api";
import { formatDay, formatDuration, formatTimeRange, tzLabel } from "@/lib/format";
import type { Person } from "@/lib/api-types";

export default async function WebinarDetailPage({
  params,
}: PageProps<"/webinars/[id]">) {
  // Next 16: params is a Promise
  const { id } = await params;

  let w;
  try {
    w = await api.getWebinar(id);
  } catch (err) {
    // The API returns 404 for drafts too, so they stay private.
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const kind = kindLabel(w);

  /* The participant landing page: registration form, confirmation, and the way into the
   * room. No TopNav and no "All webinars" link — this is reached from a registration link
   * somebody was sent, not from a catalogue they were browsing, and offering a route into the
   * host product is exactly what this page must not do. */
  return (
    <>
      <ParticipantHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6">

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_366px]">
          {/* ---------------- main column ---------------- */}
          <div>
            <Card className="mb-4 overflow-hidden">
              {/* The host's own cover image when there is one; the thin gradient
                  accent otherwise — never both, and never a layout that leaves a
                  visible gap for a webinar that has no image. */}
              {w.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a
                // cross-origin API URL, not something next/image's loader
                // can optimize.
                <img
                  src={`${API_BASE}${w.imageUrl}`}
                  alt=""
                  className="aspect-video w-full object-cover"
                />
              ) : (
                <TopicStripe webinar={w} />
              )}
              <div className="p-5">
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <Badge tone={kind.tone} dot={w.status === "live"}>
                    {kind.text}
                  </Badge>
                  <Badge>{w.track}</Badge>
                  {w.options.qAndA && <Badge>Live Q&amp;A</Badge>}
                  {w.options.autoRecord && <Badge>Recorded</Badge>}
                  {w.options.captions && <Badge>Captions</Badge>}
                </div>

                <h1 className="text-[27px] leading-[1.15] font-semibold tracking-[-0.025em]">
                  {w.topic}
                </h1>
                <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
                  {w.description}
                </p>

                <dl className="mt-5 grid gap-x-8 border-t border-line pt-2 sm:grid-cols-2">
                  <Field label="When">
                    {formatDay(w.startsAt, w.timeZone)}
                    <br />
                    <span className="text-ink-2">
                      {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
                      {tzLabel(w.startsAt, w.timeZone)}
                    </span>
                  </Field>
                  <Field label="Duration">{formatDuration(w.durationMin)}</Field>
                  {/* No Webinar ID. It is the host's own reference for the session — it
                      appears in the host dashboard and in the invitation the host composes.
                      A participant reached this page from a link and needs the date, the
                      duration and the button; an internal identifier is host furniture.
                      No registered-seat count either — how many other people have signed
                      up is the host's business, not a number to show someone deciding
                      whether to register themselves. */}
                </dl>
              </div>
            </Card>

            {w.takeaways.length > 0 && (
              <Card className="mb-4 p-5">
                <SectionTitle>What you&apos;ll walk away with</SectionTitle>
                <ul className="grid gap-2.5">
                  {w.takeaways.map((t) => (
                    <li key={t} className="flex gap-2.5 text-[13.5px] leading-relaxed">
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
              </Card>
            )}

            {w.agenda.length > 0 && (
              <Card className="mb-4 p-5">
                <SectionTitle>Agenda</SectionTitle>
                <ol className="grid">
                  {w.agenda.map((a, i) => (
                    <li
                      key={a.at + a.title}
                      className={`grid grid-cols-[58px_1fr] gap-4 py-3 ${
                        i < w.agenda.length - 1 ? "border-b border-line" : ""
                      }`}
                    >
                      <span className="pt-px text-[12.5px] tabular-nums text-ink-3">
                        {a.at}
                      </span>
                      <div>
                        <div className="text-[13.5px] font-medium">{a.title}</div>
                        {a.detail && (
                          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                            {a.detail}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            <Card className="p-5">
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
            </Card>
          </div>

          {/* ---------------- registration rail ---------------- */}
          <div>
            <Card className="p-5 lg:sticky lg:top-20">
              <RegisterForm webinar={w} />
            </Card>
          </div>
        </div>
      </main>
    </>
  );
}

function SpeakerRow({ person, label }: { person: Person; label: string }) {
  return (
    <div className="flex gap-3 rounded-lg border border-line p-3.5">
      <Avatar person={person} size={40} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium">{person.name}</span>
          <Badge tone={label === "Presenter" ? "brand" : "neutral"}>{label}</Badge>
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink-2">
          {person.title} · {person.org}
        </p>
      </div>
    </div>
  );
}
