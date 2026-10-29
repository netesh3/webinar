import type { AudienceLocations, CityCount, LocationCount } from "./api-types";
import type { DeviceRow } from "./audience-devices";

/* The audience-by-location breakdown as the cards show it (components/audience-locations.tsx):
 * the top countries with a flag and a name, India by state, and the top cities, each with a
 * count and a share,
 * the long tail folded into "Other". The same rows as the device card's bars. Pure, so the
 * grouping and the wording are tested (audience-locations.test.mts). (29 Oct 2026) */

/** How many countries, and how many Indian states, the cards list before "Other". */
export const TOP_COUNTRIES = 8;
export const TOP_STATES = 10;

/** The flag emoji for an ISO 3166-1 alpha-2 code ("IN" → 🇮🇳); "" for anything else. */
export function flagEmoji(code: string): string {
  const c = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let names: Intl.DisplayNames | null | undefined;

/** The English name of a country code ("IN" → "India"), or the code when there is none. */
export function countryName(code: string): string {
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      names = null;
    }
  }
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

const pctOf = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

/** The largest `top` buckets as rows, the rest summed into one "Other" row, shares of `of`. */
export function topRows(
  counts: LocationCount[],
  of: number,
  top: number,
  label: (key: string) => string = (k) => k,
): DeviceRow[] {
  const rows: DeviceRow[] = counts.slice(0, top).map((c) => ({
    key: c.key,
    label: label(c.key),
    count: c.count,
    pct: pctOf(c.count, of),
  }));
  const rest = counts.slice(top).reduce((n, c) => n + c.count, 0);
  if (rest > 0) rows.push({ key: "~other", label: "Other", count: rest, pct: pctOf(rest, of) });
  return rows;
}

/** The countries, flag and name, shared out of the people whose country is known. */
export function countryRows(d: AudienceLocations, top = TOP_COUNTRIES): DeviceRow[] {
  return topRows(d.countries, d.recorded, top, (k) => `${flagEmoji(k)} ${countryName(k)}`.trim());
}

/** The people from India, by state, then "Unknown" for those whose state was not given. */
export function indiaStateRows(d: AudienceLocations, top = TOP_STATES): DeviceRow[] {
  const india = d.countries.find((c) => c.key === "IN")?.count ?? 0;
  const rows = topRows(d.indiaRegions, india, top);
  if (d.indiaUnknown > 0) {
    rows.push({ key: "~unknown", label: "Unknown", count: d.indiaUnknown, pct: pctOf(d.indiaUnknown, india) });
  }
  return rows;
}

/** A city as the card names it: "Bengaluru, Karnataka" in India, where the state says more than
 * the country, and "Lyon, France" elsewhere; "Bengaluru, India" when India gave no state. */
export function cityLabel(c: CityCount): string {
  const where = c.country === "IN" && c.region ? c.region : countryName(c.country);
  return `${c.city}, ${where}`;
}

/** The top cities (the API sends ten), then "Other" for the cities past them and "Unknown" for
 * the people with a country but no city, all shared out of the people whose country is known.
 * The key is country, region and city, so two places of one name are two rows. (29 Oct 2026) */
export function cityRows(d: AudienceLocations): DeviceRow[] {
  const rows: DeviceRow[] = d.cities.map((c) => ({
    key: `${c.country}|${c.region}|${c.city}`,
    label: cityLabel(c),
    count: c.count,
    pct: pctOf(c.count, d.recorded),
  }));
  if (d.citiesOther > 0) {
    rows.push({ key: "~other", label: "Other", count: d.citiesOther, pct: pctOf(d.citiesOther, d.recorded) });
  }
  if (d.citiesUnknown > 0) {
    rows.push({ key: "~unknown", label: "Unknown", count: d.citiesUnknown, pct: pctOf(d.citiesUnknown, d.recorded) });
  }
  return rows;
}

/** The line under the heading: how many people the numbers cover, and why some may be missing. */
export function locationsNote(d: AudienceLocations): string {
  if (d.attendees === 0) return "Nobody has joined yet.";
  if (d.recorded === 0) return "Location is recorded from 29 Oct 2026.";
  const people = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? "person" : "people"}`;
  if (d.recorded === d.attendees) return `${people(d.recorded)}, counted once each where they first joined from.`;
  const missing = d.attendees - d.recorded;
  return `${people(d.recorded)} of ${d.attendees.toLocaleString("en-IN")} — ${missing.toLocaleString("en-IN")} unknown: joined before location was recorded (29 Oct 2026), from a network that could not be placed, or only through the video server.`;
}
