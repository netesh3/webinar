import { MaterialIcon, WhatsAppIcon } from "@/components/icons";
import { ChannelWhatsApp } from "@/lib/api-types";

export function ChannelIcon({
  channel,
  className,
}: {
  channel: string;
  className: string;
}) {
  if (channel === ChannelWhatsApp) {
    return <WhatsAppIcon className={`${className} shrink-0`} />;
  }
  return <MaterialIcon name="mail" className={className} />;
}
