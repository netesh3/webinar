/* A simulive's Auto mode, on the browser's side (api/internal/api/qa_auto.go).
 *
 * The assistant answers new audience questions from the host's AI knowledge, and signs every
 * answer "✨ <First name>'s assistant". That it is an assistant is a firm rule, not a setting:
 * the label is the server's, and assistantSignature below makes sure what is shown always
 * carries the sparkle and says "assistant", whatever arrives. Never the host's name or avatar
 * as the answer's author.
 *
 * Cloud Run gives the server CPU only while a request runs, so the asker's own browser is what
 * asks for the batch to be answered: the ask's response says how long to wait
 * (autoAnswerInMs), and withAutoAnswer makes that one follow-up call. Pure, so it is tested
 * on its own (qa-auto.test.mts). */

import type { SendMessageResponse } from "./api-types.ts";

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const MAX_LABEL = 80;

/** Whether an account may switch Auto mode on: the simulive_auto feature, which is only in
 *  effect with ai, replay_engage and simulive too (the server drops it otherwise; checked here
 *  as well so an older account payload cannot offer it). */
export function autoModeAvailable(features: readonly string[] | null | undefined): boolean {
  const f = features ?? [];
  return ["simulive_auto", "ai", "replay_engage", "simulive"].every((k) => f.includes(k));
}

/** The label the host's audience would see, worked out the way the server does it (for the
 *  schedule form, before there is a saved webinar to ask): the first name only. */
export function assistantLabelFor(hostName: string | null | undefined): string {
  const first = (hostName ?? "").trim().split(/\s+/)[0];
  return first ? `✨ ${first}'s assistant` : "✨ The host's assistant";
}

/** How long to wait before asking for the batch, or null when Auto mode is not answering. */
export function autoAnswerDelay(res: Pick<SendMessageResponse, "autoAnswerInMs"> | null | undefined): number | null {
  const ms = res?.autoAnswerInMs;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}

/** How an assistant's answer is signed, or null for the host team's. Always opens with the
 *  sparkle and always says it is an assistant. */
export function assistantSignature(answerBy: string | null | undefined): string | null {
  const s = (answerBy ?? "").trim().slice(0, MAX_LABEL);
  if (!s) return null;
  const sparkled = s.startsWith("✨") ? s : `✨ ${s}`;
  return /assistant/i.test(sparkled) ? sparkled : `${sparkled} (assistant)`;
}

/** What the host is told the audience will see, next to the switch. */
export function autoAnswerDisclosure(label: string): string {
  const sig = assistantSignature(label) ?? "✨ Assistant";
  return `Your audience sees each answer signed “${sig}” — always marked as your assistant, never as you. Only questions your AI knowledge answers are posted; the rest wait for you.`;
}

/** A relay that, after a question Auto mode took, makes the one follow-up call for the batch.
 *  The call's own outcome does not matter to the asker: an answer arrives on the data channel. */
export function withAutoAnswer<Req>(
  relay: (req: Req) => Promise<SendMessageResponse>,
  trigger: () => Promise<unknown>,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): (req: Req) => Promise<SendMessageResponse> {
  return async (req: Req) => {
    const res = await relay(req);
    const ms = autoAnswerDelay(res);
    if (ms != null) {
      schedule(() => {
        trigger().catch(() => {
          /* best effort: the next asker's call takes whatever is still waiting */
        });
      }, ms);
    }
    return res;
  };
}
