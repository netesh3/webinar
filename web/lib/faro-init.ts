/* Starts Grafana Faro. Imported dynamically by components/faro-boot.tsx after the page has
 * loaded, so the SDK is a chunk of its own and never on the first-paint path.
 *
 * The core web SDK only (no tracing: the OpenTelemetry half is several times its size). What
 * it collects: uncaught errors and unhandled rejections, Web Vitals, sessions (an anonymous
 * random id) and views, plus the app's own events (lib/observability.ts). Deliberately not:
 * console capture (log lines can carry names and chat), resource and performance timings
 * (their URLs carry API paths and queries), user actions, user identity.
 */

import {
  ErrorsInstrumentation,
  SessionInstrumentation,
  ViewInstrumentation,
  WebVitalsInstrumentation,
  initializeFaro,
} from "@grafana/faro-web-sdk";
import { scrubItem } from "./faro-privacy";
import { attachFaro, detachFaro } from "./observability";

/** Share of sessions that report anything. All of them at the current scale. */
export const FARO_SESSION_SAMPLE_RATE = 1;

export const FARO_APP_NAME = "webinar-liv-web";

// Noise from browser extensions and the like, not this app.
const IGNORE_ERRORS: Array<string | RegExp> = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  /^Script error\.?$/,
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /safari-(web-)?extension:\/\//,
];

let started = false;

export function startFaro(url: string) {
  if (started) return;
  started = true;
  try {
    const faro = initializeFaro({
      url,
      app: {
        name: FARO_APP_NAME,
        version: process.env.NEXT_PUBLIC_GIT_SHA || undefined,
        environment: process.env.NEXT_PUBLIC_FARO_ENV || process.env.NODE_ENV,
      },
      instrumentations: [
        new ErrorsInstrumentation(),
        new WebVitalsInstrumentation(),
        new SessionInstrumentation(),
        new ViewInstrumentation(),
      ],
      sessionTracking: {
        enabled: true,
        samplingRate: FARO_SESSION_SAMPLE_RATE,
      },
      ignoreErrors: IGNORE_ERRORS,
      // Faro's own collector, so its beacons are never reported as page requests.
      ignoreUrls: [url],
      trackResources: false,
      trackGeolocation: false,
      beforeSend: (item) => scrubItem(item),
    });
    attachFaro({
      pushEvent: (name, attributes) => faro.api.pushEvent(name, attributes),
      pushError: (error, options) => faro.api.pushError(error, options),
    });
  } catch {
    detachFaro();
  }
}
