"use client";

import { useSyncExternalStore } from "react";
import {
  HOST_WELCOME_EVENT,
  dismissHostWelcome,
  hostWelcomePending,
} from "@/lib/host-welcome";

function subscribe(onChange: () => void) {
  window.addEventListener(HOST_WELCOME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(HOST_WELCOME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** True once this browser has seen the account as an attendee and hosting
 *  has since been turned on, until the banner is dismissed. */
export function useHostWelcome(): boolean {
  return useSyncExternalStore(subscribe, hostWelcomePending, () => false);
}

export function dismissWelcome() {
  dismissHostWelcome();
  window.dispatchEvent(new Event(HOST_WELCOME_EVENT));
}
