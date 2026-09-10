"use client";

import { useState } from "react";
import { Alert, CopyField, Spinner, Tabs } from "./controls";
import { ApprovalQueue } from "./approval-queue";
import { RecordingsTab } from "./recordings-tab";
import { PlusIcon, TrashIcon } from "./icons";
import { useShareOrigin, useToast } from "./providers";
import { Avatar, Badge, Button, ButtonLink, Card, SectionTitle } from "./ui";
import { formatCount, formatDay, formatTimeRange, tzLabel } from "@/lib/format";
import { ApiError, api } from "@/lib/api";
import type { Recording, RegistrantRow, Webinar } from "@/lib/api-types";

/* Per-webinar management. Every tab here operates on real data — the share links
 * are built from the operator's configured public URL rather than a placeholder
 * domain, and the settings shown are the ones the session will actually run with.
 */

const TABS = [
  "Registrants",
  "Share",
  "Stage",
  "Recordings",
  "Settings",
] as const;
type Tab = (typeof TABS)[number];

export function HostWebinarTabs({
  webinar: w,
  registrants,
  recordings,
  onChanged,
}: {
  webinar: Webinar;
  registrants: RegistrantRow[];
  recordings: Recording[];
  onChanged: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("Registrants");
  const pending = registrants.filter((r) => r.state === "pending");

  return (
    <>
      <div className="mb-4">
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={setTab}
          // Two different meanings, both worth a badge: registrants counts what
          // needs a decision, recordings counts what is there to watch.
          counts={{
            Registrants: pending.length,
            Recordings: recordings.length,
          }}
        />
      </div>

      {tab === "Registrants" && (
        <RegistrantsTab
          webinar={w}
          registrants={registrants}
          onChanged={onChanged}
        />
      )}
      {tab === "Share" && <ShareTab webinar={w} />}
      {tab === "Stage" && <StageTab webinar={w} onChanged={onChanged} />}
      {tab === "Recordings" && (
        <RecordingsTab
          webinar={w}
          recordings={recordings}
          onChanged={onChanged}
        />
      )}
      {tab === "Settings" && <SettingsTab webinar={w} />}
    </>
  );
}

// ------------------------------------------------------------- registrants

function RegistrantsTab({
  webinar: w,
  registrants,
  onChanged,
}: {
  webinar: Webinar;
  registrants: RegistrantRow[];
  onChanged: () => void | Promise<void>;
}) {
  /* No local busy/notify state left here.
   *
   * Approving used to live in this component, which meant one `busy` flag was shared by the
   * approval buttons and the roster below and they disabled each other. ApprovalQueue owns
   * its own selection and request state now; this component only computes the queue and
   * hands it over. api.approveAll and api.setRegistrationState are still exported for
   * callers that want the older all-or-nothing and single-row shapes. */
  const pending = registrants.filter((r) => r.state === "pending");

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Registered"
          value={formatCount(w.registrantCount)}
          note={`of ${formatCount(w.attendeeLimit)} seats`}
        />
        <Stat
          label="Approval"
          value={w.approval === "manual" ? "Manual" : "Automatic"}
          note={
            w.approval === "manual" ? `${pending.length} waiting` : "No queue"
          }
        />
        {/* Contactable, not "with an account", because that is the number a host is
            actually asking about: how many of these people can I email afterwards. A guest
            gave a name and nothing else, so they are in the seat count and not in this one. */}
        <Stat
          label="Contactable"
          value={formatCount(registrants.filter((r) => !r.isGuest).length)}
          note={`${formatCount(
            registrants.filter((r) => r.isGuest).length,
          )} joined as guests`}
        />
      </div>

      {/* The approval queue. Its own component because it owns selection state and a
          batch request, and inlining that here made this file the place where two
          different jobs — reviewing a queue and reading a roster — shared one set of
          `busy` flags and fought over them. */}
      <ApprovalQueue slug={w.id} pending={pending} onChanged={onChanged} />

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Registrants</SectionTitle>
          {/* A plain link, so the browser's own download machinery handles it and
              the session cookie travels with the request. */}
          <ButtonLink
            href={api.registrantsCsvUrl(w.id)}
            size="sm"
            variant="secondary"
            prefetch={false}
          >
            Export CSV
          </ButtonLink>
        </div>

        {registrants.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            Nobody has registered yet.
          </p>
        ) : (
          // Scrolls horizontally on a phone rather than crushing four columns into
          // 340 pixels.
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[520px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] text-ink-3">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Company</th>
                  <th className="py-2 pr-3 font-medium">Registered</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {registrants.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{r.name}</span>
                        {r.isGuest && <Badge>Guest</Badge>}
                      </div>
                      {/* An empty email cell reads as a bug. It is not — a guest was never
                          asked for one — and saying so is the difference between "the export
                          is broken" and "there is nothing to follow up here". */}
                      <div className="text-[11.5px] text-ink-3">
                        {r.isGuest ? "No email — joined as a guest" : r.email}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-ink-2">
                      {r.company || "—"}
                      {r.jobTitle && (
                        <div className="text-[11.5px] text-ink-3">
                          {r.jobTitle}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-ink-2">
                      {new Date(r.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                      })}
                      {r.hasAccount && (
                        <div className="text-[11px] text-ink-3">
                          has an account
                        </div>
                      )}
                    </td>
                    <td className="py-2.5">
                      {r.state === "approved" ? (
                        <Badge tone="ok">Approved</Badge>
                      ) : r.state === "pending" ? (
                        <Badge tone="warn">Pending</Badge>
                      ) : (
                        <Badge>Declined</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {registrants.length > 0 && (
          <p className="mt-3 text-[12px] text-ink-3">
            Showing {registrants.length} of {formatCount(w.registrantCount)}.
          </p>
        )}
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------- share

function ShareTab({ webinar: w }: { webinar: Webinar }) {
  // From the operator's configured public URL, falling back to this browser's
  // origin — never a placeholder domain, which is worse than no link at all.
  const origin = useShareOrigin();

  return (
    <div className="grid gap-4">
      <Card className="p-5">
        <SectionTitle>Registration page</SectionTitle>
        {w.status === "draft" ? (
          <Alert tone="warn">
            This webinar is still a draft, so the page isn&apos;t public yet.
          </Alert>
        ) : (
          <>
            <CopyField value={`${origin}/webinars/${w.id}`} />
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
              Anyone with this link can register. Approval is{" "}
              {w.approval === "manual" ? "manual" : "automatic"}
              {w.registrationRequired
                ? "."
                : ", and registration is not required to join."}
            </p>
          </>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle>Details for a calendar invite</SectionTitle>
        <div className="grid gap-3">
          <CopyField label="Webinar ID" value={w.webinarId} />
          {w.passcode && <CopyField label="Passcode" value={w.passcode} />}
          <CopyField
            label="Full invitation"
            value={
              `${w.topic}\n` +
              `${formatDay(w.startsAt, w.timeZone)}, ` +
              `${formatTimeRange(w.startsAt, w.durationMin, w.timeZone)} ` +
              `${tzLabel(w.startsAt, w.timeZone)}\n\n` +
              `Register: ${origin}/webinars/${w.id}\n` +
              `Webinar ID: ${w.webinarId}` +
              (w.passcode ? `\nPasscode: ${w.passcode}` : "")
            }
          />
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle>Host and panelist link</SectionTitle>
        <CopyField value={`${origin}/host/${w.id}/room`} />
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
          Only you and the panelists on this webinar can use it — the server
          refuses to mint a publishing token for anyone else, so sharing it does
          not give anyone the stage.
        </p>
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------- stage

function StageTab({
  webinar: w,
  onChanged,
}: {
  webinar: Webinar;
  onChanged: () => void | Promise<void>;
}) {
  const { notify } = useToast();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFieldError(null);
    try {
      const person = await api.addPanelist(w.id, email);
      notify(`${person.name} can now present.`, "ok");
      setEmail("");
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.fields?.email)
        setFieldError(err.fields.email);
      else
        setFieldError(
          err instanceof Error ? err.message : "Could not add them.",
        );
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string, name: string) {
    setBusy(true);
    try {
      await api.removePanelist(w.id, userId);
      notify(`Removed ${name} from the stage.`, "ok");
      await onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not remove them.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <SectionTitle>On the stage · {w.panelists.length + 1}</SectionTitle>

      <div className="grid gap-2">
        <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
          <Avatar person={w.host} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">
              {w.host.name}
            </div>
            <div className="truncate text-[11.5px] text-ink-3">
              {[w.host.title, w.host.org].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Badge tone="brand">Host</Badge>
        </div>

        {w.panelists.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5"
          >
            <Avatar person={p} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{p.name}</div>
              <div className="truncate text-[11.5px] text-ink-3">
                {[p.title, p.org].filter(Boolean).join(" · ")}
              </div>
            </div>
            <Badge>Panelist</Badge>
            <button
              type="button"
              onClick={() => void remove(p.id, p.name)}
              disabled={busy}
              aria-label={`Remove ${p.name} from the stage`}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-live-soft hover:text-live disabled:opacity-40"
            >
              <TrashIcon className="size-4" />
            </button>
          </div>
        ))}
      </div>

      <form onSubmit={add} className="mt-4 border-t border-line pt-4">
        <label className="label" htmlFor="panelist-email">
          Invite a panelist
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id="panelist-email"
            type="email"
            className={`field h-9 flex-1 text-[13px] ${fieldError ? "border-live" : ""}`}
            placeholder="colleague@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button type="submit" size="sm" disabled={busy || !email}>
            {busy ? (
              <Spinner className="size-3.5" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            Add
          </Button>
        </div>
        {fieldError ? (
          <p className="mt-1.5 text-[12px] font-medium text-live">
            {fieldError}
          </p>
        ) : (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
            They need an account first: a publishing token is minted from a
            signed-in session, so there is nothing to grant an address with no
            account behind it.
          </p>
        )}
      </form>

      <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
        You can also promote an attendee onto the stage while the webinar is
        running, from the participants panel.
      </p>
    </Card>
  );
}

// ----------------------------------------------------------------- settings

/** The settings the session will run with, read from the webinar record. Editing
 *  them is the schedule form's job; showing them here is so a host can confirm
 *  what they are about to go live with without opening it. */
function SettingsTab({ webinar: w }: { webinar: Webinar }) {
  const rows: [string, boolean | string][] = [
    ["Attendees hidden from each other", w.controls.hideAttendees],
    ["Panelists muted on entry", w.controls.muteOnEntry],
    ["Panelists may unmute themselves", w.controls.allowUnmute],
    ["Attendee chat", w.controls.chatEnabled],
    ["Q&A", w.controls.qaEnabled],
    ["Raise hand", w.controls.raiseHandEnabled],
    ["Reactions", w.controls.reactionsEnabled],
    ["Locked to new attendees", w.controls.locked],
    ["Registration required", w.registrationRequired],
    ["Practice session", w.options.practiceSession],
    ["Record automatically", w.options.autoRecord],
    ["Live captions", w.options.captions],
    ["Attendee limit", formatCount(w.attendeeLimit)],
    ["Time zone", w.timeZone],
  ];

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Session settings</SectionTitle>
        <ButtonLink href={`/host/${w.id}/edit`} size="sm" variant="secondary">
          Edit
        </ButtonLink>
      </div>

      <dl className="divide-y divide-line">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-6 py-2.5"
          >
            <dt className="text-[13px] text-ink-2">{label}</dt>
            <dd className="shrink-0 text-[13px]">
              {typeof value === "boolean" ? (
                value ? (
                  <Badge tone="ok">On</Badge>
                ) : (
                  <Badge>Off</Badge>
                )
              ) : (
                <span className="text-ink-2">{value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-3">
        Everything under &ldquo;how the session starts&rdquo; can also be
        changed live from the host controls once the webinar is running.
      </p>
    </Card>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">{note}</div>
    </Card>
  );
}
