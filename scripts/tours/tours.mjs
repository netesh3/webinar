/* Every guided tour, in the order a new host needs them. */

import { home, create } from "./tours-start.mjs";
import { invite, results, followup } from "./tours-webinar.mjs";
import { live } from "./tours-live.mjs";
import { messages, whatsapp, audience } from "./tours-engage.mjs";

export const TOURS = [home, create, invite, live, results, followup, messages, whatsapp, audience];
