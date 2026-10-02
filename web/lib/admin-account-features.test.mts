/* Admin account row: CDN Broadcast and Instant webinar live in Features.
 *
 * Run: node --experimental-strip-types --no-warnings lib/admin-account-features.test.mts
 *
 * Order follows the server catalogue (Instant webinar before Zoom), then CDN
 * Broadcast, which is not a feature key. A non-host does not see the catalogue,
 * including Instant webinar. */

import assert from "node:assert/strict";
import type { Feature } from "./api-types.ts";
import {
  accountFeatureRows,
  accountFeaturesOnCount,
  CDN_BROADCAST_ROW_ID,
} from "./admin-account-features.ts";

const catalogue: Feature[] = [
  {
    key: "whatsapp_crm",
    label: "WhatsApp CRM",
    description: "Contact tools.",
  },
  {
    key: "cloud_recording",
    label: "Cloud recording",
    description: "Record to cloud storage.",
  },
  {
    key: "join_without_registration",
    label: "Join without registration",
    description: "Name only, no form.",
  },
  {
    key: "instant_webinar",
    label: "Instant webinar",
    description: "Go live without scheduling.",
  },
  {
    key: "zoom",
    label: "Zoom",
    description: "Run the session on Zoom.",
  },
];

const hostRows = accountFeatureRows(true, catalogue);
assert.deepEqual(
  hostRows.map((row) => row.label),
  [
    "WhatsApp CRM",
    "Cloud recording",
    "Join without registration",
    "Instant webinar",
    "Zoom",
    "CDN Broadcast",
  ],
);
assert.equal(hostRows.length, 6);
assert.deepEqual(
  hostRows.filter((row) => row.source === "feature").map((row) => row.id),
  catalogue.map((f) => f.key),
);
const cdn = hostRows[hostRows.length - 1];
assert.equal(cdn.source, "cdn_broadcast");
assert.equal(cdn.id, CDN_BROADCAST_ROW_ID);
assert.equal(cdn.label, "CDN Broadcast");
assert.ok(cdn.description.length > 0);
assert.ok(
  !hostRows.some((row) => row.source === "feature" && row.id === CDN_BROADCAST_ROW_ID),
);

assert.equal(
  accountFeaturesOnCount(hostRows, ["whatsapp_crm"], false),
  1,
);
assert.equal(
  accountFeaturesOnCount(
    hostRows,
    ["whatsapp_crm", "instant_webinar"],
    true,
  ),
  3,
);
assert.equal(
  accountFeaturesOnCount(hostRows, ["not_a_real_feature"], true),
  1,
);

const guestRows = accountFeatureRows(false, catalogue);
assert.deepEqual(
  guestRows.map((row) => row.label),
  ["CDN Broadcast"],
);
assert.equal(guestRows.length, 1);
assert.equal(
  accountFeaturesOnCount(guestRows, ["instant_webinar", "zoom"], false),
  0,
);
assert.equal(
  accountFeaturesOnCount(guestRows, ["instant_webinar"], true),
  1,
);
