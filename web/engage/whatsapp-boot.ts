/* Reads the WhatsApp home needs, started when the page mounts — the same moment
 * as the login check — and shared with the screen that paints them.
 *
 * One promise per read. The screen calls begin on mount, before it is willing
 * to draw. When the session comes back signed-in, the component joins that
 * promise instead of starting a second round trip. A failure clears the slot
 * so a later visit can try again. resetWhatsAppBoot drops a result that arrived
 * for a session the login check then rejected. */

import { presetRange } from "@/components/date-picker";
import { DEFAULT_TIME_ZONE } from "@/lib/format";
import { engageApi } from "./api";
import type {
  CRMDrip,
  CRMMergeField,
  CRMMetricsResponse,
  CRMRecipesResponse,
  CRMTag,
} from "@/lib/api-types";
import type { MessageSlot } from "@/lib/api-types";

export type WhatsAppHomeBundle = {
  slots: MessageSlot[];
  fields: CRMMergeField[];
  recipes: CRMRecipesResponse | null;
  rules: CRMDrip[];
  tags: CRMTag[];
  needsReply: number;
};

let homeFlight: Promise<WhatsAppHomeBundle> | null = null;
let metricsFlight: Promise<CRMMetricsResponse> | null = null;
let metricsKey: string | null = null;

/* Same 30-day chip the metrics card opens on: inclusive calendar dates in the
 * app time zone, not a rolling timestamp window. */
const metricsDefaultPreset = {
  id: "30d",
  label: "30 days",
  fromOffset: -29,
  toOffset: 0,
};

export function beginWhatsAppHome(): Promise<WhatsAppHomeBundle> {
  if (!homeFlight) {
    homeFlight = Promise.all([
      engageApi.crmMessageDefaults(),
      engageApi.crmReminders().catch(() => null),
      engageApi.crmRecipes().catch(() => null),
      engageApi.crmDrips().catch(() => null),
      engageApi.crmSummary().catch(() => null),
    ])
      .then(([defaults, reminders, recipes, drips, summary]) => ({
        slots: defaults.slots,
        fields: reminders?.fields ?? [],
        recipes,
        rules: (drips?.drips ?? []).filter((x) => !x.recipe),
        tags: drips?.tags ?? [],
        // The chat badge does not keep this. It is one snapshot from login, and
        // opening a thread must drop the number before the next visit. The live
        // count is useReplies; this is only the first paint before that returns.
        needsReply: summary?.needsReply ?? 0,
      }))
      .catch((err: unknown) => {
        homeFlight = null;
        throw err;
      });
  }
  return homeFlight;
}

/** The metrics card's first window. Later range changes ask again. */
export function beginWhatsAppMetrics(): Promise<CRMMetricsResponse> {
  if (!metricsFlight) {
    const { from, to } = presetRange(metricsDefaultPreset, DEFAULT_TIME_ZONE);
    metricsKey = `${from}|${to}`;
    metricsFlight = engageApi.crmMetrics(from, to).catch((err: unknown) => {
      metricsFlight = null;
      metricsKey = null;
      throw err;
    });
  }
  return metricsFlight;
}

/** The prefetch, when `from`/`to` are the window it already asked for. */
export function whatsAppMetricsFlightFor(
  from: string,
  to: string,
): Promise<CRMMetricsResponse> | null {
  if (metricsFlight && metricsKey === `${from}|${to}`) return metricsFlight;
  return null;
}

export function resetWhatsAppBoot(): void {
  homeFlight = null;
  metricsFlight = null;
  metricsKey = null;
}
