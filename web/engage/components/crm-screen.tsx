"use client";

import { engageApi } from "../api";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import {
  Alert,
  ConfirmModal,
  Disclosure,
  Select,
  Spinner,
  Tabs,
} from "@/components/controls";
import { Bots } from "./crm-bots";
import { Broadcasts } from "./crm-broadcasts";
import { Drips } from "./crm-drips";
import { NotesPane } from "./crm-notes";
import { SetupChecklist, setupTodo } from "./crm-setup";
import { ContactTags, TagChips, TagManager } from "./crm-tags";
import {
  BlockedList,
  RefreshTemplates,
  defaultTokens,
  exampleFor,
  renderTemplate,
  templateKey,
} from "./crm-templates";
import { ArrowLeftIcon, SearchIcon, SendIcon, WhatsAppIcon } from "@/components/icons";
import { useSession, useToast } from "@/components/providers";
import { Badge, Button, Card, Empty } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  CRMStatusNoNumber,
  CRMStatusNoOptIn,
  CRMStatusNoReply,
  CRMStatusOptedIn,
  CRMStatusOptedOut,
  CRMStatusReplied,
  FeatureCRMNotes,
  FeatureCRMTags,
  FeatureReplayLinks,
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
} from "@/lib/api-types";
import type {
  CRMContact,
  CRMContactCounts,
  CRMContactScope,
  CRMMergeField,
  CRMMessage,
  CRMNote,
  CRMReminder,
  CRMSendRequest,
  CRMSetup,
  CRMTag,
  CRMTemplate,
  NotificationKind,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/* Contacts and Inbox — the host's CRM.
 *
 * One screen rather than two routes, because a contact list whose rows do not
 * open the conversation is a spreadsheet, and an inbox with no way back to the
 * list is a dead end. Desktop shows both panes; a phone shows one at a time and
 * the row press is the navigation.
 *
 * Sending is here too, and most of what the compose box does is decline to offer
 * a send that WhatsApp would refuse: free-form text only inside the 24 hours the
 * contact's own last message opened, approved templates otherwise, nothing at all
 * to somebody who has opted out. None of that is enforced here — the server
 * re-checks every rule — but a button that produces an error is worse than a
 * button that explains itself, so the same rules shape what is on screen.
 */

/** How often an open inbox re-reads itself, while the tab is actually being
 *  looked at. Long enough not to matter to the API, short enough that a host on
 *  this screen sees a reply arrive without wondering whether to reload. */
const POLL_MS = 20_000;

/** The five views of the CRM: what is left to set up, the people, one message sent to
 *  many of them at once, the sequences that keep sending on their own, and the bots that
 *  answer without anybody here at all. Tabs rather than routes because they are the same
 *  list seen five ways — a host who has just read a reply is one click from the campaign
 *  that prompted it, or from the flow that sent it.
 *
 *  Setting up comes first because it is the order the host meets them in, and it carries
 *  a count of what is outstanding so the work is visible from the other four. It is not
 *  the DEFAULT view, though: a host arrives here to read their contacts, including the
 *  many who arrive before WhatsApp is finished. */
const CRM_VIEWS = [
  "setup",
  "contacts",
  "broadcasts",
  "sequences",
  "bots",
] as const;
type CRMView = (typeof CRM_VIEWS)[number];

const VIEW_LABELS: Record<CRMView, string> = {
  setup: "Set up",
  contacts: "Contacts",
  broadcasts: "Broadcasts",
  sequences: "Sequences",
  bots: "Bots",
};

/** The sentence under each heading. Contacts is deliberately absent: its blurb counts
 *  the list being looked at, so it is built per render and falls through to it here. */
const VIEW_BLURBS: Partial<Record<CRMView, string>> = {
  setup:
    "Five things, once. Each one is checked against your WhatsApp account rather than ticked off here, so this is what is actually true.",
  broadcasts:
    "One message to many people, from your own WhatsApp number and billed to your Meta account.",
  sequences:
    "Several messages over days, sent on their own to everybody who registers from now on.",
  bots: "A reply to somebody who writes in, with the conversation handed to you the moment the flow runs out of answers.",
};

/* The chips above the contacts list, in two labelled groups.
 *
 * Two groups and not one row of six, because they are two different partitions of the
 * same people: everybody is either replied or not, and separately everybody is one of
 * opted-in / no-consent / opted-out / no-number. A contact can be both "no reply" and
 * "no number", so six chips in one row would show parts that add up to more than the
 * heading and leave the host to work out why.
 */
const CHIP_GROUPS: {
  label: string;
  /** Only shown to a host who has WhatsApp connected. "Has written in" is a fact about
   *  a conversation that cannot exist without it; consent is recorded at registration
   *  either way, so the other group is always worth reading. */
  needsWhatsApp?: boolean;
  chips: {
    status: string;
    label: string;
    of: keyof CRMContactCounts;
    /** The segment's colour in the bar. A CSS variable rather than a hex value, so the
     *  chart follows the palette — including the dark scheme, which overrides these. */
    fill: string;
  }[];
}[] = [
  {
    label: "Conversation",
    needsWhatsApp: true,
    chips: [
      {
        status: CRMStatusReplied,
        label: "Replied",
        of: "replied",
        fill: "var(--color-brand)",
      },
      {
        status: CRMStatusNoReply,
        label: "No reply",
        of: "noReply",
        fill: "var(--color-line-2)",
      },
    ],
  },
  {
    label: "Can be messaged",
    chips: [
      {
        status: CRMStatusOptedIn,
        label: "Opted in",
        of: "optedIn",
        fill: "var(--color-ok)",
      },
      {
        status: CRMStatusNoOptIn,
        label: "No consent",
        of: "noOptIn",
        fill: "var(--color-line-2)",
      },
      {
        status: CRMStatusOptedOut,
        label: "Opted out",
        of: "optedOut",
        fill: "var(--color-live)",
      },
      {
        status: CRMStatusNoNumber,
        label: "No number",
        of: "noNumber",
        fill: "var(--color-ink-3)",
      },
    ],
  },
];

const ZERO_COUNTS: CRMContactCounts = {
  total: 0,
  replied: 0,
  noReply: 0,
  optedIn: 0,
  noOptIn: 0,
  optedOut: 0,
  noNumber: 0,
};

export function CRMScreen() {
  const { account, status } = useSession();
  const { notify } = useToast();
  const router = useRouter();
  const search = useSearchParams();
  /* Contacts unless a link asked for something else. Read once, on mount, and NOT
   * written back as the host switches tabs: an incoming link has to be able to name
   * where it means — account settings points at the setup steps, and landing on the
   * inbox instead would leave a host to find them — but which tab somebody is reading
   * is not a narrowing of the list the way ?webinar= and ?status= are, and putting
   * every tab they touched in the back button would bury the link that brought them. */
  const [view, setView] = useState<CRMView>(() => {
    const asked = (search.get("view") ?? "").trim();
    return (CRM_VIEWS as readonly string[]).includes(asked)
      ? (asked as CRMView)
      : "contacts";
  });
  const [query, setQuery] = useState("");
  /* One webinar's registrants, when a link asked for them — the "View in CRM" link
   * on a webinar's Attendees tab is the only thing that sets this.
   *
   * Read from the URL rather than held in state, so it is the address that carries the
   * filter: the host's back button undoes the narrowing, and the narrowed list is a
   * link they can keep. The narrowing itself is done by the server, which is what makes
   * it true past the first page — the list is capped at 200 contacts, and picking this
   * webinar's people out of whichever 200 arrived would silently miss the rest. */
  const webinarSlug = (search.get("webinar") ?? "").trim();
  /* Which chip is active, also from the URL and for the same reasons: a host who has
   * filtered to "no reply" can send that link to whoever chases them, and the back
   * button undoes the narrowing. The server validates it — an unknown value is refused
   * rather than answered with the whole list under a heading that names a filter — so a
   * hand-edited URL produces an error the host can read. */
  const statusFilter = (search.get("status") ?? "").trim();
  /* Which webinar that slug turned out to be, as the SERVER describes it. The name is
   * not taken from the link: a topic in a query string is a heading anybody could
   * write, and this one asserts that the webinar is the host's own. */
  const [scope, setScope] = useState<CRMContactScope | null>(null);
  const [contacts, setContacts] = useState<CRMContact[] | null>(null);
  /* Every tag this host has, for the picker beside a conversation and for the
   * manager. It arrives with the contacts list rather than in a call of its own:
   * both screens that need it are this one, and a picker that loads separately
   * from the chips it adds to would briefly disagree with them. Empty for an
   * account whose tags switch is off — the server sends nothing then. */
  const [tags, setTags] = useState<CRMTag[] | null>(null);
  const [total, setTotal] = useState(0);
  /* How the list divides up, from the server, for the chips. Zeroed rather than null so
   * the chips can render before the first answer arrives at their eventual size — and
   * they arrive whole even while a chip is active, because a host who has filtered to
   * "no reply" still needs to see how many replied in order to come back. */
  const [counts, setCounts] = useState<CRMContactCounts>(ZERO_COUNTS);
  const [whatsappConnected, setWhatsappConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* Bumped on a timer and after a write, and read by both panes: one counter is
   * what keeps the list and the open thread from disagreeing about when "now"
   * was — an opt-out applied in the thread has to change the badge in the list. */
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  /* Drop the webinar filter. replace rather than push, because "show all" undoes a
   * narrowing rather than going somewhere new: the host arrived here from a webinar,
   * and their back button should still lead to it and not to the filtered list they
   * have just finished with. */
  const showAllContacts = useCallback(() => {
    router.replace("/host/crm");
  }, [router]);

  /* Pressing a chip, as a change of address.
   *
   * replace rather than push, and the webinar filter is carried over: switching chips is
   * adjusting the same list rather than moving somewhere new, so a back button full of
   * every chip the host tried would bury the webinar they came from. Pressing the active
   * chip again clears it, which is what makes the row work as a filter with no "all"
   * button in it. */
  const setStatus = useCallback(
    (next: string) => {
      const params = new URLSearchParams();
      if (webinarSlug) params.set("webinar", webinarSlug);
      if (next && next !== statusFilter) params.set("status", next);
      const qs = params.toString();
      router.replace(`/host/crm${qs ? `?${qs}` : ""}`);
    },
    [router, statusFilter, webinarSlug],
  );

  const canHost = account?.canHost ?? false;
  /* What this account has switched on, as the server describes it. Checked again
   * on every request it gates — this only decides whether to show a pane whose
   * every call would be refused, which is a kindness rather than a permission. */
  const features = account?.features ?? [];
  const tagsOn = features.includes(FeatureCRMTags);
  const notesOn = features.includes(FeatureCRMNotes);

  /* Templates belong to the host, not to a contact, so they are loaded here and
   * handed down: they are the same list for every conversation, and re-reading
   * them each time a row is clicked would be one request per click for an answer
   * that changes about once a week. Not on `tick` either — the 20-second poll is
   * for arriving messages. */
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (status !== "signed-in" || !canHost) return;
    let cancelled = false;
    engageApi
      .crmTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplates(res.templates);
        setTemplatesError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your WhatsApp templates.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [status, canHost]);

  /* Asking Meta again, on purpose. Behind a button because it is a real Graph
   * call against a per-WABA rate limit — the host who has just created a template
   * in WhatsApp Manager is the one person who needs it, and they know they do. */
  const refreshTemplates = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await engageApi.crmTemplates(true);
      setTemplates(res.templates);
      setTemplatesError(null);
      notify(
        res.templates.length === 1
          ? "1 template from WhatsApp."
          : `${res.templates.length} templates from WhatsApp.`,
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not reach WhatsApp.",
        "error",
      );
    } finally {
      setSyncing(false);
    }
  }, [notify]);

  useEffect(() => {
    const id = setInterval(() => {
      // A background tab is not an inbox anybody is reading, and polling one for
      // hours is a cost with no reader.
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  /* The search is debounced and the FIRST load is not.
   *
   * Typing "tha" should not be three requests, but arriving on the screen should
   * not wait a quarter of a second for nothing. The empty query is the arrival
   * case and also the "cleared the box" case, both of which want the answer now.
   */
  useEffect(() => {
    if (status !== "signed-in" || !canHost) return;
    let cancelled = false;
    const run = () => {
      engageApi
        .crmContacts(query, webinarSlug, 0, statusFilter)
        .then((res) => {
          if (cancelled) return;
          setContacts(res.contacts);
          setTags(res.tags);
          setTotal(res.total);
          setCounts(res.counts);
          // Null, not left as it was: the server sends no scope once the filter is
          // gone, and a heading still naming the webinar would describe the wrong list.
          setScope(res.scope ?? null);
          setWhatsappConnected(res.whatsappConnected);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setContacts([]);
          /* And drop the scope, which is the case that matters here: a link to a
           * webinar since deleted answers 404, and keeping the old heading would put
           * "Registered for X" above an error saying there is no X. */
          setScope(null);
          setError(
            e instanceof ApiError && e.code !== "network"
              ? e.message
              : "Could not load your contacts.",
          );
        });
    };
    const delay = query.trim() ? 250 : 0;
    const timer = setTimeout(run, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, webinarSlug, statusFilter, tick, status, canHost]);

  /* What is left to set up, for the checklist and for the count on its tab.
   *
   * Loaded here rather than inside the tab so the badge is right before anybody opens it
   * — a step nobody knows is outstanding is the problem this whole tab exists for. Not on
   * `tick`: setup changes when the host does something about it, and those are the
   * moments that call reloadSetup. */
  const [setup, setSetup] = useState<CRMSetup | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupTick, setSetupTick] = useState(0);
  const reloadSetup = useCallback(() => setSetupTick((n) => n + 1), []);

  useEffect(() => {
    if (status !== "signed-in" || !canHost) return;
    let cancelled = false;
    // Not set back to true on a reload: by then the checklist is on screen, and
    // replacing five answered steps with a spinner because one of them was just
    // finished would hide the very change the host is waiting to see.
    engageApi
      .crmSetup()
      .then((res) => {
        if (cancelled) return;
        setSetup(res);
        setSetupError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSetupError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not work out what is left to set up.",
        );
      })
      .finally(() => {
        if (!cancelled) setSetupLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, canHost, setupTick]);

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  if (status === "anonymous" || !canHost) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">Contacts are for hosts</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
          Every contact belongs to the host who collected them. Sign in with a
          hosting account to see yours.
        </p>
      </Card>
    );
  }

  const selected = contacts?.find((c) => c.id === selectedId) ?? null;

  /* The sentence under the heading DEFINES the list, so a narrowed list needs a
   * different one: "everyone who registered for one of your webinars" printed above
   * one webinar's registrants is a count a host has no reason to doubt and every
   * reason to misread. Hoisted out of the view ternary below rather than nested
   * inside it — that chain is four deep already. */
  const people = total === 1 ? "1 person" : `${total} people`;
  const contactsBlurb = scope
    ? `Registered for “${scope.topic}” — ${people}.`
    : `Everyone who registered for one of your webinars or wrote to your WhatsApp number — ${people}.`;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            {VIEW_LABELS[view]}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            {VIEW_BLURBS[view] ?? contactsBlurb}
          </p>
        </div>
        {view === "contacts" && (
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Search contacts</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <input
              className="field pl-9"
              type="search"
              placeholder="Name, email or number"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
      </div>

      <Tabs<CRMView>
        tabs={CRM_VIEWS}
        value={view}
        onChange={setView}
        labels={VIEW_LABELS}
        /* The number of steps still outstanding, so a host reading their contacts can
           see there is work waiting without going looking for it. It disappears at
           zero — a badge saying "0" is an alarm about nothing. */
        counts={{ setup: setupTodo(setup) }}
      />

      {/* The leads are all still here with WhatsApp disconnected — only the
          sending is gone. Saying which is which is the difference between a
          host fixing a connection and a host thinking they lost their list. */}
      {!whatsappConnected && view !== "setup" && (
        <Alert tone="warn" title="WhatsApp isn't connected">
          Your contacts and conversations are unaffected, but nothing can be sent
          until you connect your own WhatsApp Business account.{" "}
          {/* Straight to the step, not to account settings: the card moved here,
              and sending somebody to a different screen to do one of five things
              is the arrangement this tab replaced. */}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => setView("setup")}
          >
            Set it up
          </button>
          .
        </Alert>
      )}

      {view === "setup" ? (
        <SetupChecklist
          setup={setup}
          loading={setupLoading}
          error={setupError}
          onChanged={reloadSetup}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          onRefreshTemplates={refreshTemplates}
          /* The same pane as before, rendered open instead of folded away. Handed in
             rather than imported so crm-setup does not have to import this file back:
             the templates it needs are loaded here, once, for every view. */
          remindersPane={
            <RemindersSettings
              templates={templates}
              templatesError={templatesError}
              syncing={syncing}
              onRefreshTemplates={refreshTemplates}
              onSaved={reloadSetup}
            />
          }
        />
      ) : view === "broadcasts" ? (
        <Broadcasts
          whatsappConnected={whatsappConnected}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          tags={tagsOn ? (tags ?? []) : null}
          onRefreshTemplates={refreshTemplates}
        />
      ) : view === "sequences" ? (
        <Drips
          whatsappConnected={whatsappConnected}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          onRefreshTemplates={refreshTemplates}
        />
      ) : view === "bots" ? (
        /* No templates handed down: a bot only ever replies inside the 24 hours
           the contact's own message opened, where WhatsApp allows the host's own
           words. Nothing it sends is a template. */
        <Bots whatsappConnected={whatsappConnected} />
      ) : (
        <>
          {error && <Alert tone="error">{error}</Alert>}

          {/* What a narrowed list leaves out, and the way back to all of it.
              Spelled out rather than left to be noticed: a host comparing this
              against the Attendees tab they came from will find it shorter, and
              the two reasons for that are both deliberate. Declined seats are
              excluded to match the broadcast audience for the same webinar, so
              the count here and the count there agree; guests were never in the
              CRM at all, because a contact with no email and no number is a row
              nobody can ever do anything with. */}
          {scope && (
            <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <p className="text-[13px] leading-relaxed text-ink-2">
                Declined registrations are left out, and so is anybody who joined
                as a guest without an email address or a number.{" "}
                <Link
                  href={`/host/${scope.webinarId}?tab=attendees`}
                  className="font-medium text-ink underline"
                >
                  Back to the webinar
                </Link>
              </p>
              <Button variant="secondary" size="sm" onClick={showAllContacts}>
                Show all contacts
              </Button>
            </Card>
          )}

          {/* The automatic messages used to be folded away here, which is how a host
              who had never opened that disclosure went months without knowing the
              step existed. They are step 4 of the Set up tab now — one place that
              lists every step instead of one step hidden beside the list. */}

          {/* Folded away because the subject of this screen is the list, and shown
              whether or not WhatsApp is connected: a label is a fact about a person,
              and it is still worth recording on a list nothing can be sent to. */}
          {tagsOn && (
            <Card className="px-5 py-3">
              <Disclosure
                summary={`Tags${tags && tags.length > 0 ? ` · ${tags.length}` : ""}`}
              >
                <TagManager tags={tags} onChanged={refresh} />
              </Disclosure>
            </Card>
          )}

          {/* Who these people are, before any of them are read one by one — and
              above the list rather than beside it, because it is also the control
              that narrows the list. Shown while a filtered list is EMPTY too: the
              way back out of "0 contacts" is the chip that is still lit. */}
          {!error && counts.total > 0 && (
            <ContactBreakdown
              counts={counts}
              status={statusFilter}
              onPick={setStatus}
              whatsappConnected={whatsappConnected}
            />
          )}

          {contacts === null ? (
            <div className="grid place-items-center py-20">
              <Spinner className="size-6 text-ink-3" />
            </div>
          ) : /* Nothing under an error. The Alert above has already said why the
                 list is empty, and an empty state is a second explanation that
                 contradicts the first — "no contacts yet" is a cheerful answer to
                 a request that failed. */
          error ? null : contacts.length === 0 ? (
            /* A chip can only ever count what the same request returns, so an empty
               list under a lit chip means the search is also on — the two narrowings
               are named separately because only one of them is undone by the chips
               above. */
            statusFilter ? (
              <Empty
                title={`Nobody here is “${statusLabel(statusFilter)}”`}
                hint={
                  query.trim()
                    ? "Your search is narrowing it as well — clear the search box, or pick the lit chip again to drop this filter."
                    : "Pick the lit chip again to drop the filter. The number on it counts the whole list, not the search."
                }
              />
            ) : query.trim() ? (
              <Empty
                title="No contacts match that"
                hint={
                  scope
                    ? "Search runs over names, email addresses and phone numbers — of this webinar's registrants only."
                    : "Search runs over names, email addresses and phone numbers."
                }
              />
            ) : scope ? (
              <Empty
                title="Nobody from this webinar is in your contacts"
                hint="Registrants land here as they sign up. Guests who gave neither an email address nor a phone number never do — there would be no way to reach them."
              />
            ) : (
              <Empty
                title="No contacts yet"
                hint="Anyone who registers for one of your webinars lands here, and so does anyone who messages your WhatsApp number."
              />
            )
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
              {/* One pane at a time on a phone: a 340px list beside a
                  conversation is two unreadable columns on a 390px screen. */}
              <Card
                className={`divide-y divide-line overflow-hidden ${selectedId ? "hidden lg:block" : ""}`}
              >
                {contacts.map((c) => (
                  <ContactRow
                    key={c.id}
                    contact={c}
                    active={c.id === selectedId}
                    onSelect={() => setSelectedId(c.id)}
                  />
                ))}
              </Card>

              <div className={selectedId ? "" : "hidden lg:block"}>
                {selectedId ? (
                  <Thread
                    key={selectedId}
                    contactId={selectedId}
                    fallback={selected}
                    tick={tick}
                    allTags={tagsOn ? (tags ?? []) : null}
                    notesOn={notesOn}
                    templates={templates}
                    templatesError={templatesError}
                    syncing={syncing}
                    onRefreshTemplates={refreshTemplates}
                    onChanged={refresh}
                    onBack={() => setSelectedId(null)}
                  />
                ) : (
                  <Card className="grid place-items-center px-6 py-20 text-center">
                    <p className="text-[13.5px] text-ink-2">
                      Pick a contact to read the conversation.
                    </p>
                  </Card>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- breakdown

/** A bucket's own words, for the empty state that has to name the filter it is empty
 *  under. Falls back to the wire value rather than to nothing: a status that reached
 *  the URL without a chip is still better read than blanked out. */
function statusLabel(status: string): string {
  for (const group of CHIP_GROUPS) {
    for (const chip of group.chips) {
      if (chip.status === status) return chip.label;
    }
  }
  return status;
}

/* How the list divides, as two bars and two rows of chips.
 *
 * Two, not one, and that is the whole reason this is not a single stacked bar: consent
 * and conversation are separate partitions of the same people. Somebody with no number
 * is also somebody who has never replied, so the six numbers do NOT sum to the total —
 * each group does, on its own. One bar across all six would invite exactly the reading
 * the shape of it denied.
 *
 * The chips carry every number the bars encode, as text, which is why the charts are
 * aria-hidden: a screen reader reading the bar would read the chip row twice.
 */
function ContactBreakdown({
  counts,
  status,
  onPick,
  whatsappConnected,
}: {
  counts: CRMContactCounts;
  status: string;
  onPick: (status: string) => void;
  whatsappConnected: boolean;
}) {
  /* "Has written in" is a fact about a conversation, and there are no conversations
   * before WhatsApp is connected — but consent is recorded by the registration form
   * either way, so the other group is worth reading from the first sign-up. */
  const groups = CHIP_GROUPS.filter((g) => whatsappConnected || !g.needsWhatsApp);

  return (
    <Card className="grid gap-4 px-5 py-4">
      {groups.map((group) => (
        <div key={group.label} className="grid gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[12px] font-semibold tracking-[0.02em] text-ink-2 uppercase">
              {group.label}
            </h2>
            {status !== "" && group.chips.some((c) => c.status === status) && (
              <button
                type="button"
                className="text-[12px] font-medium text-ink-2 underline"
                onClick={() => onPick(status)}
              >
                Clear filter
              </button>
            )}
          </div>

          {/* The rounded box is the div, not the chart: recharts draws rectangles and
              a radius on each segment of a stack reads as six separate bars. It also
              holds the height, so the row does not move when recharts finishes
              measuring itself — which it can only do in the browser. */}
          <div
            className="h-2.5 overflow-hidden rounded-full bg-surface-2"
            aria-hidden
          >
            <ResponsiveContainer width="100%" height={10}>
              <BarChart
                layout="vertical"
                data={[
                  Object.fromEntries([
                    ["group", group.label],
                    ...group.chips.map((c) => [c.of, counts[c.of]]),
                  ]),
                ]}
                margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
              >
                {/* Both axes hidden: a tick or a grid line here would be six labels
                    for numbers already printed underneath. The domain is pinned to the
                    total so an empty bucket is an empty width, not a rescaled one. */}
                <XAxis type="number" domain={[0, counts.total]} hide />
                <YAxis type="category" dataKey="group" hide />
                {group.chips.map((chip) => (
                  <Bar
                    key={chip.of}
                    dataKey={chip.of}
                    stackId="all"
                    fill={chip.fill}
                    barSize={10}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {group.chips.map((chip) => (
              <Chip
                key={chip.status}
                label={chip.label}
                count={counts[chip.of]}
                fill={chip.fill}
                active={status === chip.status}
                onClick={() => onPick(chip.status)}
              />
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

function Chip({
  label,
  count,
  fill,
  active,
  onClick,
}: {
  label: string;
  count: number;
  fill: string;
  active: boolean;
  onClick: () => void;
}) {
  /* An empty bucket is not a filter worth pressing — it can only ever produce the
   * list the host is already looking at, minus everybody. Still shown, because "none
   * of them opted out" is one of the more useful things this row says. */
  const dead = count === 0 && !active;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={dead}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? "border-brand bg-brand-soft text-brand"
          : dead
            ? "border-line text-ink-3"
            : "border-line text-ink-2 hover:bg-surface-2"
      }`}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ background: fill }}
        aria-hidden
      />
      {label}
      <span
        className={`tabular-nums ${active || dead ? "" : "font-medium text-ink"}`}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- reminders

/** The automatic messages, in the order they reach somebody, with the host's
 *  words for them: `wa_reminder` is our name for it, not theirs. */
const REMINDER_KINDS: {
  kind: NotificationKind;
  label: string;
  hint: string;
  /** When set, the row is only shown to an account with that switch on. The
   *  others are the reminders every host has always had. */
  feature?: string;
}[] = [
  {
    kind: NotifyWhatsAppConfirmed,
    label: "When somebody registers",
    hint: "Sent as soon as they register — or as soon as you approve them, on a webinar that needs approval.",
  },
  {
    kind: NotifyWhatsAppReminder,
    label: "Before it starts",
    /* One template for every reminder time: the times are per webinar, on its
     * schedule form, and "How soon it starts" fills in "in 1 hour" for each. */
    hint: "Sent at each of the webinar's reminder times (set on the webinar; a day and an hour before by default). Use “How soon it starts” for “in 1 hour”, “in 24 hours”.",
  },
  {
    kind: NotifyWhatsAppReplay,
    label: "When you publish the recording",
    /* Not "after the webinar": nothing is sent when a session ends, because the
     * host has not decided the recording may be watched yet. Publishing it is
     * that decision, and it is the only one — see the note in 0049. */
    hint: "Sent once, to everybody who registered, when you switch on public viewing for a recording. Everyone gets the email; this is the WhatsApp copy. The per-webinar reminder switch does not apply to it — publishing is the decision.",
    feature: FeatureReplayLinks,
  },
];

/* Which template each automatic message uses.
 *
 * A host-level setting and not a per-webinar one, because the sentence does not
 * change per webinar — the facts in it do, which is what the merge fields are.
 * The per-webinar half of the decision is the WhatsApp switch in the schedule
 * form, and nothing is sent for a webinar that does not have it on.
 *
 * There is no default template and no fallback. Meta only delivers templates it
 * has approved, so a name this application invented would be a rejection rather
 * than a message — a kind with nothing chosen is simply not sent.
 */
function RemindersSettings({
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
  /* Told after a successful save, so the checklist this pane sits inside can
   * re-read its own state. It must be the server's answer and not this pane's:
   * saving a kind against a template Meta has since paused stores the row and
   * still sends nothing, and only the server knows that. */
  onSaved,
}: {
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
  onSaved?: () => void;
}) {
  const { notify } = useToast();
  const { account } = useSession();
  /* The replay row is only offered to an account that has it. A host who cannot
   * send the message should not be choosing a template for it — and the row
   * would save happily while nothing ever went out, which is the one outcome
   * worth designing away. */
  const shown = REMINDER_KINDS.filter(
    (k) => !k.feature || (account?.features ?? []).includes(k.feature),
  );
  const [rows, setRows] = useState<CRMReminder[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmReminders()
      .then((res) => {
        if (cancelled) return;
        setRows(res.reminders);
        setFields(res.fields);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your automatic messages.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const usable = (templates ?? []).filter((t) => t.sendable);

  function update(kind: string, change: Partial<CRMReminder>) {
    setRows((prev) =>
      (prev ?? []).map((r) => (r.kind === kind ? { ...r, ...change } : r)),
    );
  }

  async function save() {
    if (rows === null) return;
    setSaving(true);
    try {
      const res = await engageApi.setCrmReminders({ reminders: rows });
      setRows(res.reminders);
      setError(null);
      notify("Automatic messages saved.", "ok");
      onSaved?.();
    } catch (e: unknown) {
      /* The server's sentence, because every refusal here names the template or
       * the field that is wrong — "could not save" would leave a host guessing
       * which of three rows it meant. */
      const message =
        e instanceof ApiError ? e.message : "Could not save those messages.";
      setError(message);
      notify(message, "error");
    } finally {
      setSaving(false);
    }
  }

  if (rows === null || templates === null) {
    return (
      <div className="flex items-center gap-2 py-3 text-[12px] text-ink-2">
        <Spinner className="size-4 text-ink-3" />
        Loading your automatic messages…
      </div>
    );
  }

  if (usable.length === 0) {
    return (
      <div className="grid gap-2 py-1">
        <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
          {templatesError ?? "You have no approved WhatsApp templates yet."} An
          automatic message can only be an approved template: it arrives when
          the contact has not written in, and WhatsApp does not let a business
          send its own words then. Write one in WhatsApp Manager and Meta will
          review it.
        </p>
        <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
      </div>
    );
  }

  // A kind whose template no longer has a value for every {{n}} cannot be saved,
  // and Meta would refuse it anyway — a mismatch is rejected outright rather
  // than sent with a blank.
  const incomplete = rows.some((r) => {
    if (!r.template) return false;
    const t = usable.find(
      (x) => x.name === r.template && x.language === r.language,
    );
    if (!t) return false;
    return Array.from({ length: t.variables }, (_, i) => r.params[i]).some(
      (v) => !v,
    );
  });

  return (
    <div className="grid gap-4 py-1">
      <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
        Sent to registrants who ticked the WhatsApp box, from your own WhatsApp
        Business number and billed to your Meta account. Each webinar decides
        whether to use them — the switch is in its settings, and it is off until
        you turn it on.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      {shown.map(({ kind, label, hint }) => {
        const row =
          rows.find((r) => r.kind === kind) ??
          ({ kind, template: "", language: "", params: [] } as CRMReminder);
        /* The tokens this kind may be filled with. The replay link only has a
         * value on the replay message — offering it on a reminder would produce
         * a sentence whose whole subject is a dash, and the server refuses it
         * there anyway. */
        const usableFields = fields.filter(
          (f) => !f.onlyKind || f.onlyKind === kind,
        );
        const template = usable.find(
          (t) => t.name === row.template && t.language === row.language,
        );
        // A template that was chosen and has since been paused or deleted at
        // Meta. Said out loud rather than silently shown as "Don't send", which
        // would read as a setting the host had made.
        const missing = row.template !== "" && !template;
        const tokens = Array.from(
          { length: template?.variables ?? 0 },
          (_, i) => row.params[i] ?? "",
        );

        return (
          <div key={kind} className="grid gap-2 border-t border-line pt-3">
            <div>
              <p className="text-[13px] font-medium">{label}</p>
              <p className="mt-0.5 text-[11.5px] text-ink-3">{hint}</p>
            </div>

            {missing && (
              <Alert tone="warn">
                <span className="font-medium">{row.template}</span> is not
                available in your WhatsApp account any more, so this message is
                not being sent. Pick another one.
              </Alert>
            )}

            <Select
              label="Template"
              id={`reminder-${kind}`}
              value={template ? templateKey(template) : ""}
              onChange={(next) => {
                const picked = usable.find((t) => templateKey(t) === next);
                if (!picked) {
                  update(kind, { template: "", language: "", params: [] });
                  return;
                }
                update(kind, {
                  template: picked.name,
                  language: picked.language,
                  // Prefilled in the order the fields are listed, so a newly
                  // picked template is already valid: name, then topic, then
                  // when. Changing one is a click; getting one wrong loses a
                  // message.
                  params: defaultTokens(picked.variables, usableFields),
                });
              }}
            >
              <option value="">Don&apos;t send this one</option>
              {usable.map((t) => (
                <option key={templateKey(t)} value={templateKey(t)}>
                  {t.name} · {t.language} · {t.category.toLowerCase()}
                </option>
              ))}
            </Select>

            {template && (
              <>
                {tokens.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {tokens.map((token, i) => (
                      <Select
                        key={i}
                        label={`Fill {{${i + 1}}} with`}
                        id={`reminder-${kind}-${i}`}
                        value={token}
                        onChange={(next) =>
                          update(kind, {
                            params: tokens.map((v, j) => (j === i ? next : v)),
                          })
                        }
                      >
                        {token === "" && <option value="">Choose…</option>}
                        {usableFields.map((f) => (
                          <option key={f.token} value={f.token}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                    ))}
                  </div>
                )}

                {/* The message as one registrant will read it, with the example
                    values. A host approving "Hi {{1}}" has not read what they
                    are about to send to a thousand people. */}
                <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
                  {template.header && (
                    <p className="text-[12.5px] font-semibold">
                      {template.header}
                    </p>
                  )}
                  <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap">
                    {renderTemplate(
                      template.body ?? "",
                      tokens.map((t) => exampleFor(fields, t)),
                    )}
                  </p>
                  {template.footer && (
                    <p className="mt-1 text-[11px] text-ink-3">
                      {template.footer}
                    </p>
                  )}
                </div>

                {template.category === "MARKETING" && (
                  <p className="text-[11.5px] leading-relaxed text-ink-3">
                    This is a marketing template. It is still only sent to
                    people who ticked the WhatsApp box when they registered.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={saving || incomplete}
        >
          {saving && <Spinner className="size-3.5" />}
          Save messages
        </Button>
      </div>
      {incomplete && (
        <p className="text-[11.5px] text-ink-3">
          Every placeholder needs something to fill it — WhatsApp rejects a
          message with a blank in it rather than sending the rest.
        </p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- list

function ContactRow({
  contact: c,
  active,
  onSelect,
}: {
  contact: CRMContact;
  active: boolean;
  onSelect: () => void;
}) {
  const last = c.lastMessage;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors ${
        active ? "bg-brand-soft" : "hover:bg-surface-2"
      }`}
    >
      <span
        className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-[11.5px] font-semibold text-ink-2"
        aria-hidden
      >
        {initialsOf(c)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-medium">
            {displayName(c)}
          </span>
          {/* Whichever timestamp there is: activity if they have ever been in
              touch, otherwise the day they were collected. A row with no date
              at all reads like a bug. */}
          <span className="shrink-0 text-[11px] text-ink-3">
            {whenText(c.lastSeenAt || c.createdAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-ink-2">
          {last ? previewOf(last) : c.phone || c.email || "No contact details"}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ConsentBadge contact={c} />
          {/* Whether this person has ever written in, which consent does not answer
              and the preview line above cannot: lastMessage is the last message in
              either direction, so a host who wrote last makes their own contact look
              like a stranger. No badge for the ones who never have — most of a list
              is silent, and a marker on every quiet row marks nothing. */}
          {c.lastInboundAt && <Badge tone="brand">Replied</Badge>}
          {/* Read-only here. The list is for finding somebody, and the chips are
              what a host scans it by — they are edited in the conversation, where
              the reason for a label is on screen beside it. Empty for an account
              without the tags switch, which the server decides. */}
          <TagChips tags={c.tags ?? []} />
        </span>
      </span>
    </button>
  );
}

/** The one fact about a contact that decides what a host may do with them, so it
 *  is on every row rather than only in the detail pane. */
function ConsentBadge({ contact: c }: { contact: CRMContact }) {
  if (!c.phone) return <Badge>Email only</Badge>;
  if (c.whatsappOptOutAt) return <Badge tone="live">Opted out</Badge>;
  if (c.whatsappOptIn) {
    return (
      <Badge tone="ok">
        <WhatsAppIcon className="size-3" />
        Opted in
      </Badge>
    );
  }
  // A number with no opt-in is not a mistake — it is most of a list — and the
  // wording has to be neutral enough that nobody reads it as "fix this".
  return <Badge>No WhatsApp consent</Badge>;
}

// ------------------------------------------------------------------- thread

function Thread({
  contactId,
  fallback,
  tick,
  allTags,
  notesOn,
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
  onChanged,
  onBack,
}: {
  contactId: string;
  /** The row the host clicked, shown while the thread loads so the pane opens
   *  with a name in it rather than a spinner where the name will be. */
  fallback: CRMContact | null;
  tick: number;
  /** Every tag the host has, for the picker — or null when the account does not
   *  have tags, which is not the same as having none of them. */
  allTags: CRMTag[] | null;
  notesOn: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
  onChanged: () => void;
  onBack: () => void;
}) {
  const { notify } = useToast();
  const [contact, setContact] = useState<CRMContact | null>(fallback);
  const [messages, setMessages] = useState<CRMMessage[] | null>(null);
  // Arrives with the thread, then kept here: writing a note must not make the
  // whole conversation reload underneath the pane the host is typing in.
  const [notes, setNotes] = useState<CRMNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  /* Both from the server, and neither derivable here. The window runs from the
   * contact's last inbound message on the server's clock — the message list is
   * capped, and the reader's timezone is not the one Meta enforces — and the
   * connection can be gone while every contact is still in place. */
  const [windowUntil, setWindowUntil] = useState("");
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmThread(contactId)
      .then((res) => {
        if (cancelled) return;
        setContact(res.contact);
        setMessages(res.messages);
        setNotes(res.notes);
        setWindowUntil(res.serviceWindowUntil ?? "");
        setConnected(res.whatsappConnected);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMessages([]);
        setError(
          e instanceof ApiError && e.status === 404
            ? "That contact is no longer there."
            : "Could not load the conversation.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, tick]);

  /* Taking a conversation over from a bot, and handing it back.
   *
   * On the contact rather than on the flow they are in, because that is the scope of
   * the decision: "I am dealing with this person" has to hold for their next message
   * too, which may arrive after the flow has ended. Nothing is undone by it — what
   * the bot already said stays in the thread, labelled. */
  async function setBotPaused(paused: boolean) {
    setBusy(true);
    try {
      const updated = await engageApi.setCrmContactBot(contactId, { paused });
      setContact(updated);
      onChanged();
      notify(
        paused
          ? "Yours now — no bot answers this contact until you hand it back."
          : "Handed back. A bot can answer their next message.",
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not change that.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function optOut() {
    setBusy(true);
    try {
      const updated = await engageApi.crmOptOut(contactId);
      setContact(updated);
      setConfirming(false);
      onChanged();
      notify("Recorded — nothing will be sent to this contact.", "ok");
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not record the opt-out.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  /* A sent message is appended from the send's own response rather than waited
   * for: it already carries the server's id and status, and a conversation that
   * shows nothing for a second after the press reads as a failure. onChanged
   * re-reads the list behind it so the row's preview agrees. */
  function recordSent(msg: CRMMessage) {
    setMessages((prev) => [...(prev ?? []), msg]);
    onChanged();
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 lg:hidden"
          aria-label="Back to contacts"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">
            {contact ? displayName(contact) : "Contact"}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
            {[contact?.phone, contact?.email, contact?.company]
              .filter(Boolean)
              .join(" · ") || "No contact details"}
          </div>
          {contact && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ConsentBadge contact={contact} />
              {contact.botPausedAt && (
                <Badge tone="warn">Yours, not a bot&apos;s</Badge>
              )}
              {contact.source && <Badge>From {contact.source}</Badge>}
            </div>
          )}
          {/* In the header rather than in a sidebar: a label is a fact about this
              person, and the moment to apply one is while their own words are on
              screen — which is also when a `tag_added` sequence is the thing the
              host actually meant to start. */}
          {contact && allTags !== null && (
            <div className="mt-2">
              <ContactTags
                contactId={contactId}
                tags={contact.tags ?? []}
                all={allTags}
                onChanged={(next) => {
                  setContact({ ...contact, tags: next });
                  // The row behind this pane shows the same chips.
                  onChanged();
                }}
              />
            </div>
          )}
        </div>
        {/* Offered when a bot has actually spoken in this conversation, and always
            once one has been taken over: a host with no bots should not be reading
            about them, and a host who has taken one over needs the way back. */}
        {contact?.phone &&
          (contact.botPausedAt || (messages ?? []).some((m) => m.fromBot)) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setBotPaused(!contact.botPausedAt)}
            >
              {busy ? (
                <Spinner className="size-3.5" />
              ) : contact.botPausedAt ? (
                "Let the bot answer again"
              ) : (
                "Take over from the bot"
              )}
            </Button>
          )}
        {/* Offered for anybody with a number, opted in or not: a host who has
            been told "don't message me" on a call needs to write it down before
            a broadcast exists to catch them out. Hidden once it is recorded,
            because the second press would change nothing — the FIRST refusal is
            the one that counts. */}
        {contact?.phone && !contact.whatsappOptOutAt && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Mark opted out
          </Button>
        )}
      </div>

      {error && (
        <div className="px-4 py-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {messages === null ? (
        <div className="grid place-items-center py-16">
          <Spinner className="size-5 text-ink-3" />
        </div>
      ) : messages.length === 0 ? (
        <p className="px-4 py-12 text-center text-[13px] text-ink-2">
          No messages with this contact yet.
        </p>
      ) : (
        <div className="grid gap-2.5 px-4 py-4">
          {messages.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
        </div>
      )}

      {contact && (
        <Compose
          contact={contact}
          windowUntil={windowUntil}
          connected={connected}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          onRefreshTemplates={onRefreshTemplates}
          onSent={recordSent}
        />
      )}

      {/* Below the compose box, which is the whole point of where it is: the two
          are next to each other because a host reaches for one when they have
          decided not to use the other. */}
      {notesOn && (
        <NotesPane contactId={contactId} notes={notes} onChanged={setNotes} />
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={optOut}
        busy={busy}
        title="Mark as opted out?"
        body="Nothing will be sent to this contact on WhatsApp. You cannot undo this from here — only they can opt in again, by asking to or by registering with the box ticked."
        confirmLabel="Mark opted out"
      />
    </Card>
  );
}

function Bubble({ message: m }: { message: CRMMessage }) {
  const inbound = m.direction === "in";
  const failed = m.status === "failed";
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div className="max-w-[85%] min-w-0">
        <div
          className={`rounded-2xl px-3 py-2 text-[13px] leading-relaxed break-words ${
            inbound
              ? "rounded-bl-md bg-surface-2 text-ink"
              : failed
                ? "rounded-br-md border border-live/30 bg-live-soft text-ink"
                : "rounded-br-md bg-brand text-white"
          }`}
        >
          {m.body ? (
            <span className="whitespace-pre-wrap">{m.body}</span>
          ) : (
            // A sticker, a location pin, a voice note: the body is genuinely
            // empty, and skipping the message would leave a gap in a
            // conversation the host is trying to follow.
            <span className="italic opacity-80">{kindText(m.kind)}</span>
          )}
        </div>
        <div
          className={`mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-3 ${
            inbound ? "" : "justify-end"
          }`}
        >
          <span>{whenText(m.createdAt)}</span>
          {!inbound && <span>· {m.status}</span>}
          {/* Which half of a handed-over conversation the host did not write. The
              bot's name rather than "automatic": the host named it, and the name
              is what tells them which flow to go and fix. */}
          {m.fromBot && <span>· {m.fromBot}</span>}
          {m.templateName && <span>· {m.templateName}</span>}
        </div>
        {/* Meta's own words, kept verbatim by the webhook. Usually something
            only the host can fix — an unpaid WABA, a number not registered —
            and unfixable if we paraphrase it into "delivery failed". */}
        {failed && m.error && (
          <p
            className={`mt-0.5 text-[11px] text-live ${inbound ? "" : "text-right"}`}
          >
            {m.error}
          </p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ compose

/** Meta's own limit on a free-form message, enforced by the server too. Here it
 *  is a maxLength rather than an error, because a box that stops accepting
 *  characters is a better explanation than a refusal after the press. */
const TEXT_MAX = 4096;

type ComposeMode = "reply" | "template";

/* The compose box, which mostly consists of not offering a send.
 *
 * WhatsApp allows a business exactly two things: its own words, for 24 hours
 * after the contact last wrote to it, and an approved template at any time. So
 * there are two boxes, and which one is available is not a preference — outside
 * the window the typing box does not exist, because Meta would reject what it
 * produced and the host would have lost what they wrote.
 *
 * Consent is ours rather than Meta's and cuts across both: a contact who has
 * opted out gets nothing in any category, and a MARKETING template needs the
 * opt-in that the registration form's tick box is for. Both are checked again on
 * the server, which is what actually enforces them; what they do here is explain
 * themselves before the press instead of after it.
 */
function Compose({
  contact,
  windowUntil,
  connected,
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
  onSent,
}: {
  contact: CRMContact;
  /** RFC3339, or empty when no window is open. */
  windowUntil: string;
  connected: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
  onSent: (msg: CRMMessage) => void;
}) {
  const { notify } = useToast();
  const [mode, setMode] = useState<ComposeMode>("reply");
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState("");
  /** One box per `{{n}}`, by position. Sparse while it is being filled in. */
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  /* Opted out unless a later opt-in overrode it, which is exactly what the
   * server's computed whatsappOptIn already answers. */
  const optedOut = Boolean(contact.whatsappOptOutAt) && !contact.whatsappOptIn;
  /* No clock of our own: the server sends a deadline only while the window is
   * still open, and the thread re-reads itself every 20 seconds. Between two
   * reads this can be up to 20 seconds stale, which the server catches — it
   * refuses the send and the host still has what they typed. A second clock
   * running in the reader's timezone would be a worse answer, not a fresher one. */
  const open = windowUntil !== "";

  // The three cases where there is nothing to compose. Said in a line rather
  // than shown as a disabled box, which reads as something failing to load.
  if (!contact.phone) {
    return (
      <ComposeNote>
        This contact left an email address and no WhatsApp number, so there is
        nothing to send to.
      </ComposeNote>
    );
  }
  if (optedOut) {
    return (
      <ComposeNote>
        This contact has asked not to receive WhatsApp messages. Nothing can be
        sent to them — only they can opt in again.
      </ComposeNote>
    );
  }
  if (!connected) {
    return (
      <ComposeNote>
        Connect your own WhatsApp Business account in{" "}
        <Link href="/account" className="font-medium underline">
          account settings
        </Link>{" "}
        to reply from here.
      </ComposeNote>
    );
  }

  const usable = (templates ?? []).filter((t) => t.sendable);
  const blocked = (templates ?? []).filter((t) => !t.sendable);
  const template = usable.find((t) => templateKey(t) === chosen) ?? usable[0];
  // Exactly as many values as the template declares, in order: Meta rejects a
  // mismatch outright rather than leaving a blank.
  const filled = template
    ? Array.from({ length: template.variables }, (_, i) =>
        (params[i] ?? "").trim(),
      )
    : [];
  const needsOptIn =
    template?.category === "MARKETING" && !contact.whatsappOptIn;

  const typing = mode === "reply" && open;
  const canSend = typing
    ? text.trim() !== ""
    : Boolean(template) && !needsOptIn && filled.every((v) => v !== "");

  async function send() {
    /* One or the other, never both — the server refuses a request carrying both
     * rather than guessing which was meant. */
    const request: CRMSendRequest | null = typing
      ? { body: text.trim() }
      : template
        ? {
            template: template.name,
            language: template.language,
            params: filled,
          }
        : null;
    if (!request) return;

    setBusy(true);
    try {
      const msg = await engageApi.crmSend(contact.id, request);
      onSent(msg);
      setText("");
      setParams([]);
      notify("Sent.", "ok");
    } catch (e: unknown) {
      /* The server's own sentence, which is usually Meta's: an unpaid WABA, a
       * template paused an hour ago, a window that closed while this box was
       * open. All of them are things only the host can act on. */
      notify(
        e instanceof ApiError ? e.message : "Could not send that message.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line bg-surface-2 px-4 py-3">
      {/* Only offered while the window is actually open. A tab that explains why
          it is empty is still a tab a host will try first. */}
      {open && (
        <div className="-mx-4 -mt-3 mb-3 px-4">
          <Tabs<ComposeMode>
            tabs={["reply", "template"] as const}
            value={mode}
            onChange={setMode}
            labels={{ reply: "Reply", template: "Template" }}
          />
        </div>
      )}

      {typing ? (
        <div className="grid gap-2">
          <label className="sr-only" htmlFor="crm-reply">
            Your reply
          </label>
          <textarea
            id="crm-reply"
            className="field min-h-20 resize-y py-2"
            maxLength={TEXT_MAX}
            placeholder={`Reply to ${displayName(contact)}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11.5px] text-ink-3">
              WhatsApp&apos;s 24-hour window closes{" "}
              {formatRelative(windowUntil, new Date())}. After that, only an
              approved template can be sent.
            </p>
            <SendButton busy={busy} disabled={!canSend} onClick={send} />
          </div>
        </div>
      ) : templates === null ? (
        <div className="flex items-center gap-2 py-2 text-[12px] text-ink-2">
          <Spinner className="size-4 text-ink-3" />
          Loading your templates…
        </div>
      ) : usable.length === 0 ? (
        <div className="grid gap-2">
          <p className="text-[12px] leading-relaxed text-ink-2">
            {templatesError ??
              (blocked.length > 0
                ? "None of your templates can be sent from here yet."
                : "You have no WhatsApp templates yet.")}{" "}
            Templates are written and approved in WhatsApp Manager — Meta has to
            approve the wording before it can be sent to anybody.
          </p>
          {blocked.length > 0 && <BlockedList templates={blocked} />}
          <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
        </div>
      ) : (
        <div className="grid gap-2.5">
          <Select
            label="Template"
            id="crm-template"
            value={template ? templateKey(template) : ""}
            onChange={(next) => {
              setChosen(next);
              // Values belong to the template they were typed for; carrying them
              // across would put somebody's first name in a date field.
              setParams([]);
            }}
          >
            {usable.map((t) => (
              <option key={templateKey(t)} value={templateKey(t)}>
                {t.name} · {t.language} · {t.category.toLowerCase()}
              </option>
            ))}
          </Select>

          {template && (
            <>
              {template.variables > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {filled.map((_, i) => (
                    <div key={i}>
                      <label className="label" htmlFor={`crm-param-${i}`}>
                        {`Value for {{${i + 1}}}`}
                      </label>
                      <input
                        id={`crm-param-${i}`}
                        className="field"
                        value={params[i] ?? ""}
                        onChange={(e) =>
                          setParams((prev) => {
                            const next = [...prev];
                            next[i] = e.target.value;
                            return next;
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* The message as the contact will read it, placeholders filled.
                  A host approving "Hi {{1}}" has not read what they are
                  sending. */}
              <div className="rounded-xl border border-line bg-surface px-3 py-2">
                {template.header && (
                  <p className="text-[12.5px] font-semibold">
                    {template.header}
                  </p>
                )}
                <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap">
                  {renderTemplate(template.body ?? "", filled)}
                </p>
                {template.footer && (
                  <p className="mt-1 text-[11px] text-ink-3">
                    {template.footer}
                  </p>
                )}
              </div>

              {needsOptIn && (
                <Alert tone="warn">
                  This is a marketing template and this contact has not opted in
                  to marketing messages. A utility template — a reminder about a
                  webinar they registered for — can still be sent.
                </Alert>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
            <SendButton busy={busy} disabled={!canSend} onClick={send} />
          </div>

          {!open && (
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              Only a template can be sent right now. WhatsApp allows a business
              to write in its own words for 24 hours after the contact&apos;s
              last message, and this one has not written recently.
            </p>
          )}
          {blocked.length > 0 && <BlockedList templates={blocked} />}
        </div>
      )}
    </div>
  );
}

/** The footer where the compose box would be, for the contacts there is nothing
 *  to compose to. Same place and same weight, so the pane does not change shape
 *  depending on who is selected. */
function ComposeNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-t border-line bg-surface-2 px-4 py-3 text-[12px] leading-relaxed text-ink-2">
      {children}
    </p>
  );
}

function SendButton({
  busy,
  disabled,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      onClick={onClick}
      disabled={busy || disabled}
      className="ml-auto"
    >
      {busy ? (
        <Spinner className="size-3.5" />
      ) : (
        <SendIcon className="size-3.5" />
      )}
      Send
    </Button>
  );
}

// ------------------------------------------------------------------ helpers

/** A contact always has SOMETHING to be called: a name, a number, an email, and
 *  in the worst case the fact that we do not know. An empty row is unclickable
 *  in practice. */
function displayName(c: CRMContact): string {
  return c.name || c.phone || c.email || "Unknown contact";
}

function initialsOf(c: CRMContact): string {
  const words = (c.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Relative while it is recent and useful ("2 hours ago"), which is the whole of
 *  what an inbox row needs; the full timestamp is a tooltip nobody has asked for
 *  yet. Empty for a missing date rather than "Invalid Date". */
function whenText(iso?: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return formatRelative(iso, new Date());
}

function previewOf(m: CRMMessage): string {
  const text = m.body || kindText(m.kind);
  return m.direction === "out" ? `You: ${text}` : text;
}

/** What to show for a message whose content is not text. Meta's own vocabulary,
 *  turned into a sentence rather than left as a bare `document`. */
function kindText(kind?: string): string {
  switch (kind) {
    case "image":
      return "Sent a photo";
    case "video":
      return "Sent a video";
    case "voice":
      return "Sent a voice note";
    case "audio":
      return "Sent audio";
    case "document":
      return "Sent a document";
    case "sticker":
      return "Sent a sticker";
    case "location":
      return "Shared a location";
    case "contacts":
      return "Shared a contact";
    case "button":
    case "interactive":
      return "Tapped a button";
    case "":
    case undefined:
      return "No message text";
    default:
      // A type Meta added after this was written. Naming it is more use to a
      // host than "unsupported message".
      return `Sent a ${kind}`;
  }
}
