import assert from "node:assert/strict";
import { defaultListName, mappingProblem, setColumnField } from "./import-mapping.ts";

assert.equal(mappingProblem(["name", "email", "phone"]), null);
assert.match(mappingProblem(["name", "email", ""]) ?? "", /phone numbers/);
assert.match(mappingProblem(["phone", "phone"]) ?? "", /Two columns/);
assert.equal(mappingProblem(["", "phone", ""]), null);

// Moving "phone" to another column clears it from the first.
assert.deepEqual(setColumnField(["phone", "", "email"], 1, "phone"), ["", "phone", "email"]);
assert.deepEqual(setColumnField(["phone", "name"], 1, ""), ["phone", ""]);

assert.equal(defaultListName("tagmango export.csv", new Date(2026, 9, 17)), "tagmango export · 17 Oct 2026");
assert.equal(defaultListName(".csv", new Date(2026, 0, 2)), "Imported contacts · 2 Jan 2026");

console.log("PASS import-mapping");
