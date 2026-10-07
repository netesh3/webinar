/* The sign-in page must not follow the same next-target forever.
 *
 * One background tab did that — /host, /host/login, /login, /host — tens of
 * thousands of times, because a client navigation never trips the browser's
 * redirect limit. These checks are the cap on that, and the signal another
 * tab uses to drop a session it can no longer trust.
 *
 * Run: node --experimental-strip-types --no-warnings lib/login-redirect.test.mts
 */
import {
  LOGIN_REDIRECT_LIMIT,
  LOGIN_REDIRECT_WINDOW_MS,
  isSignOutNotice,
  loginRedirectBlocked,
  noteLoginRedirect,
  publishSignOut,
  SIGN_OUT_STORAGE_KEY,
} from "./login-redirect.ts";

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

const target = "/host";
const t0 = 1_700_000_000_000;

const fresh = memoryStorage();
ok("a first hop is allowed", !loginRedirectBlocked(target, t0, fresh));
noteLoginRedirect(target, t0, fresh);
ok("one hop is still allowed", !loginRedirectBlocked(target, t0 + 10, fresh));
noteLoginRedirect(target, t0 + 10, fresh);
ok(
  "the third hop in the window stops",
  loginRedirectBlocked(target, t0 + 20, fresh),
  `limit is ${LOGIN_REDIRECT_LIMIT}`,
);

const later = memoryStorage();
noteLoginRedirect(target, t0, later);
noteLoginRedirect(target, t0 + 10, later);
ok(
  "an old pair does not block a later visit",
  !loginRedirectBlocked(target, t0 + 10 + LOGIN_REDIRECT_WINDOW_MS + 1, later),
);

const other = memoryStorage();
noteLoginRedirect(target, t0, other);
noteLoginRedirect(target, t0 + 10, other);
ok(
  "a different target keeps its own count",
  !loginRedirectBlocked("/settings", t0 + 20, other),
);

const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};
ok("unreadable storage does not trap the sign-in page", !loginRedirectBlocked(target, t0, broken));
noteLoginRedirect(target, t0, broken);

const notices = memoryStorage();
publishSignOut(notices);
ok(
  "a sign-out write is the key other tabs listen for",
  isSignOutNotice({
    key: SIGN_OUT_STORAGE_KEY,
    newValue: notices.getItem(SIGN_OUT_STORAGE_KEY),
  }),
);
ok(
  "some other key is not a sign-out",
  !isSignOutNotice({ key: "webinar.theme", newValue: "dark" }),
);
ok(
  "clearing the key is not a sign-out",
  !isSignOutNotice({ key: SIGN_OUT_STORAGE_KEY, newValue: null }),
);

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}  ${passed}/${passed + failed} checks passed`,
);
process.exit(failed === 0 ? 0 : 1);
