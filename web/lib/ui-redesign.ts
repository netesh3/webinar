"use client";

import { useSyncExternalStore } from "react";
import {
  UI_COOKIE,
  envUiRedesignDefault,
  parseUiMode,
  type UiMode,
} from "@/lib/ui-redesign-flag";

const subscribeNothing = () => () => {};

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function readUiRedesignClient(): boolean {
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const fromQuery = parseUiMode(params?.get("ui") ?? null);
  if (fromQuery) return fromQuery === "new";
  const fromCookie = parseUiMode(readCookie(UI_COOKIE));
  if (fromCookie) return fromCookie === "new";
  return envUiRedesignDefault();
}

/** Client hook — redesign on/off for this browser (cookie / query / env). */
export function useUiRedesign(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    readUiRedesignClient,
    envUiRedesignDefault,
  );
}

/** Persist mode and reload so middleware + shells pick it up. */
export function setUiMode(mode: UiMode): void {
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${UI_COOKIE}=${mode}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  const url = new URL(window.location.href);
  url.searchParams.delete("ui");
  window.location.assign(url.pathname + url.search + url.hash);
}
