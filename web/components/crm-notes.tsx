"use client";

import { useState } from "react";
import { Alert, ConfirmModal, Spinner } from "./controls";
import { useToast } from "./providers";
import { Button } from "./ui";
import { ApiError, api } from "@/lib/api";
import { NoteMaxLength } from "@/lib/api-types";
import type { CRMNote } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/* Notes: the one thing on this screen that is never sent to anybody.
 *
 * Beside the conversation on purpose, because the box it sits next to is where a
 * host would otherwise have typed "wants a call after 5" — and that sentence is
 * for them, not for the contact. Everything else in the CRM asks about consent,
 * a service window, a template and a price; a note asks about none of them,
 * which is exactly why it earns a pane of its own.
 *
 * There is no edit. A note is a dated observation, and rewriting one changes
 * what the host knew in February — correcting one means deleting it and writing
 * another, which leaves both facts where they belong in time.
 */
export function NotesPane({
  contactId,
  notes,
  onChanged,
}: {
  contactId: string;
  /** From the thread, which already carries them — so opening a conversation
   *  does not cost a second request for a list that arrived with the first. */
  notes: CRMNote[];
  /** The new list, so the pane re-renders from the server's answer. */
  onChanged: (notes: CRMNote[]) => void;
}) {
  const { notify } = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CRMNote | null>(null);

  async function add() {
    const wanted = body.trim();
    if (!wanted) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCrmNote(contactId, wanted);
      setBody("");
      // Re-read rather than prepend the one that came back: the list is the
      // server's order, and a second browser tab may have added one too.
      onChanged((await api.crmNotes(contactId)).notes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that note.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(note: CRMNote) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCrmNote(note.id);
      setConfirmDelete(null);
      onChanged((await api.crmNotes(contactId)).notes);
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not delete that note.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2.5 border-t border-line px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[12.5px] font-medium">Notes</p>
        <p className="text-[11px] text-ink-3">
          Only you can see these. Nothing here is ever sent.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void add();
        }}
      >
        <textarea
          className="field min-h-20 resize-y py-2"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={NoteMaxLength}
          placeholder="Asked us to call after 5pm…"
          aria-label="New note"
        />
        <div className="flex items-center justify-end gap-2">
          <Button type="submit" size="sm" disabled={busy || !body.trim()}>
            {busy && <Spinner className="size-3.5" />}
            Save note
          </Button>
        </div>
      </form>

      {notes.length === 0 ? (
        <p className="text-[12px] text-ink-3">
          Nothing written about this contact yet.
        </p>
      ) : (
        <ul className="grid gap-2">
          {notes.map((n) => (
            <li
              key={n.id}
              className="rounded-xl border border-line bg-surface-2 px-3 py-2"
            >
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
                {n.body}
              </p>
              <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-3">
                <span>{formatRelative(n.createdAt, new Date())}</span>
                {n.author && <span>· {n.author}</span>}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setConfirmDelete(n)}
                  className="rounded px-1.5 py-0.5 font-medium text-live hover:bg-live-soft"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        open={confirmDelete !== null}
        busy={busy}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title="Delete this note?"
        body="There is no undo, and no edit — if you are correcting it, write the new one first so you still have the wording."
        confirmLabel="Delete note"
      />
    </div>
  );
}
