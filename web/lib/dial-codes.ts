/* Country calling codes, for the registration form's phone field.
 *
 * Keyed by ISO 3166-1 alpha-2 and holding ONLY the dial code. The country's name is not stored:
 * `Intl.DisplayNames` already knows it, in the viewer's own language, and a hardcoded English
 * list would be both larger and worse — "Germany" for somebody whose browser is in German.
 *
 * The list is deliberately complete rather than a top-twenty. A picker that covers the popular
 * markets turns away everybody else, and "cannot register for the webinar" is a much worse
 * outcome than a longer select. It is ~1.5 KB of source.
 *
 * Codes shared by several countries (+1 for the US, Canada and much of the Caribbean; +7 for
 * Russia and Kazakhstan) appear against each country. The picker's job is to help somebody
 * produce the right number, not to be a reversible mapping.
 */
export const DIAL_CODES: Record<string, string> = {
  AF: "93", AL: "355", DZ: "213", AS: "1", AD: "376", AO: "244", AI: "1", AG: "1",
  AR: "54", AM: "374", AW: "297", AU: "61", AT: "43", AZ: "994", BS: "1", BH: "973",
  BD: "880", BB: "1", BY: "375", BE: "32", BZ: "501", BJ: "229", BM: "1", BT: "975",
  BO: "591", BA: "387", BW: "267", BR: "55", BN: "673", BG: "359", BF: "226", BI: "257",
  KH: "855", CM: "237", CA: "1", CV: "238", KY: "1", CF: "236", TD: "235", CL: "56",
  CN: "86", CO: "57", KM: "269", CG: "242", CD: "243", CR: "506", CI: "225", HR: "385",
  CU: "53", CW: "599", CY: "357", CZ: "420", DK: "45", DJ: "253", DM: "1", DO: "1",
  EC: "593", EG: "20", SV: "503", GQ: "240", ER: "291", EE: "372", ET: "251", FJ: "679",
  FI: "358", FR: "33", GA: "241", GM: "220", GE: "995", DE: "49", GH: "233", GI: "350",
  GR: "30", GL: "299", GD: "1", GU: "1", GT: "502", GN: "224", GW: "245", GY: "592",
  HT: "509", HN: "504", HK: "852", HU: "36", IS: "354", IN: "91", ID: "62", IR: "98",
  IQ: "964", IE: "353", IL: "972", IT: "39", JM: "1", JP: "81", JO: "962", KZ: "7",
  KE: "254", KI: "686", KW: "965", KG: "996", LA: "856", LV: "371", LB: "961", LS: "266",
  LR: "231", LY: "218", LI: "423", LT: "370", LU: "352", MO: "853", MK: "389", MG: "261",
  MW: "265", MY: "60", MV: "960", ML: "223", MT: "356", MH: "692", MR: "222", MU: "230",
  MX: "52", FM: "691", MD: "373", MC: "377", MN: "976", ME: "382", MS: "1", MA: "212",
  MZ: "258", MM: "95", NA: "264", NR: "674", NP: "977", NL: "31", NZ: "64", NI: "505",
  NE: "227", NG: "234", NO: "47", OM: "968", PK: "92", PW: "680", PS: "970", PA: "507",
  PG: "675", PY: "595", PE: "51", PH: "63", PL: "48", PT: "351", PR: "1", QA: "974",
  RO: "40", RU: "7", RW: "250", KN: "1", LC: "1", VC: "1", WS: "685", SM: "378",
  SA: "966", SN: "221", RS: "381", SC: "248", SL: "232", SG: "65", SK: "421", SI: "386",
  SB: "677", SO: "252", ZA: "27", KR: "82", SS: "211", ES: "34", LK: "94", SD: "249",
  SR: "597", SE: "46", CH: "41", SY: "963", TW: "886", TJ: "992", TZ: "255", TH: "66",
  TL: "670", TG: "228", TO: "676", TT: "1", TN: "216", TR: "90", TM: "993", TC: "1",
  TV: "688", UG: "256", UA: "380", AE: "971", GB: "44", US: "1", UY: "598", UZ: "998",
  VU: "678", VA: "39", VE: "58", VN: "84", VG: "1", VI: "1", YE: "967", ZM: "260",
  ZW: "263",
};

export type DialOption = { iso: string; code: string; label: string };

/**
 * Every option, sorted by the country name as the viewer's browser writes it.
 *
 * Built once and memoised by the caller. `Intl.DisplayNames` is not free and this runs over
 * roughly two hundred entries; doing it per keystroke in a form would be visible.
 */
export function dialOptions(): DialOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    // Very old browsers. Falls back to the ISO code as the label, which is still usable.
    names = null;
  }

  return Object.entries(DIAL_CODES)
    .map(([iso, code]) => ({
      iso,
      code,
      label: `${names?.of(iso) ?? iso} +${code}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
