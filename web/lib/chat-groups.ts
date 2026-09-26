import type { ChatDestination, ChatMessage, Sender } from "./realtime";

/* How the chat panel lays a conversation out.
 *
 * Every send is its own message, with its own avatar, name and time — never folded
 * into the previous one, even from the same person a second later. Folding runs
 * together made five separate sends read as one message, which is not what the
 * sender did. Pure, so it is tested alongside chat-notify.
 */

export type ChatGroup = {
  from: Sender;
  destination: ChatDestination;
  /** Always exactly one message. */
  messages: [ChatMessage];
};

export function groupChat(chat: readonly ChatMessage[]): ChatGroup[] {
  return chat.map((message) => ({
    from: message.from,
    destination: message.destination,
    messages: [message],
  }));
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
