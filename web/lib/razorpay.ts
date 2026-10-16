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

import type { BillingCheckout, VerifyBillingPaymentRequest } from "./api-types";

const SRC = "https://checkout.razorpay.com/v1/checkout.js";

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (res: VerifyBillingPaymentRequest) => void;
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
  await loadScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new CheckoutError("load", "The payment page didn't load. Please try again.");

  return new Promise((resolve, reject) => {
    let settled = false;
    const rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: appName,
      description: order.description,
      prefill: {
        name: order.prefillName,
        email: order.prefillEmail,
        contact: order.prefillPhone || undefined,
      },
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
