"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  activeQuery,
  deleteMention,
  draftSegments,
  filterCandidates,
  insertMention,
  MENTION_EVERYONE,
  reconcileMentions,
  type Draft,
  type MentionCandidate,
} from "@/lib/mentions";
import { SenderAvatar } from "../sender-avatar";
import { Pill, RoleBadge } from "./chat-badges";

/* The chat composer, with @mentions.
 *
 * Still a plain <textarea>: paste, IME, spellcheck, undo, autocorrect and the phone
 * keyboard all keep working the way they already did. What makes a tag look like a
 * tag is a BACKDROP — a copy of the text laid exactly under the textarea, same font,
 * padding and wrapping, in which each "@Name" is drawn in brand blue on a soft tint.
 * The textarea's own glyphs are transparent (its caret and selection are not), so the
 * backdrop is what you read. Weight is deliberately not changed on the tag: a bolder
 * glyph is a wider glyph, and the caret would drift off the letters.
 *
 * Which ranges are tags lives in the Draft beside the text (lib/mentions.ts), and is
 * revalidated on every edit.
 */

/** How many matches the list holds. Six are visible; the rest scroll. */
const MAX_ROWS = 20;

export function MentionComposer({
  draft,
  onDraft,
  candidates,
  onSubmit,
  onPaste,
  placeholder,
  maxLength,
  footnote,
}: {
  draft: Draft;
  onDraft: (next: Draft) => void;
  /** Everyone this person may tag for the current audience — already filtered by
   *  canMention, so the list can never offer somebody the server would drop. */
  candidates: readonly MentionCandidate[];
  onSubmit: () => void;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  placeholder: string;
  maxLength: number;
  /** A line under the list, e.g. why other attendees are not in it. */
  footnote?: string;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const listId = useId();

  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  /** The "@" the reader dismissed with Esc. Typing on keeps it shut; a new "@" opens. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  /** Where the caret belongs after a programmatic edit, applied once React has
   *  written the new value — setting it before would be overwritten. */
  const pendingCaret = useRef<number | null>(null);

  const query = focused ? activeQuery(draft, caret) : null;
  const rows = query ? filterCandidates(candidates, query.query).slice(0, MAX_ROWS) : [];

  // A new query starts at the top of its list; leaving the "@" forgets an Esc.
  const queryKey = query ? `${query.start}:${query.query}` : "";
  const [activeFor, setActiveFor] = useState(queryKey);
  if (activeFor !== queryKey) {
    setActiveFor(queryKey);
    setActive(0);
    if (!query && dismissedAt !== null) setDismissedAt(null);
  }
  const open = query !== null && query.start !== dismissedAt && rows.length > 0;
  const highlighted = open ? Math.min(active, rows.length - 1) : -1;

  // After the value a programmatic edit wrote has been committed; setting the caret
  // before would be overwritten by React writing the new value.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !box.current) return;
    pendingCaret.current = null;
    box.current.setSelectionRange(at, at);
    setCaret(at);
  }, [draft]);

  useEffect(() => {
    if (highlighted < 0) return;
    document
      .getElementById(`${listId}-${highlighted}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted, listId]);

  function track(el: HTMLTextAreaElement) {
    setCaret(el.selectionStart ?? el.value.length);
    if (backdrop.current) backdrop.current.scrollTop = el.scrollTop;
  }

  function pick(person: MentionCandidate) {
    if (!query) return;
    const next = insertMention(draft, query.start, caret, person);
    pendingCaret.current = next.caret;
    onDraft({ text: next.text, mentions: next.mentions });
    setActive(0);
    box.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Mid-composition (an IME, a phone's predictive bar), keys belong to the IME.
    if (e.nativeEvent.isComposing) return;

    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((highlighted + step + rows.length) % rows.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(rows[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        // Closes the list, not whatever window the chat is in.
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(query.start);
        return;
      }
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      const el = e.currentTarget;
      const next = deleteMention(draft, el.selectionStart, el.selectionEnd, e.key);
      if (next) {
        e.preventDefault();
        pendingCaret.current = next.caret;
        onDraft({ text: next.text, mentions: next.mentions });
      }
      return;
    }

    // Enter sends, Shift+Enter breaks a line — the convention everyone already has
    // muscle memory for.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      {open && (
        <div
          className="absolute bottom-full left-0 z-20 mb-2 w-[max(100%,17.5rem)] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
          // Keeps the textarea focused through a click, so the keyboard on a phone
          // does not fold away and back between the tap and the insert.
          onMouseDown={(e) => e.preventDefault()}
        >
          <ul
            id={listId}
            role="listbox"
            aria-label="People you can mention"
            className="max-h-[15.25rem] overflow-y-auto py-1"
          >
            {rows.map((person, i) => (
              <li
                key={person.identity}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlighted}
                onClick={() => pick(person)}
                onMouseMove={() => i !== highlighted && setActive(i)}
                className={`flex min-h-10 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px] ${
                  i === highlighted ? "bg-brand-soft" : ""
                }`}
              >
                {person.identity === MENTION_EVERYONE ? (
                  <span
                    aria-hidden
                    className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-[12px] font-bold text-stage"
                  >
                    @
                  </span>
                ) : (
                  <SenderAvatar
                    name={person.name}
                    identity={person.identity}
                    size="sm"
                    ring={person.role !== "attendee"}
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {person.identity === MENTION_EVERYONE ? "everyone" : person.name}
                </span>
                {person.identity === MENTION_EVERYONE ? (
                  <span className="shrink-0 text-[11px] text-ink-3">Notify everyone who can read this</span>
                ) : person.coHost ? (
                  <Pill tone="stage">Co-host</Pill>
                ) : (
                  <RoleBadge role={person.role} />
                )}
              </li>
            ))}
          </ul>
          {footnote && (
            <p className="border-t border-line px-2.5 py-1.5 text-[11px] leading-snug text-ink-3">
              {footnote}
            </p>
          )}
        </div>
      )}

      <div className="relative rounded-lg border border-line bg-surface focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
        <div
          ref={backdrop}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap wrap-anywhere text-ink"
        >
          {draftSegments(draft).map((s, i) =>
            s.mention ? (
              <span key={i} className="rounded-[4px] bg-brand-soft text-brand">
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
          {/* A trailing newline collapses in a div but not in a textarea. */}
          {"\u200b"}
        </div>
        <textarea
          ref={box}
          className="relative block max-h-28 min-h-9 w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-relaxed break-words wrap-anywhere text-transparent caret-ink outline-none placeholder:text-ink-3 selection:bg-brand/25"
          rows={1}
          placeholder={placeholder}
          maxLength={maxLength}
          value={draft.text}
          onChange={(e) => {
            onDraft({ text: e.target.value, mentions: reconcileMentions(draft, e.target.value) });
            track(e.currentTarget);
          }}
          onSelect={(e) => track(e.currentTarget)}
          onScroll={(e) => track(e.currentTarget)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
          aria-autocomplete="list"
          aria-label="Chat message"
        />
      </div>
    </div>
  );
}
