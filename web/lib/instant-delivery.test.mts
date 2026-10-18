import assert from "node:assert/strict";
import { instantDeliveryFor, parseInstantDelivery } from "./instant-delivery.ts";

assert.equal(parseInstantDelivery("edge"), "edge");
assert.equal(parseInstantDelivery("standard"), "standard");
assert.equal(parseInstantDelivery(null), "standard");
assert.equal(parseInstantDelivery("EDGE"), "standard");
assert.equal(parseInstantDelivery("junk"), "standard");

assert.equal(instantDeliveryFor("edge", true), "edge");
assert.equal(instantDeliveryFor("edge", false), "standard");
assert.equal(instantDeliveryFor("standard", true), "standard");

console.log("instant-delivery: ok");
