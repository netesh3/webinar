/* Resolved message slots for one webinar, shared by every caller of
 * useWebinarMessageSlots. Session-scoped: a save replaces the slot, and the
 * next read of a dropped slug asks the server again. */

import type { MessageSlot } from "@/lib/api-types";

type Listener = () => void;

const slots = new Map<string, MessageSlot[]>();
const versions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

function bump(slug: string): void {
  versions.set(slug, (versions.get(slug) ?? 0) + 1);
  listeners.get(slug)?.forEach((cb) => cb());
}

export function slotVersion(slug: string): number {
  return versions.get(slug) ?? 0;
}

export function readSlots(slug: string): MessageSlot[] | undefined {
  return slots.get(slug);
}

export function writeSlots(slug: string, next: MessageSlot[]): void {
  slots.set(slug, next);
  bump(slug);
}

export function dropSlots(slug: string): void {
  slots.delete(slug);
  bump(slug);
}

/** Account-wide defaults changed, so every webinar's resolved slots are stale. */
export function dropAllSlots(): void {
  const slugs = new Set<string>([...slots.keys(), ...listeners.keys()]);
  slots.clear();
  slugs.forEach((slug) => bump(slug));
}

export function subscribeSlots(slug: string, cb: Listener): () => void {
  let set = listeners.get(slug);
  if (!set) {
    set = new Set();
    listeners.set(slug, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(slug);
  };
}
