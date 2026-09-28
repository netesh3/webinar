import { ChannelEmail, ChannelWhatsApp } from "@/lib/api-types";

/* Email and WhatsApp, in a fixed slot at the right of a message row.
 * A channel the message does not use is still named, dimmed, so every row
 * lines up and "off" is visible without opening the pane. */

const LABELS: Record<string, string> = {
  [ChannelEmail]: "Email",
  [ChannelWhatsApp]: "WhatsApp",
};

export function ChannelBadges({
  channels,
  enabled,
  both = true,
}: {
  channels: string[];
  /** The row's switch. Off dims every badge; a missing channel is dim on its own. */
  enabled: boolean;
  /** Confirmation, reminder and replay always show both. A follow-up shows the
   *  channels it actually sends on. */
  both?: boolean;
}) {
  const shown = both
    ? [ChannelEmail, ChannelWhatsApp]
    : [ChannelEmail, ChannelWhatsApp].filter((channel) => channels.includes(channel));
  if (shown.length === 0) return <span className="block w-full" />;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {shown.map((channel) => {
        const on = enabled && channels.includes(channel);
        return (
          <span
            key={channel}
            className={`rounded px-1.5 py-px text-[10.5px] font-semibold ${
              on
                ? channel === ChannelWhatsApp
                  ? "bg-ok-soft text-ok"
                  : "bg-surface-2 text-ink-2"
                : "bg-surface-2 text-ink-3"
            }`}
          >
            {LABELS[channel]}
          </span>
        );
      })}
    </span>
  );
}
