"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, Spinner } from "@/components/controls";
import { BlockedList, RefreshTemplates } from "./crm-templates";
import { CheckIcon } from "@/components/icons";
import { useSession } from "@/components/providers";
import { Badge, Card } from "@/components/ui";
import { WhatsAppCard } from "./whatsapp-card";
import { api } from "@/lib/api";
import type { CRMSetup, CRMTemplate, Webinar } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/* Setting WhatsApp up, as a checklist a host can finish in one place.
 *
 * The feature has five steps and three of them fail in silence. Before this screen
 * existed they were spread over three places — a card in account settings, a collapsed
 * disclosure on the contacts tab, and a switch inside each webinar's own settings form —
 * and nothing anywhere said which step a host had stopped at. The common outcome was
 * somebody who had done four of the five, was sending nothing, and had no way to find
 * out why: a reminder with no template is skipped without an error, a number that was
 * never registered fails on the first send, and the per-webinar switch is off until
 * somebody turns it on.
 *
 * So every step is listed, in order, with its state and its own controls inline. Nothing
 * here is a wizard: the steps can be done in any order and out of order, a host who has
 * finished can ignore the tab, and no step blocks the rest of the CRM. What it refuses to
 * do is imply progress — a step is done when the SERVER says the thing it checks for is
 * true, never because a form on this screen was submitted.
 *
 * The one step that is not moved here is the per-webinar switch, and deliberately: it
 * defaults to off because every message is billed to the host's own Meta account, so this
 * screen names the webinars that have it off and links to each one rather than offering
 * to turn them all on from a screen about setup.
 */

const STEP_KEYS = [
  "connect",
  "register",
  "templates",
  "reminders",
  "webinars",
] as const;
type StepKey = (typeof STEP_KEYS)[number];

/* Which steps are done, as one exported rule.
 *
 * Exported because the tab badge outside this file counts the same steps, and a count
 * that disagreed with the list underneath it would be worse than no count. `null` is a
 * third answer and not a false: registering the number is only a step for an account the
 * switch is on for, and a checklist that counted a step with no button is a checklist
 * that cannot be finished.
 */
export function setupState(s: CRMSetup | null): Record<StepKey, boolean | null> {
  return {
    connect: s?.connected ?? false,
    register: !s?.registerStep ? null : s.registeredAt !== "",
    templates: (s?.sendableTemplates ?? 0) > 0,
    // Broken reminders do NOT count: a kind pointing at a template Meta has stopped
    // approving is set as far as the database is concerned and sends nothing at all.
    reminders: (s?.remindersSet ?? 0) > 0,
    webinars: (s?.webinarsWithReminders ?? 0) > 0,
  };
}

/** How many steps are still outstanding — for the badge on the tab, so the work is
 *  visible from the other three views. Zero once there is nothing left to do, which is
 *  what makes the badge disappear rather than sit there saying "0". */
export function setupTodo(s: CRMSetup | null): number {
  if (!s) return 0; // Nothing loaded yet: a badge invented before the answer arrives
  // would flash a number and then correct itself.
  return Object.values(setupState(s)).filter((done) => done === false).length;
}

export function SetupChecklist({
  setup,
  loading,
  error,
  onChanged,
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
  /* The automatic-messages pane, handed in rather than imported.
   *
   * It lives on the CRM screen because the CRM screen owns the template list it needs,
   * and passing the rendered node keeps the import pointing one way — this file is
   * imported by that one. Rendered expanded here: it used to sit inside a collapsed
   * disclosure, which is how a step nobody had done stayed invisible. */
  remindersPane,
}: {
  setup: CRMSetup | null;
  loading: boolean;
  error: string | null;
  /** Re-reads the checklist from the server. Passed to every control that could
   *  change a step's state, so finishing one moves the count without a reload. */
  onChanged: () => void;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
  remindersPane: ReactNode;
}) {
  const { account, refresh: refreshSession } = useSession();
  const state = setupState(setup);
  const steps = STEP_KEYS.filter((k) => state[k] !== null);
  const done = steps.filter((k) => state[k] === true).length;

  if (loading && !setup) {
    return (
      <Card className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </Card>
    );
  }

  const blocked = (templates ?? []).filter((t) => !t.sendable);
  const broken = setup?.remindersBroken ?? [];

  return (
    <div className="grid gap-4">
      {error && <Alert tone="error">{error}</Alert>}

      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold">
            {done === steps.length
              ? "WhatsApp is set up"
              : `${done} of ${steps.length} steps done`}
          </h2>
          {setup?.connected && (
            <p className="text-[12px] text-ink-2">
              {setup.optedInContacts === 1
                ? "1 contact can be messaged right now."
                : `${setup.optedInContacts} contacts can be messaged right now.`}
            </p>
          )}
        </div>
        {/* A bar rather than a chart. It has two numbers in it and a chart would
            need a legend to say what the second one is. */}
        <div
          className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-label="Setup progress"
        >
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-300"
            style={{ width: `${(done / steps.length) * 100}%` }}
          />
        </div>
        <p className="mt-2.5 max-w-prose text-[12.5px] leading-relaxed text-ink-2">
          Messages go from your own WhatsApp Business number and Meta bills them to
          your account, at their rates. Do these once and every webinar can use them.
        </p>
      </Card>

      <Card className="divide-y divide-line">
        <Step
          n={1}
          done={state.connect === true}
          title="Connect your WhatsApp Business account"
          hint="Meta's own dialog. You can create a number in it, or bring one you already use — either way it stays yours, and disconnecting here leaves your contacts untouched."
        >
          {/* The same card that used to live in account settings, unchanged — the
              PIN handling inside it in particular. Its own onChanged re-reads the
              session; this one also re-reads the checklist, since connecting or
              disconnecting moves two steps at once. */}
          {account && (
            <WhatsAppCard
              account={account}
              onChanged={async () => {
                await refreshSession();
                onChanged();
              }}
            />
          )}
        </Step>

        {state.register !== null && (
          <Step
            n={2}
            done={state.register === true}
            title="Register the number for sending"
            hint="A number created in Meta's dialog cannot send anything until it is registered with a six-digit PIN you choose. Nothing is sent until this is done, and nothing says so — the first reminder simply fails."
          >
            {setup?.registeredAt ? (
              <p className="text-[12px] text-ink-2">
                Registered {formatRelative(setup.registeredAt, new Date())}.
              </p>
            ) : state.connect === true ? (
              // Not a second PIN box. There is exactly one in this application, in
              // the card above, and a PIN typed into a duplicate would be a second
              // place it could leak from.
              <p className="text-[12px] text-ink-2">
                The PIN box is in the card above, under the number.
              </p>
            ) : (
              <p className="text-[12px] text-ink-2">
                Connect first — there is no number to register yet.
              </p>
            )}
          </Step>
        )}

        <Step
          n={state.register === null ? 2 : 3}
          done={state.templates === true}
          title="Get a template approved, then bring it in"
          hint="WhatsApp only lets a business message somebody who has not written in first using a template Meta has approved. You write them in WhatsApp Manager; this is where you pick them up."
        >
          <div className="grid gap-2">
            <p className="text-[12px] leading-relaxed text-ink-2">
              {setup?.templates
                ? `${setup.sendableTemplates} of ${setup.templates} can be sent from here.`
                : "No templates yet."}
              {setup?.templatesSyncedAt
                ? ` Last checked ${formatRelative(setup.templatesSyncedAt, new Date())}.`
                : ""}
            </p>
            {/* Why the others cannot be used, which the reminders pane never said.
                A host whose only template is PENDING at Meta was previously shown an
                empty picker and no reason for it. */}
            {blocked.length > 0 && <BlockedList templates={blocked} />}
            {templatesError && <Alert tone="warn">{templatesError}</Alert>}
            <div>
              <RefreshTemplates
                syncing={syncing}
                onClick={() => {
                  onRefreshTemplates();
                  onChanged();
                }}
              />
            </div>
          </div>
        </Step>

        <Step
          n={state.register === null ? 3 : 4}
          done={state.reminders === true}
          title="Choose a template for each automatic message"
          hint="The confirmation, the reminders and the recording link. A message with no template chosen is not sent, and nothing anywhere reports it."
          badge={
            broken.length > 0 ? (
              <Badge tone="warn">
                {broken.length === 1
                  ? "1 needs a new template"
                  : `${broken.length} need a new template`}
              </Badge>
            ) : null
          }
        >
          {broken.length > 0 && (
            <Alert tone="warn" title="A template stopped being available">
              {broken.length === 1 ? "One message is" : `${broken.length} messages are`}{" "}
              set to a template Meta no longer approves, so {broken.length === 1 ? "it is" : "they are"}{" "}
              being skipped. Pick another one below.
            </Alert>
          )}
          {state.connect === true ? (
            remindersPane
          ) : (
            <p className="text-[12px] text-ink-2">
              Connect WhatsApp first — templates come from your own account.
            </p>
          )}
        </Step>

        <Step
          n={state.register === null ? 4 : 5}
          done={state.webinars === true}
          title="Turn WhatsApp on for a webinar"
          hint="Each webinar decides for itself, and it is off until you switch it on. Deliberately: every message is charged to your Meta account, so nothing starts sending because you finished setting it up."
        >
          <WebinarSwitches setup={setup} />
        </Step>
      </Card>
    </div>
  );
}

function Step({
  n,
  done,
  title,
  hint,
  badge,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  hint: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex items-start gap-3 px-5 py-4">
      {/* A tick or the step's number — never a red cross. An undone step is work
          that has not happened yet, not a fault, and most hosts reading this screen
          are on their first visit. */}
      <span
        className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold ${
          done ? "bg-ok-soft text-ok" : "bg-surface-2 text-ink-2"
        }`}
        aria-hidden
      >
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13.5px] font-medium">{title}</h3>
          {done && <Badge tone="ok">Done</Badge>}
          {badge}
        </div>
        <p className="mt-0.5 max-w-prose text-[12px] leading-relaxed text-ink-2">
          {hint}
        </p>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </section>
  );
}

/** How many upcoming webinars to name. Enough to act on, few enough that the step
 *  stays a step — the whole list is one click away on the host's own dashboard. */
const WEBINARS_SHOWN = 5;

/* The webinars whose switch is off, by name, each linking to its own settings.
 *
 * Named rather than counted, because "2 of 6 have WhatsApp on" leaves a host to work
 * out WHICH four and go looking. Upcoming only: turning the switch on for a webinar
 * that has already run sends nothing, so offering it would be busywork.
 */
function WebinarSwitches({ setup }: { setup: CRMSetup | null }) {
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .hostWebinars({ tab: "upcoming", limit: WEBINARS_SHOWN })
      .then((res) => {
        if (!cancelled) setWebinars(res.items);
      })
      .catch(() => {
        // Soft: this is the one part of the step that needs a second request, and a
        // red box here would sit under a step whose own state is already known.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (setup && setup.webinarsTotal === 0) {
    return (
      <p className="text-[12px] text-ink-2">
        You have no upcoming webinars.{" "}
        <Link href="/host/new" className="font-medium text-ink underline">
          Schedule one
        </Link>{" "}
        and the switch is in its settings.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {setup && (
        <p className="text-[12px] text-ink-2">
          {setup.webinarsWithReminders} of {setup.webinarsTotal} of your webinars
          have WhatsApp reminders on.
        </p>
      )}
      {webinars === null && !failed ? (
        <Spinner className="size-4 text-ink-3" />
      ) : (
        <ul className="grid gap-1.5">
          {(webinars ?? []).map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <Link
                href={`/host/${w.id}?tab=settings`}
                className="truncate text-[12.5px] font-medium text-ink underline"
              >
                {w.topic}
              </Link>
              {w.options.whatsappReminders ? (
                <Badge tone="ok">On</Badge>
              ) : (
                <Badge>Off</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
