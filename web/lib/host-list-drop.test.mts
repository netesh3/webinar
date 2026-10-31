/* Cross-window drop of the host list: other tabs hear it through localStorage,
 * and the extra room window tells its opener with postMessage.
 *
 * Run: node --experimental-strip-types --no-warnings lib/host-list-drop.test.mts
 */

import {
  HOST_LIST_DROP_KEY,
  HOST_LIST_DROP_MESSAGE,
  isHostListDropMessage,
  isHostListDropNotice,
  publishHostListDrop,
} from "./host-list-drop.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
  }
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const notices = memoryStorage();
publishHostListDrop(notices);
ok(
  "a drop write is the key other tabs listen for",
  isHostListDropNotice({
    key: HOST_LIST_DROP_KEY,
    newValue: notices.getItem(HOST_LIST_DROP_KEY),
  }),
);
ok(
  "some other key is not a drop",
  !isHostListDropNotice({ key: "webinar.theme", newValue: "dark" }),
);
ok(
  "clearing the key is not a drop",
  !isHostListDropNotice({ key: HOST_LIST_DROP_KEY, newValue: null }),
);

ok(
  "the extra room window's postMessage is recognised",
  isHostListDropMessage({ type: HOST_LIST_DROP_MESSAGE }),
);
ok("a different message is ignored", !isHostListDropMessage({ type: "other" }));
ok("a string is ignored", !isHostListDropMessage("webcast.host-lists.drop"));
ok("null is ignored", !isHostListDropMessage(null));

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}  ${passed}/${passed + failed} checks passed`,
);
process.exit(failed === 0 ? 0 : 1);
