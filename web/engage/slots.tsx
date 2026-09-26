"use client";

/* The CRM's pieces that appear inside webinar screens.
 *
 * Each is a slot: the webinar screen decides WHERE it goes and passes what it already
 * holds (the form's value, the row); the slot decides WHETHER it shows and WHAT it says —
 * from the app config and the host's WhatsApp connection, which are the CRM's business.
 * A webinar screen never reads account.whatsapp or config.whatsappConnect itself.
 */

import Link from "next/link";
import { Toggle } from "@/components/controls";
import { useAppConfig, useSession } from "@/components/providers";
import { Badge, ButtonLink } from "@/components/ui";
import {
  CRMStatusNoNumber,
  CRMStatusOptedIn,
  CRMStatusOptedOut,
  type RegistrantRow,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/** The CRM's home, for links from webinar screens. */
export const ENGAGE_HOME = "/host/crm";

/** The top-nav entry for the CRM, for an account that may host. */
export const engageNavItem = { href: ENGAGE_HOME, label: "Contacts" } as const;

/* The schedule form's WhatsApp reminders switch.
 *
 * Written by hand rather than from the options table because it is the one toggle that
 * can be unavailable: without a connected WhatsApp Business account there is nothing to
 * send from, and a switch that turns on and then silently does nothing would be worse
 * than one that says why. Absent when this deployment cannot connect WhatsApp at all. */
export function WhatsAppRemindersToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const config = useAppConfig();
  const { account } = useSession();
  if (!config.whatsappConnect) return null;
  const connected = Boolean(account?.whatsapp?.connected);
  return (
    <Toggle
      checked={checked}
      onChange={onChange}
      disabled={!connected}
      label="WhatsApp reminders (confirmation, 24h and 1h before)"
      description={
        connected ? (
          <>
            Sent from {account?.whatsapp?.displayPhone || "your number"} to
            registrants who tick the WhatsApp box, and billed to your Meta account.
            Pick the template for each message under{" "}
            <Link
              href={`${ENGAGE_HOME}?view=setup`}
              className="font-medium text-brand hover:underline"
            >
              Contacts
            </Link>
            .
          </>
        ) : (
          <>
            <Link href="/account" className="font-medium text-brand hover:underline">
              Connect WhatsApp
            </Link>{" "}
            to message registrants on their phone.
          </>
        )
      }
    />
  );
}

/* The registration form's WhatsApp consent box.
 *
 * Shown when this deployment has WhatsApp at all — not whether THIS host has connected a
 * number, which is not a public page's business — so it can be offered to somebody whose
 * host has not finished connecting. The opt-in is still worth recording: it keeps.
 *
 * Only once there is a number to message: a box that asks for WhatsApp permission above an
 * empty phone field is a question with no answer, and ticking it would record a consent
 * that can never be acted on. The form sends `whatsappOptIn` only while this shows. */
export function WhatsAppOptInCheckbox({
  hasPhone,
  checked,
  onChange,
}: {
  hasPhone: boolean;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const { whatsappConnect } = useAppConfig();
  if (!whatsappConnect || !hasPhone) return null;
  return (
    <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-ink-2">
      <input
        type="checkbox"
        className="mt-0.5 size-3.5 shrink-0 accent-brand"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        Send me reminders and updates on{" "}
        <span className="font-medium text-ink">WhatsApp</span>. You can reply{" "}
        <span className="font-medium text-ink">STOP</span> at any time.
      </span>
    </label>
  );
}

/* Account settings' WhatsApp row. A pointer, not the connect card: connecting is one of
 * five setup steps and the checklist in the CRM lists all of them together. Whether it is
 * connected is stated here anyway, because that is the question somebody opens account
 * settings to answer. Only for an account that may host. */
export function WhatsAppAccountRow() {
  const { whatsappConnect } = useAppConfig();
  const { account } = useSession();
  if (!whatsappConnect || !account?.canHost) return null;
  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">WhatsApp</span>
            {account.whatsapp ? (
              <Badge tone="ok">Connected</Badge>
            ) : (
              <Badge>Not connected</Badge>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {account.whatsapp?.displayPhone
              ? `Sending from ${account.whatsapp.displayPhone}.`
              : "Send confirmations and reminders from your own business number."}
          </p>
        </div>
        <ButtonLink href={`${ENGAGE_HOME}?view=setup`} size="sm" variant="secondary">
          {account.whatsapp ? "Manage" : "Set up"}
        </ButtonLink>
      </div>
    </div>
  );
}

/* The roster's link to the same people as contacts. Not hidden behind the WhatsApp
 * connection: registrants become contacts whether or not the host connects a number, and
 * tags and notes work with no number at all. */
export function RosterContactsLink({ slug }: { slug: string }) {
  return (
    <ButtonLink href={`${ENGAGE_HOME}?webinar=${slug}`} size="sm" variant="secondary">
      View in CRM
    </ButtonLink>
  );
}

/* The roster's two WhatsApp columns, for a host who has connected an account.
 *
 * Read from the session rather than from the rows: a connected host whose registrants are
 * all guests has every cell empty, and dropping the columns then would hide the reason. */
export function useRosterWhatsAppColumns(): boolean {
  const { account } = useSession();
  return Boolean(account?.whatsapp);
}

export function RosterWhatsAppHeaders() {
  return (
    <>
      <th className="py-2 pr-3 font-medium">WhatsApp</th>
      <th className="py-2 pr-3 font-medium">Replied</th>
    </>
  );
}

export function RosterWhatsAppCells({ row }: { row: RegistrantRow }) {
  return (
    <>
      <td className="py-2.5 pr-3">
        <WhatsAppStatusBadge status={row.whatsappStatus} />
      </td>
      <td className="py-2.5 pr-3 text-ink-2">
        {/* A date, not a tick: "who has written in" is nearly always asked as "how
            long ago", and a host deciding whether to chase somebody needs that half. */}
        {row.lastInboundAt ? (
          <span className="text-ok">
            ✓ {formatRelative(row.lastInboundAt, new Date())}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
    </>
  );
}

/* Where one registrant stands on WhatsApp, in the CRM's own words — the same phrases the
 * contacts list filters by, from the same server value. An empty status is a dash, not a
 * "no": a guest gave neither a number nor an email, so nobody ever asked them. */
function WhatsAppStatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-ink-3">—</span>;
  if (status === CRMStatusOptedIn) return <Badge tone="ok">Opted in</Badge>;
  if (status === CRMStatusOptedOut) return <Badge tone="live">Opted out</Badge>;
  if (status === CRMStatusNoNumber) return <Badge>No number</Badge>;
  // Everything left is no_opt_in, which is most of a list rather than a fault.
  return <Badge>No consent</Badge>;
}
