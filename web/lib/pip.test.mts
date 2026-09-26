/* Remembering a closed pop-out during screen share.
 *
 * Run with `make test-web`.
 *
 * Document PiP itself is not unit-testable (see e2e/probe-pip.mjs). The decision that made the
 * window keep coming back — whether a given close should suppress MediaSession auto-reopen —
 * is pure, and that is what this pins.
 */

import { shouldRememberPipDismiss } from "./pip-dismiss.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

console.log("\nshouldRememberPipDismiss");

{
  ok(
    shouldRememberPipDismiss({
      shareActive: true,
      tabVisible: false,
    }),
    "X while the tab is still in the background during a share is remembered",
  );
  ok(
    shouldRememberPipDismiss({
      shareActive: true,
      tabVisible: true,
      explicitDismiss: true,
    }),
    "closing from the Pop out button during a share is remembered",
  );
  ok(
    !shouldRememberPipDismiss({
      shareActive: true,
      tabVisible: true,
    }),
    "returning to the tab during a share is NOT remembered — that is the automatic close",
  );
  ok(
    !shouldRememberPipDismiss({
      shareActive: false,
      tabVisible: false,
    }),
    "closing with no share live does not start a remembered dismiss",
  );
  ok(
    !shouldRememberPipDismiss({
      shareActive: false,
      tabVisible: true,
      explicitDismiss: true,
    }),
    "an explicit close with no share live does not stick either",
  );
}

console.log(
  failures === 0 ? `\n${checks} passed\n` : `\n${failures}/${checks} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
