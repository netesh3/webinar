import assert from "node:assert/strict";
import { deliveryOffer, deliveryToSend, edgeFits } from "./delivery-policy.ts";

const edgeOnly = { edgeOnly: true, edgeChoice: false };
const choice = { edgeOnly: false, edgeChoice: true };
const standard = { edgeOnly: false, edgeChoice: false };

const live = { kind: "live", venue: "app" };
const series = { kind: "recurring", venue: "app" };
const zoom = { kind: "live", venue: "zoom_meeting" };
const simulive = { kind: "simulive", venue: "app" };
const meeting = { kind: "meeting", venue: "app" };

assert.equal(edgeFits(live), true);
assert.equal(edgeFits(series), true);
assert.equal(edgeFits(zoom), false);
assert.equal(edgeFits(simulive), false);
assert.equal(edgeFits(meeting), false);

// GCP / DO, a host an admin put on edge: no choice, a webinar or series is edge whatever the
// form holds.
assert.equal(deliveryOffer(edgeOnly, live), "edge-only");
assert.equal(deliveryOffer(edgeOnly, series), "edge-only");
assert.equal(deliveryToSend(edgeOnly, live, "standard"), "edge");
assert.equal(deliveryToSend(edgeOnly, series, "standard"), "edge");
// ...and standard for what cannot be edge.
assert.equal(deliveryOffer(edgeOnly, zoom), "none");
assert.equal(deliveryToSend(edgeOnly, zoom, "edge"), "standard");
assert.equal(deliveryToSend(edgeOnly, simulive, "edge"), "standard");
assert.equal(deliveryToSend(edgeOnly, meeting, "edge"), "standard");

// GCP / DO by default (standard, WebRTC; 29 Oct 2026): nothing shown, the field omitted, and
// the server applies the admin's rule. The same answer as a server with no live origin.
assert.equal(deliveryOffer(standard, series), "none");
assert.equal(deliveryToSend(standard, series, "edge"), undefined);

// Another server with a live origin: the choice, for a series too.
assert.equal(deliveryOffer(choice, live), "choice");
assert.equal(deliveryOffer(choice, series), "choice");
assert.equal(deliveryToSend(choice, live, "edge"), "edge");
assert.equal(deliveryToSend(choice, live, "standard"), "standard");
assert.equal(deliveryToSend(choice, zoom, "edge"), "standard");

// No live origin, or not known yet: nothing shown, the field omitted.
assert.equal(deliveryOffer(standard, live), "none");
assert.equal(deliveryToSend(standard, live, "edge"), undefined);
assert.equal(deliveryOffer(null, live), "none");
assert.equal(deliveryToSend(null, live, "edge"), undefined);

console.log("delivery-policy: ok");
