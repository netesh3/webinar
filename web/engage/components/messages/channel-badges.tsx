import { ChannelEmail, ChannelWhatsApp } from "@/lib/api-types";

/* Email and WhatsApp chips on a message row. A chip is there only while that
 * channel is selected, so turning one off in the pane takes its chip away. */

const LABELS: Record<string, string> = {
  [ChannelEmail]: "Email",
  [ChannelWhatsApp]: "WhatsApp",
};

export function ChannelBadges({ channels }: { channels: string[] }) {
  const shown = [ChannelEmail, ChannelWhatsApp].filter((channel) =>
    channels.includes(channel),
  );
  if (shown.length === 0) return null;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {shown.map((channel) => (
        <span
          key={channel}
          className={`rounded px-1.5 py-px text-[10.5px] font-semibold ${
            channel === ChannelWhatsApp
              ? "bg-ok-soft text-ok"
              : "bg-surface-2 text-ink-2"
          }`}
        >
          {LABELS[channel]}
        </span>
      ))}
    </span>
  );
}
