/* Labels for a WhatsApp message that is not plain text.
 *
 * The inbox used to interpolate Meta's type into "Sent a ${kind}", which is how
 * a message Meta itself typed as "unsupported" rendered as "Sent a unsupported".
 * "unsupported" is Meta's type for a payload the Cloud API cannot deliver (a
 * poll, view-once, some media from a newer client). It is not a bucket we put
 * unknown types into. Unknown types keep their name, with a grammatical article.
 *
 * Rows stored before media ids were kept still have kind and body. Those render
 * from that: a photo with no id is the word Photo plus its caption, and an
 * unsupported row with no stored payload is the fixed sentence below.
 */

export const UNSUPPORTED_MESSAGE =
  "Message type not supported by WhatsApp's API (open WhatsApp on your phone to view)";

export type MessageMedia = {
  id?: string;
  mimeType?: string;
  filename?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
  emoji?: string;
  target?: string;
  contacts?: string[];
};

/** The fields the label needs. A CRMMessage satisfies this. */
export type PreviewMessage = {
  id?: string;
  kind?: string;
  body?: string;
  templateName?: string;
  media?: MessageMedia;
};

export type ThreadModel =
  | { type: "text"; text: string }
  | { type: "unsupported"; text: string }
  | { type: "photo"; media: boolean; caption?: string }
  | { type: "sticker"; media: boolean }
  | { type: "card"; label: string; caption?: string }
  | { type: "document"; filename: string; caption?: string; media: boolean }
  | { type: "location"; name: string; address: string; href?: string }
  | { type: "contact"; name: string }
  | { type: "reaction"; text: string };

const FILE_RE = /^[^\\/\n\r]{1,240}\.[A-Za-z0-9]{1,8}$/;

function prettyTemplate(name?: string): string {
  return (name ?? "").replace(/_/g, " ").trim();
}

function looksLikeFilename(s: string): boolean {
  return FILE_RE.test(s);
}

function documentFilename(m: PreviewMessage, body: string): string {
  const named = m.media?.filename?.trim() ?? "";
  if (named) return named;
  if (looksLikeFilename(body)) return body;
  return "";
}

function caption(body: string, filename: string): string | undefined {
  const text = body.trim();
  if (!text || (filename && text === filename)) return undefined;
  return text;
}

function withCaption(label: string, extra?: string): string {
  if (!extra) return label;
  return `${label} — ${extra}`;
}

function sentA(kind: string): string {
  const word = kind.replace(/_/g, " ");
  const article = /^[aeiou]/i.test(word) ? "an" : "a";
  return `Sent ${article} ${word}`;
}

export function mapsHref(
  lat?: number,
  lng?: number,
): string | undefined {
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function contactName(m: PreviewMessage, body: string): string {
  const fromMedia = (m.media?.contacts ?? []).map((n) => n.trim()).filter(Boolean);
  if (fromMedia.length > 0) return fromMedia.join(", ");
  return body;
}

function reactionText(m: PreviewMessage, body: string): string {
  const emoji = m.media?.emoji?.trim() || "";
  if (emoji) return `Reacted ${emoji}`;
  if (body) return `Reacted ${body}`;
  return "Removed a reaction";
}

/** One line for the conversation list. Never "a unsupported". */
export function previewLabel(m: PreviewMessage): string {
  const kind = (m.kind ?? "").trim().toLowerCase();
  const body = (m.body ?? "").trim();
  if (!kind) {
    return body || prettyTemplate(m.templateName) || "No message text";
  }
  switch (kind) {
    case "image":
      return withCaption("📷 Photo", caption(body, ""));
    case "video":
      return withCaption("🎥 Video", caption(body, ""));
    case "voice":
      return withCaption("🎤 Voice message", caption(body, ""));
    case "audio":
      return withCaption("🎵 Audio", caption(body, ""));
    case "document": {
      const file = documentFilename(m, body);
      const base = file ? `📄 Document: ${file}` : "📄 Document";
      return withCaption(base, caption(body, file));
    }
    case "sticker":
      return "Sticker";
    case "location": {
      const name = m.media?.name?.trim();
      return name ? `📍 ${name}` : "📍 Location";
    }
    case "contacts":
      return contactName(m, body) || "Contact";
    case "reaction":
      return reactionText(m, body);
    case "button":
    case "interactive":
      return body || "Tapped a button";
    case "system":
      return body || "System message";
    case "unsupported":
      return UNSUPPORTED_MESSAGE;
    default:
      return body || sentA(kind);
  }
}

/** What the thread bubble draws. media means a thumbnail or download can be asked for. */
export function threadModel(m: PreviewMessage): ThreadModel {
  const kind = (m.kind ?? "").trim().toLowerCase();
  const body = (m.body ?? "").trim();
  const media = Boolean(m.media?.id && m.id);
  switch (kind) {
    case "":
      return {
        type: "text",
        text: body || prettyTemplate(m.templateName) || "No message text",
      };
    case "image":
      return { type: "photo", media, caption: caption(body, "") };
    case "sticker":
      return { type: "sticker", media };
    case "video":
      return { type: "card", label: "Video", caption: caption(body, "") };
    case "voice":
      return { type: "card", label: "Voice message", caption: caption(body, "") };
    case "audio":
      return { type: "card", label: "Audio", caption: caption(body, "") };
    case "document": {
      const file = documentFilename(m, body);
      return {
        type: "document",
        filename: file,
        caption: caption(body, file),
        media,
      };
    }
    case "location":
      return {
        type: "location",
        name: m.media?.name?.trim() ?? "",
        address: m.media?.address?.trim() ?? "",
        href: mapsHref(m.media?.latitude, m.media?.longitude),
      };
    case "contacts":
      return { type: "contact", name: contactName(m, body) || "Contact" };
    case "reaction":
      return { type: "reaction", text: reactionText(m, body) };
    case "button":
    case "interactive":
      return { type: "text", text: body || "Tapped a button" };
    case "system":
      return { type: "text", text: body || "System message" };
    case "unsupported":
      return { type: "unsupported", text: UNSUPPORTED_MESSAGE };
    default:
      return { type: "text", text: body || sentA(kind) };
  }
}

/** @deprecated Prefer previewLabel, which can see a caption and a filename. */
export function kindText(kind?: string): string {
  return previewLabel({ kind });
}
