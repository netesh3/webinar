/* The areas of the video server pool a session can run in (AppConfig.boxRegions; the API's
 * sfu_pool.go). The choice is only offered when there are two or more: with one there is
 * nothing to pick, and a session with no region goes to the default (the first). */

const LABELS: Record<string, string> = {
  in: "India (Bangalore)",
  us: "United States",
  eu: "Europe",
  sg: "Singapore",
};

/** What a region is called in the form; an unknown one is its code in capitals. */
export function regionLabel(id: string): string {
  return LABELS[id] ?? id.toUpperCase();
}

/** Whether the form should offer a region at all. */
export function offersRegions(regions: readonly string[] | undefined): boolean {
  return (regions?.length ?? 0) > 1;
}

/** The region shown as chosen: the session's own, else the default (the first listed). */
export function shownRegion(chosen: string, regions: readonly string[]): string {
  return chosen && regions.includes(chosen) ? chosen : (regions[0] ?? "");
}
