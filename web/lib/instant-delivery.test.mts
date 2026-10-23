import assert from "node:assert/strict";
import { instantDeliveryFor, parseInstantDelivery } from "./instant-delivery.ts";

assert.equal(parseInstantDelivery("edge"), "edge");
assert.equal(parseInstantDelivery("standard"), "standard");
assert.equal(parseInstantDelivery(null), "standard");
assert.equal(parseInstantDelivery("EDGE"), "standard");
assert.equal(parseInstantDelivery("junk"), "standard");

assert.equal(instantDeliveryFor("edge", "choice"), "edge");
assert.equal(instantDeliveryFor("edge", "none"), "standard");
assert.equal(instantDeliveryFor("standard", "choice"), "standard");
// GCP / DO: edge whatever was last picked.
assert.equal(instantDeliveryFor("standard", "edge-only"), "edge");
assert.equal(instantDeliveryFor("edge", "edge-only"), "edge");

console.log("instant-delivery: ok");
