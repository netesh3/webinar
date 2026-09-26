"use client";

import { useState } from "react";
import { unseenMentions } from "./mentions";
import type { ChatMessage } from "./realtime";

/* The "@" on the Chat button: how many messages tag me that I have not looked at.
 *
 * Seen means the panel was in front of me while the message was in the conversation —
 * the same definition the unread watermark in webinar-room.tsx uses, kept by id rather
 * than by count so a backlog merged into the middle does not shift it. Adjusted during
 * render for the same reason that watermark is: an effect would paint the badge one
 * more frame after opening the panel it points at.
 *
 * A message removed by a moderator drops out of `chat`, and so out of the count.
 */
export function useMentionBadge(
  chat: readonly ChatMessage[],
  myIdentity: string,
  chatVisible: boolean,
): number {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const unseen = unseenMentions(chat, myIdentity, seen);
  if (chatVisible && unseen.length > 0) setSeen(new Set([...seen, ...unseen]));
  return chatVisible ? 0 : unseen.length;
}
