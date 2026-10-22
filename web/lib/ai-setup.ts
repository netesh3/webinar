/* "Write with AI" on the schedule form: the pure half.
 *
 * What a draft fills in, what the host is told when it cannot be written, and the
 * registration copy as one block of text to paste. The component (components/schedule/
 * ai-setup.tsx) is only state and buttons around these. */

import type { AIWebinarSetup } from "./api-types.ts";

/** The longest idea the API accepts (aiwrite.MaxIdeaRunes). */
export const AI_IDEA_MAX = 300;

export type AILanguage = "en" | "hinglish" | "hi-roman";

export const AI_LANGUAGES: readonly { value: AILanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "hinglish", label: "Hinglish" },
  { value: "hi-roman", label: "Hindi (Roman script)" },
];

/** The form fields a draft writes: the topic and the description. Nothing else is
 *  touched — the registration copy and posts are offered, not applied. */
export type SetupFill = { topic: string; description: string };

/** What applying the draft does to the form. An empty field in the draft keeps
 *  what the host had rather than blanking it. */
export function fillFromDraft(draft: AIWebinarSetup, current: SetupFill): SetupFill {
  return {
    topic: draft.title.trim() || current.topic,
    description: draft.description.trim() || current.description,
  };
}

/** Whether applying would overwrite something the host wrote themselves, so the
 *  form can offer to undo it. */
export function overwrites(current: SetupFill, next: SetupFill): boolean {
  return (
    (current.topic.trim() !== "" && current.topic !== next.topic) ||
    (current.description.trim() !== "" && current.description !== next.description)
  );
}

/** The headline and bullets as one paste-ready block. */
export function registrationCopyText(draft: AIWebinarSetup): string {
  const bullets = draft.registrationBullets.map((b) => `• ${b}`).join("\n");
  return [draft.registrationHeadline.trim(), bullets].filter(Boolean).join("\n\n");
}

/** The social posts in the order the panel shows them, empty ones left out. */
export function socialPostList(draft: AIWebinarSetup): { channel: string; text: string }[] {
  return [
    { channel: "WhatsApp", text: draft.socialPosts.whatsapp },
    { channel: "Instagram", text: draft.socialPosts.instagram },
    { channel: "LinkedIn", text: draft.socialPosts.linkedin },
  ].filter((p) => p.text.trim() !== "");
}

/** The sentence a host sees when a draft could not be written, from the API error. */
export function aiErrorMessage(err: {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
}): string {
  switch (err.code) {
    case "ai_limit":
      return "AI limit reached for this month. You can still write it yourself.";
    case "feature_off":
      return "AI is off for your account.";
    case "ai_unavailable":
      return "AI writing isn't available right now. Try again in a minute.";
    case "rate_limited":
      return "That's a lot of drafts in a minute. Try again shortly.";
    case "validation_failed":
      return (
        err.fields?.idea ?? err.fields?.language ?? "Tell us a little about your webinar first."
      );
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
  }
  return "Couldn't write a draft. Try again, or write it yourself.";
}
