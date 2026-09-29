import { ChannelEmail, ChannelWhatsApp } from "@/lib/api-types";
import { ChannelIcon } from "./channel-icon";

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
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] font-semibold ${
            channel === ChannelWhatsApp
              ? "border-ok/25 bg-ok-soft text-ok"
              : "border-brand-line bg-brand-soft text-brand"
          }`}
        >
          <ChannelIcon channel={channel} className="size-3" />
          {LABELS[channel]}
        </span>
      ))}
    </span>
  );
}
