"use client";

import { useState } from "react";
import { Alert, ConfirmModal, Menu, Spinner, type MenuItem } from "./controls";
import { CloseIcon, PlusIcon } from "./icons";
import { useToast } from "./providers";
import { Button } from "./ui";
import { ApiError, api } from "@/lib/api";
import { TagMaxLength, TagMaxPerHost } from "@/lib/api-types";
import type { CRMTag } from "@/lib/api-types";

/* Tags: the host's own opinion about somebody, and the only segment they define.
 *
 * Three pieces, all small, all here because they are the same idea seen from
 * different rows: the chips on a contact, the way one is put on or taken off, and
 * the list where they are created and renamed.
 *
 * What makes a label worth a screen is that something acts on it — a broadcast
 * addressed to it, a sequence that starts when it is applied, a bot step that
 * applies one mid-conversation. So a click on a chip is not cosmetic, and this is
 * the reason "remove" is offered without a confirmation while "delete the tag
 * itself" asks: taking VIP off one person is an edit, and deleting VIP takes it
 * off everybody at once.
 */

/** Read-only chips, for a contact row. Nothing is clickable: the list is a list,
 *  and a stray click there should open the conversation and not relabel somebody. */
export function TagChips({ tags }: { tags: CRMTag[] }) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((t) => (
        <span
          key={t.id}
          className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2"
        >
          {t.name}
        </span>
      ))}
    </>
  );
}

/* The chips on an open conversation, with a way to add and remove one.
 *
 * `all` is every tag the host has, so the picker is a list of what exists rather
 * than a text box: a label typed twice is two labels, and the one thing that
 * would quietly ruin a segment is a "VIP " with a trailing space. Creating a new
 * one is done in the manager, deliberately one step away from a conversation.
 */
export function ContactTags({
  contactId,
  tags,
  all,
  onChanged,
}: {
  contactId: string;
  /** The tags this contact carries, from the server. */
  tags: CRMTag[];
  /** Every tag this host has, for the picker. */
  all: CRMTag[];
  /** The contact's new set, so the pane re-renders from the server's answer. */
  onChanged: (tags: CRMTag[]) => void;
}) {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);

  const on = new Set(tags.map((t) => t.id));
  const available = all.filter((t) => !on.has(t.id));

  async function add(tagId: string) {
    setBusy(true);
    try {
      const res = await api.addCrmContactTag(contactId, tagId);
      onChanged(res.tags);
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not add that tag.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(tagId: string) {
    setBusy(true);
    try {
      const res = await api.removeCrmContactTag(contactId, tagId);
      onChanged(res.tags);
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not remove that tag.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  const items: MenuItem[] =
    available.length === 0
      ? [
          {
            kind: "label",
            text: all.length === 0 ? "No tags yet" : "Already has them all",
          },
        ]
      : [
          { kind: "label", text: "Add a tag" },
          ...available.map(
            (t): MenuItem => ({
              kind: "action",
              label: t.name,
              onSelect: () => void add(t.id),
            }),
          ),
        ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1 rounded-full bg-surface-3 py-0.5 pr-1 pl-2 text-[11px] font-medium text-ink-2"
        >
          {t.name}
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove(t.id)}
            aria-label={`Remove ${t.name}`}
            className="grid size-4 place-items-center rounded-full text-ink-3 hover:bg-surface-0 hover:text-ink disabled:opacity-40"
          >
            <CloseIcon className="size-2.5" />
          </button>
        </span>
      ))}

      <Menu
        label="Add a tag"
        align="start"
        items={items}
        trigger={
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-2 px-2 py-0.5 text-[11px] text-ink-3 hover:border-line hover:text-ink-2">
            {busy ? (
              <Spinner className="size-3" />
            ) : (
              <PlusIcon className="size-3" />
            )}
            Tag
          </span>
        }
      />
    </div>
  );
}

/* Creating, renaming and deleting the labels themselves.
 *
 * The count beside each one is the whole reason this is not a bare list: "delete
 * VIP" is a different decision at 2 contacts and at 900, and the number is what
 * tells a host which one they are making.
 *
 * Renaming is offered and merging is not. Two labels becoming one is a real
 * operation with consequences for every audience that names either, and the
 * server refuses a rename onto an existing name for that reason rather than
 * quietly combining them.
 */
export function TagManager({
  tags,
  onChanged,
}: {
  tags: CRMTag[] | null;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<CRMTag | null>(null);
  const [error, setError] = useState<string | null>(null);

  const full = (tags?.length ?? 0) >= TagMaxPerHost;

  async function create() {
    const wanted = name.trim();
    if (!wanted) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCrmTag(wanted);
      setName("");
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not add that tag.");
    } finally {
      setBusy(false);
    }
  }

  async function rename(tag: CRMTag) {
    const wanted = draft.trim();
    if (!wanted || wanted === tag.name) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.renameCrmTag(tag.id, wanted);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not rename that tag.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(tag: CRMTag) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCrmTag(tag.id);
      setConfirmDelete(null);
      onChanged();
      // Said out loud because the row simply vanishes otherwise, and the count is
      // the part worth confirming: it is how many people were relabelled by it.
      notify(
        tag.contacts === 0
          ? `Deleted “${tag.name}”.`
          : `Deleted “${tag.name}”, and took it off ${tag.contacts === 1 ? "1 contact" : `${tag.contacts} contacts`}.`,
        "ok",
      );
    } catch (e) {
      /* The server's own sentence. The refusal that matters names the sequence
       * that triggers on this tag, and "could not delete" would leave a host
       * hunting through the Sequences tab for which one it meant. */
      setError(e instanceof ApiError ? e.message : "Could not delete that tag.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 py-1">
      <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
        Your own labels for people — &ldquo;paid&rdquo;, &ldquo;wants a
        call&rdquo;, &ldquo;enterprise&rdquo;. Put one on a contact from their
        conversation, then send a broadcast to everybody who has it or start a
        sequence the moment it goes on somebody. Nobody but you ever sees them.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !full) void create();
        }}
      >
        <input
          className="field max-w-48"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={TagMaxLength}
          placeholder="New tag"
          aria-label="New tag name"
          disabled={full}
        />
        <Button type="submit" size="sm" disabled={busy || full || !name.trim()}>
          {busy && <Spinner className="size-3.5" />}
          Add tag
        </Button>
        {full && (
          <span className="text-[11.5px] text-ink-3">
            {TagMaxPerHost} tags is the limit — delete one to add another.
          </span>
        )}
      </form>

      {tags === null ? (
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <Spinner className="size-4 text-ink-3" />
          Loading your tags…
        </div>
      ) : tags.length === 0 ? (
        <p className="text-[12px] text-ink-3">No tags yet.</p>
      ) : (
        <ul className="grid gap-1 border-t border-line pt-2">
          {tags.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 py-0.5 text-[12.5px]"
            >
              {editing === t.id ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy) void rename(t);
                  }}
                >
                  <input
                    className="field max-w-48"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={TagMaxLength}
                    aria-label={`Rename ${t.name}`}
                    autoFocus
                  />
                  <Button type="submit" size="sm" disabled={busy}>
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="font-medium">{t.name}</span>
                  <span className="text-[11.5px] text-ink-3">
                    {t.contacts === 1 ? "1 contact" : `${t.contacts} contacts`}
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(t.id);
                      setDraft(t.name);
                    }}
                    className="rounded-lg px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(t)}
                    className="rounded-lg px-2 py-1 text-[11.5px] font-medium text-live hover:bg-live-soft"
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        open={confirmDelete !== null}
        busy={busy}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title={`Delete "${confirmDelete?.name ?? "this tag"}"?`}
        body={
          confirmDelete && confirmDelete.contacts > 0
            ? `This takes the tag off ${confirmDelete.contacts === 1 ? "1 contact" : `${confirmDelete.contacts} contacts`}. Broadcasts you already sent to it keep their record of who they went to. A sequence that starts on this tag has to be changed first.`
            : "Nobody has this tag, so nothing else changes. A sequence that starts on it has to be changed first."
        }
        confirmLabel="Delete tag"
      />
    </div>
  );
}
