/* The whiteboard's wire format and trust rules.
 *
 * Run with `make test-web`.
 */

import assert from "node:assert/strict";
import {
  decodePointer,
  decodeWb,
  mayDraw,
  mergeInto,
  newBoardId,
  newer,
  noteKnown,
  reduceWb,
  unsent,
  WB_MAX_ELEMENTS,
  type WbElement,
} from "./whiteboard.ts";

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

const el = (id: string, version: number, versionNonce = 1, extra = {}): WbElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce,
  ...extra,
});

const BOARD = "abcdef123456";

test("decodes open, close and scene", () => {
  assert.deepEqual(decodeWb(JSON.stringify({ k: "open", board: BOARD, name: "Neeraj" })), {
    k: "open",
    board: BOARD,
    name: "Neeraj",
  });
  assert.deepEqual(decodeWb(JSON.stringify({ k: "close", board: BOARD })), {
    k: "close",
    board: BOARD,
  });
  const scene = decodeWb(JSON.stringify({ k: "scene", board: BOARD, full: true, elements: [el("a", 2)] }));
  assert.equal(scene?.k, "scene");
  assert.equal(scene?.k === "scene" && scene.full, true);
  assert.equal(scene?.k === "scene" && scene.elements.length, 1);
});

test("drops anything that is not a whiteboard message", () => {
  assert.equal(decodeWb("not json"), null);
  assert.equal(decodeWb(JSON.stringify({ kind: "chat", text: "hi" })), null);
  assert.equal(decodeWb(JSON.stringify({ k: "open", board: "../../x" })), null);
  assert.equal(decodeWb(JSON.stringify({ k: "nope", board: BOARD })), null);
  assert.equal(decodeWb(JSON.stringify({ k: "scene", board: BOARD, elements: "x" })), null);
});

test("drops malformed elements but keeps the good ones", () => {
  const msg = decodeWb(
    JSON.stringify({
      k: "scene",
      board: BOARD,
      elements: [el("a", 1), { id: "b" }, { id: 3, type: "x", version: 1, versionNonce: 1 }, null],
    }),
  );
  assert.equal(msg?.k === "scene" && msg.elements.length, 1);
});

test("refuses a scene over the element cap", () => {
  const elements = Array.from({ length: WB_MAX_ELEMENTS + 1 }, (_, i) => el(`e${i}`, 1));
  assert.equal(decodeWb(JSON.stringify({ k: "scene", board: BOARD, elements })), null);
});

test("decodes a pointer and clamps its fields", () => {
  const p = decodePointer(JSON.stringify({ k: "ptr", board: BOARD, name: "P", x: 1, y: 2, tool: "lol" }));
  assert.deepEqual(p, { k: "ptr", board: BOARD, name: "P", x: 1, y: 2, tool: "pointer", button: "up" });
  assert.equal(decodePointer(JSON.stringify({ k: "ptr", board: BOARD, x: "1", y: 2 })), null);
});

test("only the host and scheduled panelists may draw", () => {
  assert.equal(mayDraw(JSON.stringify({ role: "host" })), true);
  assert.equal(mayDraw(JSON.stringify({ role: "panelist" })), true);
  assert.equal(mayDraw(JSON.stringify({ role: "panelist", promoted: true })), false);
  assert.equal(mayDraw(JSON.stringify({ role: "attendee" })), false);
  assert.equal(mayDraw(undefined), false);
  assert.equal(mayDraw("{"), false);
});

test("open starts a board, close for the same board ends it", () => {
  const open = reduceWb(null, { k: "open", board: BOARD, name: "" }, "user_1", "Neeraj");
  assert.deepEqual(open, { board: BOARD, owner: "user_1", ownerName: "Neeraj" });
  assert.equal(reduceWb(open, { k: "close", board: BOARD }, "user_1", "Neeraj"), null);
});

test("a close for another board does not end this one", () => {
  const open = reduceWb(null, { k: "open", board: BOARD, name: "N" }, "user_1", "N");
  assert.equal(reduceWb(open, { k: "close", board: "zzzzzz999999" }, "user_1", "N"), open);
});

test("a late joiner is opened by a full scene, not by a partial one", () => {
  const partial = { k: "scene" as const, board: BOARD, full: false, elements: [] };
  assert.equal(reduceWb(null, partial, "user_2", "Priya"), null);
  const full = { ...partial, full: true };
  assert.deepEqual(reduceWb(null, full, "user_1", "Neeraj"), {
    board: BOARD,
    owner: "user_1",
    ownerName: "Neeraj",
  });
});

test("newest version wins, ties go to the lower nonce", () => {
  assert.equal(newer(el("a", 2), el("a", 3)).version, 3);
  assert.equal(newer(el("a", 3, 9), el("a", 3, 4)).versionNonce, 4);
});

test("merge keeps the latest copy of each element", () => {
  const scene = new Map<string, WbElement>();
  assert.equal(mergeInto(scene, [el("a", 1), el("b", 1)]), true);
  assert.equal(mergeInto(scene, [el("a", 1)]), false);
  assert.equal(mergeInto(scene, [el("a", 3), el("b", 0)]), true);
  assert.equal(scene.get("a")?.version, 3);
  assert.equal(scene.get("b")?.version, 1);
});

test("unsent returns only changes, and received elements are never echoed", () => {
  const known = new Map<string, number>();
  assert.equal(unsent([el("a", 1)], known).length, 1);
  assert.equal(unsent([el("a", 1)], known).length, 0);
  noteKnown([el("r", 4)], known);
  assert.deepEqual(unsent([el("a", 2), el("r", 4)], known).map((e) => e.id), ["a"]);
});

test("board ids are valid on the wire", () => {
  const id = newBoardId();
  assert.notEqual(decodeWb(JSON.stringify({ k: "close", board: id })), null);
  assert.notEqual(newBoardId(), id);
});

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
