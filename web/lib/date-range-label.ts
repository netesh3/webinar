/** Shown once a date bound is set but there is no complete range to print. */
export const DATE_FILTER_ACTIVE = "Filtered";

/** Button text for a from/to filter.
 *
 * Idle keeps the caller's label ("Filter" on the host list). Both ends show
 * the formatted range. One end must not keep the idle name — the list is
 * already narrowed — so the button says Filtered until the range is cleared.
 */
export function dateRangeButtonLabel(
  from: string,
  to: string,
  idle: string,
  formatRange: (from: string, to: string) => string,
): string {
  const start = from.trim();
  const end = to.trim();
  if (!start && !end) return idle;
  if (start && end) {
    const text = formatRange(start, end).trim();
    return text || DATE_FILTER_ACTIVE;
  }
  return DATE_FILTER_ACTIVE;
}
