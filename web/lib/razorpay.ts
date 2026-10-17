/* Razorpay Checkout in the browser.
 *
 * Checkout is Razorpay's own hosted dialog (an iframe over the page) loaded from
 * checkout.razorpay.com. It takes the order the API created and returns a signed
 * {order id, payment id, signature} on success, which the API verifies before
 * anything is granted. Card numbers and UPI handles never touch this app.
 *
 * Loaded on first use rather than in <head>: the script is only needed by
 * somebody who has pressed Buy.
 */

import type {
  BillingCheckout,
  TrialCheckout,
  VerifyBillingPaymentRequest,
  VerifyTrialRequest,
} from "./api-types";

const SRC = "https://checkout.razorpay.com/v1/checkout.js";

/* One Checkout, two shapes: an order (pay now) carries order_id and amount; a
 * subscription (the trial) carries subscription_id instead, and Razorpay works out
 * today's small authorisation itself. */
type RazorpayOptions = {
  key: string;
  order_id?: string;
  subscription_id?: string;
  amount?: number;
  currency?: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (res: VerifyBillingPaymentRequest & VerifyTrialRequest) => void;
  modal?: { ondismiss?: () => void; confirm_close?: boolean };
};

type RazorpayInstance = {
  open: () => void;
  on: (event: "payment.failed", cb: (res: { error?: { description?: string } }) => void) => void;
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Razorpay) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new CheckoutError("load", "Couldn't reach the payment page. Check your connection and try again."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Why Checkout ended without a payment. "dismissed" is the buyer closing it. */
export class CheckoutError extends Error {
  constructor(
    readonly reason: "load" | "dismissed" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** Opens Checkout for an order. Resolves with the signed response on success. */
export async function payWithRazorpay(
  order: BillingCheckout,
  appName: string,
): Promise<VerifyBillingPaymentRequest> {
  const res = await openCheckout(
    {
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      description: order.description,
    },
    appName,
    { name: order.prefillName, email: order.prefillEmail, contact: order.prefillPhone },
  );
  return {
    razorpay_order_id: res.razorpay_order_id,
    razorpay_payment_id: res.razorpay_payment_id,
    razorpay_signature: res.razorpay_signature,
  };
}

/** Opens Checkout to authorise a trial's subscription. Resolves with the signed response. */
export async function authoriseTrial(trial: TrialCheckout, appName: string): Promise<VerifyTrialRequest> {
  const res = await openCheckout(
    { key: trial.keyId, subscription_id: trial.subscriptionId, description: trial.description },
    appName,
    { name: trial.prefillName, email: trial.prefillEmail, contact: trial.prefillPhone },
  );
  return {
    razorpay_payment_id: res.razorpay_payment_id,
    razorpay_subscription_id: res.razorpay_subscription_id,
    razorpay_signature: res.razorpay_signature,
  };
}

async function openCheckout(
  opts: Pick<RazorpayOptions, "key" | "order_id" | "subscription_id" | "amount" | "currency" | "description">,
  appName: string,
  prefill: { name?: string; email?: string; contact?: string },
): Promise<VerifyBillingPaymentRequest & VerifyTrialRequest> {
  await loadScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new CheckoutError("load", "The payment page didn't load. Please try again.");

  return new Promise((resolve, reject) => {
    let settled = false;
    const rzp = new Razorpay({
      ...opts,
      name: appName,
      prefill: { name: prefill.name, email: prefill.email, contact: prefill.contact || undefined },
      theme: { color: "#3a4cf3" },
      handler: (res) => {
        settled = true;
        resolve(res);
      },
      modal: {
        confirm_close: true,
        ondismiss: () => {
          if (!settled) reject(new CheckoutError("dismissed", "Payment cancelled."));
        },
      },
    });
    /* A failed attempt (declined card, UPI timeout) keeps Checkout open so the
     * buyer can retry with another method; it is only reported if they then
     * close it, through ondismiss above. */
    rzp.on("payment.failed", () => {});
    rzp.open();
  });
}

/** Minor units → "₹17,698.82" / "$49". Whole amounts drop the decimals. */
export function formatMoney(minor: number, currency: string, opts?: { exact?: boolean }): string {
  const major = minor / 100;
  const whole = Number.isInteger(major) && !opts?.exact;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(major);
}
