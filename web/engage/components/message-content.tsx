"use client";

import { useState } from "react";
import { API_BASE } from "@/lib/api";
import type { CRMMessage } from "@/lib/api-types";
import { threadModel } from "../message-kind";

/** The session cookie travels with this URL. The token that downloads from Meta does not. */
export function messageMediaURL(messageId: string): string {
  return `${API_BASE}/api/host/crm/messages/${encodeURIComponent(messageId)}/media`;
}

export function MessageContent({ message }: { message: CRMMessage }) {
  const model = threadModel(message);
  switch (model.type) {
    case "text":
      return <span className="whitespace-pre-wrap">{model.text}</span>;
    case "unsupported":
      return <span className="italic opacity-80">{model.text}</span>;
    case "reaction":
      return <span>{model.text}</span>;
    case "photo":
      return (
        <Photo
          messageId={model.media ? message.id : undefined}
          caption={model.caption}
        />
      );
    case "sticker":
      return <Sticker messageId={model.media ? message.id : undefined} />;
    case "card":
      return (
        <span className="grid gap-0.5">
          <span className="font-medium">{model.label}</span>
          {model.caption && (
            <span className="whitespace-pre-wrap">{model.caption}</span>
          )}
        </span>
      );
    case "document":
      return (
        <span className="grid gap-0.5">
          {model.media ? (
            <a
              href={messageMediaURL(message.id)}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline"
            >
              {model.filename ? `Document: ${model.filename}` : "Document"}
            </a>
          ) : (
            <span className="font-medium">
              {model.filename ? `Document: ${model.filename}` : "Document"}
            </span>
          )}
          {model.caption && (
            <span className="whitespace-pre-wrap">{model.caption}</span>
          )}
        </span>
      );
    case "location":
      return (
        <span className="grid gap-0.5">
          <span className="font-medium">Location</span>
          {model.name && <span>{model.name}</span>}
          {model.address && <span>{model.address}</span>}
          {model.href && (
            <a
              href={model.href}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Open in Maps
            </a>
          )}
        </span>
      );
    case "contact":
      return (
        <span className="grid gap-0.5">
          <span className="font-medium">Contact</span>
          <span>{model.name}</span>
        </span>
      );
  }
}

/* Why an attachment did not load. An <img> error carries no status, so the
 * endpoint is asked once more for its error code. */
function useMediaFailure(messageId: string | undefined, noun: string) {
  const [reason, setReason] = useState<string | null>(null);
  const fail = () => {
    setReason(`${noun} couldn't load`);
    if (!messageId) return;
    fetch(messageMediaURL(messageId), { credentials: "include" })
      .then((res) => (res.ok ? null : res.json()))
      .then((body: { error?: string } | null) => {
        if (body?.error) setReason(mediaFailureText(body.error, noun));
      })
      .catch(() => {});
  };
  return { reason, fail };
}

export function mediaFailureText(code: string, noun: string): string {
  switch (code) {
    case "media_expired":
      return `${noun} expired on WhatsApp`;
    case "whatsapp_token_rejected":
    case "whatsapp_not_connected":
      return `Reconnect WhatsApp to see this ${noun.toLowerCase()}`;
    default:
      return `${noun} couldn't load`;
  }
}

function Photo({
  messageId,
  caption,
}: {
  messageId?: string;
  caption?: string;
}) {
  const { reason, fail } = useMediaFailure(messageId, "Photo");
  return (
    <span className="grid gap-1.5">
      {messageId && !reason ? (
        // The bytes come from our API, authenticated by the session cookie.
        // next/image would proxy them without that cookie.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={messageMediaURL(messageId)}
          alt="Photo"
          className="block max-h-64 max-w-full rounded-md object-contain"
          onError={fail}
        />
      ) : (
        <span className="font-medium">{reason ?? "Photo"}</span>
      )}
      {caption && <span className="whitespace-pre-wrap">{caption}</span>}
    </span>
  );
}

function Sticker({ messageId }: { messageId?: string }) {
  const { reason, fail } = useMediaFailure(messageId, "Sticker");
  if (!messageId || reason) return <span className="font-medium">{reason ?? "Sticker"}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={messageMediaURL(messageId)}
      alt="Sticker"
      className="block h-28 w-28 object-contain"
      onError={fail}
    />
  );
}
