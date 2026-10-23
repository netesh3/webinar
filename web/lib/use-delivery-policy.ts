"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import type { DeliveryPolicy } from "./api-types";

/* GET /api/host/delivery, for the schedule form and the instant button: which delivery to
 * offer for a new webinar, or (slug) for one being edited. Null until it answers, and on a
 * failure: the form then offers nothing and omits the field, and the server applies its own
 * rule on the save either way. */
export function useDeliveryPolicy(enabled: boolean, slug?: string): DeliveryPolicy | null {
  const key = enabled ? (slug ?? "") : null;
  const [state, setState] = useState<{ key: string | null; policy: DeliveryPolicy | null }>({
    key: null,
    policy: null,
  });
  useEffect(() => {
    if (key === null) return;
    let active = true;
    api
      .hostDeliveryPolicy(key || undefined)
      .then((policy) => {
        if (active) setState({ key, policy });
      })
      .catch(() => {
        if (active) setState({ key, policy: null });
      });
    return () => {
      active = false;
    };
  }, [key]);
  return state.key === key ? state.policy : null;
}
