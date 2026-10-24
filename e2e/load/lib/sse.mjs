/* A text/event-stream reader over a fetch body: calls onEvent(name, data) per event and
 * onComment() per ": ping". Resolves when the stream ends (or the signal aborts). */
export async function readSSE(res, { onEvent, onComment }) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let name = "message";
  let data = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) onEvent?.(name, data.join("\n"));
          name = "message";
          data = [];
        } else if (line.startsWith(":")) onComment?.(line.slice(1).trim());
        else if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        // retry:/id: are not needed by the load model.
      }
    }
  } catch {
    // Aborted or reset: the caller decides whether to reconnect.
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return bytes;
}

/** Parses SSE text (for tests): [[name, data], ...]. */
export function parseSSEText(text) {
  const out = [];
  const enc = new TextEncoder().encode(text);
  const res = {
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { value: enc, done: false })),
          releaseLock() {},
        };
      },
    },
  };
  return readSSE(res, { onEvent: (n, d) => out.push([n, d]) }).then(() => out);
}
