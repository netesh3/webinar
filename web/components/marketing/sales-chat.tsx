"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { salesChat } from "@/lib/api";
import type { SalesChat, SalesMessage, SalesStatus } from "@/lib/api-types";
import { ApiError } from "@/lib/http";
import "./sales-chat.css";

/* The sales chat on the marketing pages.
 *
 * An assistant answers first, from the real price list (internal/sales on the API);
 * a person takes over when it can't answer or the visitor asks. See api/sales.go.
 *
 * - The closed widget is a "Talk to Agent" pill. TEASER_MS after every page load a small
 *   popup greets the visitor above it; "Start chat" opens the panel, × dismisses it until
 *   the next load. Nothing about it is remembered.
 * - /#chat opens it: that is the link in the reply email.
 * - The conversation is created on the first message, not on open, so an auto-opened
 *   chat nobody types into costs nothing and never reaches the admin inbox.
 * - Realtime is polling, fast only while a person is involved.
 */

// The teaser popup appears eight seconds after the page loads: long enough for the
// visitor to look at the page first, soon enough to greet them.
const TEASER_MS = 8000;
const TEASER_TEXT = "👋 Hi there! Have a question? Our agent is here to help you right now.";
const TOKEN_KEY = "webcast.salesChat.token";

// Mirrors sales.Greeting on the API; the server's copy replaces it once the chat starts.
const GREETING =
  "Hi 👋 I'm Webinar Liv's AI agent. Planning webinars for your coaching or teaching business? Ask me anything — plans, WhatsApp reminders, how attendees join.";

const STARTERS: { label: string; text: string }[] = [
  { label: "See plans & prices", text: "What plans do you have, and what do they cost?" },
  { label: "How do reminders work?", text: "How do WhatsApp reminders work?" },
  { label: "Which plan for 250 students?", text: "I have about 250 students per webinar. Which plan should I pick?" },
];

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode: the chat still works for this page view.
  }
}

type Local = SalesMessage & { pending?: boolean };

export function SalesChatWidget() {
  const [open, setOpen] = useState(false);
  const [teaser, setTeaser] = useState(false);
  // Read once on the client. Nothing rendered depends on it, so the server's null
  // and the client's saved token cannot disagree on screen.
  const [token, setToken] = useState<string | null>(() => (typeof window === "undefined" ? null : read(TOKEN_KEY)));
  const [messages, setMessages] = useState<Local[]>([]);
  const [status, setStatus] = useState<SalesStatus>("ai");
  const [teamOnline, setTeamOnline] = useState(false);
  const [agent, setAgent] = useState("");
  const [email, setEmail] = useState("");
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [contact, setContact] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);
  const lastId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef(open);
  const tempSeq = useRef(0);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const show = useCallback(() => {
    setOpen(true);
    setTeaser(false);
    setUnread(0);
  }, []);

  const apply = useCallback((chat: SalesChat, opts?: { replace?: boolean }) => {
    setStatus(chat.status);
    setTeamOnline(chat.teamOnline);
    setAgent(chat.agentName ?? "");
    setEmail(chat.email ?? "");
    const fresh = chat.messages ?? [];
    if (fresh.length) lastId.current = fresh[fresh.length - 1].id;
    setMessages((prev) => {
      const base = opts?.replace ? [] : prev.filter((m) => !m.pending);
      const seen = new Set(base.map((m) => m.id));
      return [...base, ...fresh.filter((m) => !seen.has(m.id))];
    });
    if (!openRef.current) {
      const fromTeam = fresh.filter((m) => m.role === "admin").length;
      if (fromTeam) setUnread((n) => n + fromTeam);
    }
  }, []);

  // Restore a conversation from an earlier visit.
  const restored = useRef(false);
  useEffect(() => {
    if (!token || restored.current) return;
    restored.current = true;
    salesChat
      .poll(token, 0)
      .then((chat) => apply(chat, { replace: true }))
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
          write(TOKEN_KEY, null);
          setToken(null);
        }
      });
  }, [token, apply]);

  // Teaser popup on every page load, or the panel straight away for /#chat.
  useEffect(() => {
    const linked = window.location.hash === "#chat";
    const t = linked
      ? window.setTimeout(show, 0)
      : window.setTimeout(() => {
          if (!openRef.current) setTeaser(true);
        }, TEASER_MS);
    const onHash = () => {
      if (window.location.hash === "#chat") show();
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("hashchange", onHash);
    };
  }, [show]);

  // Poll: fast while a person is involved, slow otherwise, and only for a real chat.
  useEffect(() => {
    if (!token) return;
    const human = status === "waiting" || status === "human";
    const every = open ? (human ? 3000 : 10000) : human ? 15000 : 0;
    if (!every) return;
    const id = window.setInterval(() => {
      salesChat.poll(token, lastId.current).then((c) => apply(c)).catch(() => {});
    }, every);
    return () => window.clearInterval(id);
  }, [token, status, open, apply]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, messages, thinking]);

  async function ensureToken(): Promise<string> {
    if (token) return token;
    const chat = await salesChat.start(window.location.pathname);
    const t = chat.token!;
    restored.current = true; // this chat is already on screen; nothing to restore
    write(TOKEN_KEY, t);
    setToken(t);
    apply(chat, { replace: true });
    return t;
  }

  async function send(text: string) {
    const body = text.trim();
    if (!body || thinking) return;
    setError(null);
    setInput("");
    tempSeq.current -= 1;
    const temp: Local = { id: tempSeq.current, role: "visitor", body, createdAt: "", pending: true };
    setMessages((prev) => [...prev, temp]);
    setThinking(status === "ai");
    try {
      const t = await ensureToken();
      apply(await salesChat.say(t, lastId.current, body));
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== temp.id));
      setInput(body);
      setError(err instanceof ApiError ? err.message : "Couldn't send. Check your connection and try again.");
    } finally {
      setThinking(false);
    }
  }

  async function askPerson() {
    setError(null);
    setThinking(true);
    try {
      const t = await ensureToken();
      apply(await salesChat.handoff(t, lastId.current));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the team. Try again.");
    } finally {
      setThinking(false);
    }
  }

  async function saveContact(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setContactError(null);
    try {
      apply(await salesChat.contact(token, lastId.current, contact.trim()));
    } catch (err) {
      setContactError(err instanceof ApiError ? (err.fields?.email ?? err.message) : "Couldn't save. Try again.");
    }
  }

  function close() {
    setOpen(false);
    if (window.location.hash === "#chat") history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const shown: Local[] = messages.length
    ? messages
    : [{ id: 0, role: "ai", body: GREETING, createdAt: "" }];
  const visitorWrote = messages.some((m) => m.role === "visitor");
  const human = status === "waiting" || status === "human";

  // "AI Agent" until a person joins, then that person: "Neeraj · Agent".
  const title = status === "human" && agent ? `${agent} · Agent` : "AI Agent";
  const sub =
    status === "human"
      ? "Team member · here now"
      : status === "waiting"
        ? teamOnline
          ? "Getting a person · usually a few minutes"
          : "The team is away · we'll reply by email"
        : "Online · replies instantly";

  if (!open) {
    return (
      <>
        {teaser && (
          <div className="sc-teaser" role="dialog" aria-label="Talk to Agent">
            <div className="sc-teaser-head">
              <span className="sc-teaser-av" aria-hidden>
                <svg viewBox="0 0 24 24">
                  <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z" />
                </svg>
                <i />
              </span>
              <div className="sc-teaser-title">
                <b>Talk to Agent</b>
                <small>● Online · replies instantly</small>
              </div>
              <button type="button" className="sc-teaser-x" aria-label="Dismiss" onClick={() => setTeaser(false)}>
                ✕
              </button>
            </div>
            <p className="sc-teaser-msg">{TEASER_TEXT}</p>
            <button type="button" className="sc-teaser-go" onClick={show}>
              Start chat
            </button>
          </div>
        )}
        <button type="button" className="sc-bubble" onClick={show}>
          <span className="sc-bubble-icon" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z" />
            </svg>
          </span>
          Talk to Agent
          {unread > 0 && <span className="sc-unread">{unread}</span>}
        </button>
      </>
    );
  }

  return (
    <section className="sc-panel" role="dialog" aria-label="Chat with Webinar Liv">
      <header className="sc-head">
        <span className={status === "human" ? "sc-av sc-av-person" : "sc-av"} aria-hidden>
          {status === "human" && agent ? agent.slice(0, 1).toUpperCase() : "AI"}
        </span>
        <div className="sc-title">
          <b>{title}</b>
          <small>
            <i className={status === "waiting" && !teamOnline ? "sc-dot sc-dot-away" : status === "waiting" ? "sc-dot sc-dot-wait" : "sc-dot"} />
            {sub}
          </small>
        </div>
        <button type="button" className="sc-x" aria-label="Close chat" onClick={close}>
          ✕
        </button>
      </header>

      <div className="sc-body" ref={listRef} aria-live="polite">
        {shown.map((m) =>
          m.role === "system" ? (
            <p key={m.id} className="sc-sys">
              {m.body}
            </p>
          ) : (
            <div key={m.id} className={`sc-row sc-${m.role}`}>
              {m.role === "admin" && m.authorName && <span className="sc-who">{m.authorName}</span>}
              <p className={m.pending ? "sc-msg sc-pending" : "sc-msg"}>{m.body}</p>
            </div>
          ),
        )}
        {thinking && (
          <div className="sc-row sc-ai">
            <p className="sc-msg sc-typing" aria-label="AI Agent is typing">
              <i />
              <i />
              <i />
            </p>
          </div>
        )}
        {!visitorWrote && !thinking && status === "ai" && (
          <div className="sc-chips">
            {STARTERS.map((s) => (
              <button key={s.label} type="button" onClick={() => void send(s.text)}>
                {s.label}
              </button>
            ))}
            <button type="button" onClick={() => void askPerson()}>
              Talk to a person
            </button>
          </div>
        )}
        {status === "waiting" && !email && (
          <form className="sc-card" onSubmit={saveContact}>
            <b>In case we miss you, where should we reply?</b>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              aria-invalid={!!contactError}
              aria-label="Your email"
            />
            {contactError && <em role="alert">{contactError}</em>}
            <button type="submit">Email me the reply</button>
          </form>
        )}
      </div>

      {error && (
        <p className="sc-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="sc-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          maxLength={1000}
          placeholder={status === "human" && agent ? `Reply to ${agent}…` : human ? "Add details while you wait…" : "Ask about plans, features…"}
          aria-label="Your message"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button type="submit" aria-label="Send" disabled={!input.trim() || thinking}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
      <p className="sc-foot">
        {status === "ai" && visitorWrote ? (
          <>
            AI answers can be wrong.{" "}
            <button type="button" onClick={() => void askPerson()}>
              Talk to a person
            </button>
          </>
        ) : (
          "A person from the team can step in any time."
        )}
      </p>
    </section>
  );
}
