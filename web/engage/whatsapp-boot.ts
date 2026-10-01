/* Reads the WhatsApp home needs, started when the page mounts — the same moment
 * as the login check — and shared with the screen that paints them.
 *
 * One promise per read. The screen calls begin on mount, before it is willing
 * to draw. When the session comes back signed-in, the component joins that
 * promise instead of starting a second round trip. A failure clears the slot
 * so a later visit can try again. resetWhatsAppBoot drops a result that arrived
 * for a session the login check then rejected. */

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
        needsReply: summary?.needsReply ?? 0,
      }))
      .catch((err: unknown) => {
        homeFlight = null;
        throw err;
      });
  }
  return homeFlight;
}

/** Last 30 days, the metrics card's first window. Later period changes ask again. */
export function beginWhatsAppMetrics(): Promise<CRMMetricsResponse> {
  if (!metricsFlight) {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    metricsFlight = engageApi
      .crmMetrics(from.toISOString(), to.toISOString())
      .catch((err: unknown) => {
        metricsFlight = null;
        throw err;
      });
  }
  return metricsFlight;
}

export function resetWhatsAppBoot(): void {
  homeFlight = null;
  metricsFlight = null;
}
