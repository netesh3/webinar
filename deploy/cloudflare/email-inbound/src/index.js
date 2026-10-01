/**
 * Catch-all for *@webinarliv.com.
 * Posts the message to the API, which files it under users.inbox_local
 * (or a previous alias). Unknown local parts are dropped by the API.
 */
export default {
  async email(message, env) {
    const to = String(message.to || "");
    const host = String(env.INBOUND_HOST || "webinarliv.com").toLowerCase();
    const local = localPart(to, host);
    if (!local) {
      message.setReject("Not an address on " + host);
      return;
    }

    const subject = message.headers.get("subject") || "(no subject)";
    const from = message.from || "";
    const messageId = message.headers.get("message-id") || "";
    const inReplyTo = message.headers.get("in-reply-to") || "";
    let text = "";
    try {
      const raw = await new Response(message.raw).text();
      text = plainFromRaw(raw) || subject;
    } catch {
      text = subject;
    }
    if (text.length > 49000) text = text.slice(0, 49000);

    const base = String(env.API_BASE_URL || "").replace(/\/$/, "");
    const secret = env.INBOX_WEBHOOK_SECRET || "";
    const payload = {
      to,
      from: String(from).slice(0, 320),
      subject: String(subject).slice(0, 500),
      text,
      messageId: String(messageId).slice(0, 500),
      inReplyTo: String(inReplyTo).slice(0, 500),
    };

    let apiStatus = 0;
    if (base && secret) {
      const res = await fetch(`${base}/api/webhooks/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inbox-webhook-secret": secret,
        },
        body: JSON.stringify(payload),
      });
      apiStatus = res.status;
    }

    // The API route is not in production yet (404). Keep the message so the
    // test reply is not bounced and can be read back. A real 4xx from a
    // deployed handler (unknown local part) is still accepted: the API drops it.
    if (env.INBOX) {
      const key = `mail:${Date.now()}:${local}`;
      await env.INBOX.put(key, JSON.stringify({ ...payload, local, apiStatus }), {
        expirationTtl: 60 * 60 * 24 * 14,
      });
    }
  },
};

function localPart(to, host) {
  const match = String(to).toLowerCase().match(/^([^@\s]+)@([^>\s]+)/);
  if (!match) return null;
  if (match[2].replace(/>$/, "") !== host) return null;
  const local = match[1];
  if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(local)) return null;
  return local;
}

function plainFromRaw(raw) {
  const split = raw.split(/\r?\n\r?\n/);
  if (split.length < 2) return "";
  return split.slice(1).join("\n").replace(/\s+/g, " ").trim();
}
