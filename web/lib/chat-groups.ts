import type { ChatDestination, ChatMessage, Sender } from "./realtime";

/* How the chat panel folds a conversation into runs.
 *
 * Consecutive messages from the same person, to the same audience, a few minutes
 * apart at most, are drawn under one avatar and one name. Audience is part of the
 * key because a panelists-only aside wedged between two public lines must never
 * look like it belongs to them. Pure, so it is tested alongside chat-notify.
 */

/** A pause longer than this starts a fresh group even from the same person. */
export const GROUP_GAP_MS = 5 * 60_000;

export type ChatGroup = {
  from: Sender;
  destination: ChatDestination;
  messages: ChatMessage[];
};

export function groupChat(chat: readonly ChatMessage[]): ChatGroup[] {
  const out: ChatGroup[] = [];
  for (const message of chat) {
    const last = out[out.length - 1];
    const previous = last?.messages[last.messages.length - 1];
    if (
      last &&
      previous &&
      last.from.identity === message.from.identity &&
      last.destination === message.destination &&
      message.at - previous.at <= GROUP_GAP_MS
    ) {
      last.messages.push(message);
    } else {
      out.push({ from: message.from, destination: message.destination, messages: [message] });
    }
  }
  return out;
}

/** Who spoke in the last `count` messages, newest first, without you and without
 *  repeats — the faces on the "N new messages" pill. */
export function recentSpeakers(
  chat: readonly ChatMessage[],
  count: number,
  myIdentity: string,
  max = 3,
): Sender[] {
  const out: Sender[] = [];
  const seen = new Set<string>();
  for (let i = chat.length - 1; i >= 0 && i >= chat.length - count; i--) {
    const from = chat[i].from;
    if (from.identity === myIdentity || seen.has(from.identity)) continue;
    seen.add(from.identity);
    out.push(from);
    if (out.length === max) break;
  }
  return out;
}
