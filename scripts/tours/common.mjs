/* Shared helpers for the tour scripts. */

export const UPCOMING = "/host/mindful-money-budgeting";
export const ENDED = "/host/morning-routines-that-stick";

export const btn = (page, name) => page.getByRole("button", { name });
export const link = (page, name) => page.getByRole("link", { name });
export const tab = (page, name) => page.getByRole("tab", { name });
export const dialog = (page) => page.getByRole("dialog");

/** A `data-tour` hook. Used where the visible label includes a count, or the control has no stable name. */
export const anchor = (page, id) => page.locator(`[data-tour="${id}"]`);
