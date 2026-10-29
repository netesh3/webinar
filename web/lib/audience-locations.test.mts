import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cityLabel,
  cityRows,
  countryName,
  countryRows,
  flagEmoji,
  indiaStateRows,
  locationsNote,
  topRows,
} from "./audience-locations.ts";

const base = { countries: [], indiaRegions: [], indiaUnknown: 0, unknown: 0, cities: [], citiesOther: 0, citiesUnknown: 0 };

test("a flag is the code's two regional indicators, and nothing for a bad code", () => {
  assert.equal(flagEmoji("IN"), "🇮🇳");
  assert.equal(flagEmoji("us"), "🇺🇸");
  assert.equal(flagEmoji("T1"), "");
  assert.equal(flagEmoji(""), "");
  assert.equal(flagEmoji("IND"), "");
});

test("a country is named in English, or left as its code", () => {
  assert.equal(countryName("IN"), "India");
  assert.equal(countryName("GB"), "United Kingdom");
  assert.equal(countryName("!!"), "!!");
});

test("past the top few, the rest fold into Other", () => {
  const counts = [
    { key: "a", count: 5 },
    { key: "b", count: 3 },
    { key: "c", count: 1 },
    { key: "d", count: 1 },
  ];
  assert.deepEqual(topRows(counts, 10, 2), [
    { key: "a", label: "a", count: 5, pct: 50 },
    { key: "b", label: "b", count: 3, pct: 30 },
    { key: "~other", label: "Other", count: 2, pct: 20 },
  ]);
  assert.equal(topRows(counts, 10, 4).length, 4);
  assert.equal(topRows(counts, 0, 1)[0].pct, 0);
});

test("countries carry their flag and name; India's states end with Unknown", () => {
  const d = {
    ...base,
    attendees: 10,
    recorded: 8,
    unknown: 2,
    countries: [
      { key: "IN", count: 6 },
      { key: "US", count: 2 },
    ],
    indiaRegions: [
      { key: "Karnataka", count: 4 },
      { key: "Kerala", count: 1 },
    ],
    indiaUnknown: 1,
  };
  assert.deepEqual(countryRows(d)[0], { key: "IN", label: "🇮🇳 India", count: 6, pct: 75 });
  assert.deepEqual(indiaStateRows(d), [
    { key: "Karnataka", label: "Karnataka", count: 4, pct: 67 },
    { key: "Kerala", label: "Kerala", count: 1, pct: 17 },
    { key: "~unknown", label: "Unknown", count: 1, pct: 17 },
  ]);
  assert.deepEqual(indiaStateRows(d, 1).map((r) => r.label), ["Karnataka", "Other", "Unknown"]);
});

test("a city is named with its state in India and its country elsewhere", () => {
  assert.equal(cityLabel({ country: "IN", region: "Karnataka", city: "Bengaluru", count: 1 }), "Bengaluru, Karnataka");
  assert.equal(cityLabel({ country: "IN", region: "", city: "Bengaluru", count: 1 }), "Bengaluru, India");
  assert.equal(cityLabel({ country: "FR", region: "Auvergne-Rhone-Alpes", city: "Lyon", count: 1 }), "Lyon, France");
});

test("the top cities keep two of one name apart, then Other and Unknown", () => {
  const d = {
    ...base,
    attendees: 12,
    recorded: 10,
    unknown: 2,
    cities: [
      { country: "IN", region: "Karnataka", city: "Bengaluru", count: 5 },
      { country: "US", region: "Texas", city: "Paris", count: 2 },
      { country: "FR", region: "Île-de-France", city: "Paris", count: 1 },
    ],
    citiesOther: 1,
    citiesUnknown: 1,
  };
  assert.deepEqual(cityRows(d), [
    { key: "IN|Karnataka|Bengaluru", label: "Bengaluru, Karnataka", count: 5, pct: 50 },
    { key: "US|Texas|Paris", label: "Paris, United States", count: 2, pct: 20 },
    { key: "FR|Île-de-France|Paris", label: "Paris, France", count: 1, pct: 10 },
    { key: "~other", label: "Other", count: 1, pct: 10 },
    { key: "~unknown", label: "Unknown", count: 1, pct: 10 },
  ]);
  assert.deepEqual(cityRows({ ...base, attendees: 1, recorded: 1, citiesUnknown: 1 }), [
    { key: "~unknown", label: "Unknown", count: 1, pct: 100 },
  ]);
});

test("the note says how many people the numbers cover", () => {
  assert.equal(locationsNote({ ...base, attendees: 0, recorded: 0 }), "Nobody has joined yet.");
  assert.equal(locationsNote({ ...base, attendees: 4, recorded: 0 }), "Location is recorded from 29 Oct 2026.");
  assert.equal(
    locationsNote({ ...base, attendees: 1, recorded: 1 }),
    "1 person, counted once each where they first joined from.",
  );
  assert.match(locationsNote({ ...base, attendees: 5, recorded: 3 }), /^3 people of 5 — 2 unknown/);
});
