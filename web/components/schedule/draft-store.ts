import type { MessageSlot } from "@/lib/api-types";
import type { FormState } from "./form-state";

/* The schedule form's draft, kept in this browser until it is saved.
 *
 * Every field on the form used to live only in React state. Anything that
 * reloaded the document — a deploy landing between page load and the next
 * router request, a middleware redirect, a crashed tab, the host pressing
 * Back — took the whole form with it. This is the copy that survives that.
 *
 * localStorage rather than sessionStorage so closing the tab by accident is
 * covered too; the expiry and the per-account, per-webinar key keep an old
 * draft from turning up somewhere it does not belong. The stream key is left
 * out: it is a secret, and a browser's storage is not the place for it.
 *
 * For an existing webinar the draft carries a fingerprint of the webinar it
 * was edited from. If the server copy has changed since (edited in another
 * tab, by a teammate), the draft is dropped rather than written over newer
 * data. */

const PREFIX = "webinarliv.schedule-draft.v1";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type StoredForm = Omit<FormState, "streamKey">;

/** What travels with the form: the parts other editors on the page own. */
export type DraftExtras = {
  /** Per-webinar message overrides made before the webinar existed. */
  messages?: MessageSlot[];
};

type Stored = {
  savedAt: number;
  base: string | null;
  form: StoredForm;
  extras?: DraftExtras;
};

export function draftKey(accountId: string | undefined, slug: string | undefined) {
  return `${PREFIX}:${accountId || "anon"}:${slug || "new"}`;
}

export function stripSecrets(form: FormState): StoredForm {
  const { streamKey: _secret, ...rest } = form;
  void _secret;
  return rest;
}

export function fingerprint(form: FormState): string {
  return JSON.stringify(stripSecrets(form));
}

export function readDraft(
  key: string,
  base: string | null,
): { form: StoredForm; savedAt: number; extras: DraftExtras } | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    if (
      !stored ||
      typeof stored.savedAt !== "number" ||
      !stored.form ||
      Date.now() - stored.savedAt > MAX_AGE_MS ||
      stored.base !== base
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return {
      form: stored.form,
      savedAt: stored.savedAt,
      extras: stored.extras ?? {},
    };
  } catch {
    return null;
  }
}

/** Resolves to false when storage is full or blocked (private mode). */
export function writeDraft(
  key: string,
  base: string | null,
  form: FormState,
  extras: DraftExtras,
): number | null {
  try {
    const stored: Stored = {
      savedAt: Date.now(),
      base,
      form: stripSecrets(form),
      extras,
    };
    window.localStorage.setItem(key, JSON.stringify(stored));
    return stored.savedAt;
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Blocked storage: nothing was written, so there is nothing to clear.
  }
}

/** Fills anything a draft written by an older build did not have. */
export function mergeDraft(initial: FormState, stored: StoredForm): FormState {
  return {
    ...initial,
    ...stored,
    options: { ...initial.options, ...stored.options },
    controls: { ...initial.controls, ...stored.controls },
    streamKey: initial.streamKey,
  };
}

export function savedAgo(savedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
