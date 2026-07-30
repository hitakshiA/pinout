"use client";

import { useEffect, useRef, useState, createContext, useContext, useMemo } from "react";
import { hbar, type RunEvent } from "./api";

/**
 * The transcript.
 *
 * Two decisions carry it. Agent prose is serif and sits on the background with
 * no bubble, so the thing reads as a document rather than a chat. And tool
 * activity is one dim line under the prose it belongs to, never a card: a run
 * makes forty calls and cards would bury the writing under its own scaffolding.
 */

/* Past-tense summaries, the way a person would say it afterwards. The map
 * exists because "called rent_machine" is what happened and "Rented a machine"
 * is what it means, and the transcript is for the human. */
const SAID: Record<string, string> = {
  discover: "read the catalogue",
  list_inputs: "looked at your files",
  peek_input: "read a file",
  wallet_balance: "checked its balance",
  request_hbar: "asked for funds",
  rent_machine: "rented a machine",
  open_session: "opened a session",
  stage_input: "staged a file",
  exec: "ran code",
  look_at: "looked at the output",
  deliver_file: "delivered a file",
  download_file: "downloaded a file",
  list_files: "listed files",
  upload_file: "uploaded a file",
  release_machine: "released the machine",
  close_session: "closed the session",
  top_up: "bought more seconds",
  spend_report: "checked the spend",
  verify_session: "verified the bill",
  run_compute: "ran a job",
};

/* Present tense until it lands. "Rented a machine" written the instant the call
 * is issued claims something that has not happened yet, and a rental can fail. */
const DOING: Record<string, string> = {
  discover: "reading the catalogue",
  list_inputs: "looking at your files",
  peek_input: "reading a file",
  wallet_balance: "checking its balance",
  request_hbar: "asking for funds",
  rent_machine: "renting a machine",
  open_session: "opening a session",
  stage_input: "staging a file",
  exec: "running code",
  look_at: "looking at the output",
  deliver_file: "delivering a file",
  download_file: "downloading a file",
  list_files: "listing files",
  upload_file: "uploading a file",
  release_machine: "releasing the machine",
  close_session: "closing the session",
  top_up: "buying more seconds",
  spend_report: "checking the spend",
  verify_session: "verifying the bill",
  run_compute: "running a job",
};

export type ToolMark = { name: string; done?: boolean; ok?: boolean };

/** "ran code twice, looked at the output" — or "running code" while it runs. */
export function toolLine(marks: ToolMark[]) {
  const counts = new Map<string, { n: number; pending: number; failed: number }>();
  for (const m of marks) {
    const e = counts.get(m.name) ?? { n: 0, pending: 0, failed: 0 };
    e.n++;
    if (!m.done) e.pending++;
    else if (m.ok === false) e.failed++;
    counts.set(m.name, e);
  }
  const parts = [...counts.entries()].map(([n, e]) => {
    const pending = e.pending > 0;
    const said = pending ? (DOING[n] ?? `using ${n}`) : (SAID[n] ?? `used ${n}`);
    const times = e.n === 1 ? "" : e.n === 2 ? " twice" : ` ${e.n} times`;
    // a failure is the one thing that must not be summarised away
    return e.failed ? `${said}${times} (${e.failed} failed)` : `${said}${times}`;
  });
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Files the agent names in its answer, made openable where it names them.
 *
 * "I delivered person_gradient.mp4" is a dead end otherwise: the file exists,
 * it is in the panel, and the reader has to go hunting for it in a list to see
 * the thing the sentence is about. The names are known, so they become the
 * link.
 */
const FileRefs = createContext<{
  names: string[];
  onOpen: (name: string) => void;
} | null>(null);

export function FileRefProvider({
  names, onOpen, children,
}: { names: string[]; onOpen: (n: string) => void; children: React.ReactNode }) {
  const value = useMemo(() => ({ names, onOpen }), [names.join("\u0000"), onOpen]);
  return <FileRefs.Provider value={value}>{children}</FileRefs.Provider>;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Refs = { names: string[]; onOpen: (n: string) => void } | null;

/** Split a run of plain text on any known filename. Pure: the context is read
    once, in the component, because this runs inside loops. */
function withFileRefs(text: string, key: number, ctx: Refs): React.ReactNode[] {
  if (!ctx?.names.length) return [text];
  // longest first, so report_final.csv is not eaten by report.csv
  const names = [...ctx.names].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${names.map(esc).join("|")})`, "g");
  const out: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = key;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const name = m[0];
    out.push(
      <button key={`f${k++}`} className="ws-fileref" onClick={() => ctx.onOpen(name)}
              title={`Open ${name}`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.1" aria-hidden>
          <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
        </svg>
        {name}
      </button>
    );
    last = m.index + name.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Inline: bold, code, links, and any file this chat holds. */
function inline(text: string, key = 0, ctx: Refs = null) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let last = 0, m: RegExpExecArray | null, k = key;
  const plain = (t: string) => out.push(...withFileRefs(t, k += 100, ctx));
  while ((m = re.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index));
    const tok = m[0];
    // a filename in backticks is still a filename, and is usually how it is written
    if (tok.startsWith("**")) out.push(<strong key={k++}>{withFileRefs(tok.slice(2, -2), k += 100, ctx)}</strong>);
    else if (tok.startsWith("`")) {
      const body = tok.slice(1, -1);
      const refs = withFileRefs(body, k += 100, ctx);
      out.push(refs.length === 1 && typeof refs[0] === "string"
        ? <code key={k++}>{body}</code>
        : <span key={k++}>{refs}</span>);
    }
    else out.push(<a key={k++} href={tok} target="_blank" rel="noreferrer">{tok}</a>);
    last = m.index + tok.length;
  }
  if (last < text.length) plain(text.slice(last));
  return out;
}

/**
 * Block-level markdown, because agents write headings and lists and leaving
 * "### CPU Lanes" on the page as literal hashes is worse than not styling it
 * at all. Deliberately small: headings, bullets, rules, paragraphs. Anything
 * more and this becomes a markdown library nobody asked for.
 */
function rich(text: string, ctx: Refs = null) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(<p key={`p${out.length}`} className="ws-p">{inline(para.join("\n"), 0, ctx)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push(
      <ul key={`u${out.length}`} className="ws-ul">
        {list.map((li, i) => <li key={i}>{inline(li, 0, ctx)}</li>)}
      </ul>
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      out.push(<div key={`h${out.length}`} className="ws-h" data-l={h[1].length}>{inline(h[2], 0, ctx)}</div>);
    } else if (li) {
      flushPara();
      list.push(li[1]);
    } else if (/^\s*(---+|===+)\s*$/.test(line)) {
      flushPara(); flushList();
      out.push(<hr key={`r${out.length}`} className="ws-hr" />);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out;
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</>;
}

export function Working({ what, since }: { what: string; since: number }) {
  return (
    <div className="ws-working ws-in">
      <span className="ws-spark" />
      <span>{what}… · <Elapsed since={since} /></span>
    </div>
  );
}

/** Agent prose, typed rather than pasted. */
export function AgentText({ text, streaming }: { text: string; streaming?: boolean }) {
  const ctx = useContext(FileRefs);   // read once, here, not inside the loops
  return (
    <div className="ws-agent">
      {rich(text, ctx)}
      {streaming && <span className="ws-caret" />}
    </div>
  );
}

export function ToolLine({ marks }: { marks: ToolMark[] }) {
  if (!marks.length) return null;
  const pending = marks.some((m) => !m.done);
  const failed = marks.some((m) => m.done && m.ok === false);
  return (
    <div className="ws-tools ws-in" data-pending={pending} data-failed={failed}>
      {toolLine(marks)}
    </div>
  );
}

/* ---------------- the ask ---------------- */

export function FundingAsk({
  ev, onDecide, busy,
}: {
  ev: RunEvent;
  onDecide: (verdict: string, feedback?: string) => void;
  busy: boolean;
}) {
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");

  const req = Number(ev.requestTinybar ?? 0);
  const covers = ev.secondsCovered as number | null;
  const transfer = Number(ev.transferTinybar ?? req);

  return (
    <div className="ws-card ws-ask ws-in">
      <div className="ws-card-sub">The agent wants to spend</div>
      <div className="ws-ask-amount">{hbar(req)}</div>

      <dl className="ws-ask-grid">
        <dt>machine</dt>
        <dd>
          {String(ev.lane ?? "?")}
          {ev.laneTinybarPerSecond ? ` · ${Number(ev.laneTinybarPerSecond).toLocaleString()} tinybar/s` : ""}
        </dd>
        <dt>for</dt>
        <dd>
          {String(ev.estimatedSeconds ?? "?")}s
          {covers != null ? ` · this buys about ${covers}s` : ""}
        </dd>
        {transfer > req && (
          <>
            <dt>you send</dt>
            <dd>{hbar(transfer)} · Hedera&rsquo;s minimum to open an account, the rest comes back</dd>
          </>
        )}
        <dt>plan</dt>
        <dd>{String(ev.plan ?? "")}</dd>
        <dt>because</dt>
        <dd>{String(ev.reasoning ?? "")}</dd>
      </dl>

      {/* arithmetic the human would otherwise have to do */}
      {ev.shortOfClaim ? <div className="ws-warnline">⚠ {String(ev.shortOfClaim)}</div> : null}
      {ev.overCeiling ? <div className="ws-warnline">⚠ above the ceiling you set</div> : null}

      {revising ? (
        <>
          <input
            className="ws-field" autoFocus placeholder="what should it do differently?"
            value={note} onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) onDecide("revise", note.trim()); }}
          />
          <div className="ws-btns" style={{ marginTop: 10 }}>
            <button className="ws-btn ws-btn-primary" disabled={!note.trim() || busy}
                    onClick={() => onDecide("revise", note.trim())}>Send it back</button>
            <button className="ws-btn" onClick={() => setRevising(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="ws-btns">
          <button className="ws-btn ws-btn-primary" disabled={busy}
                  onClick={() => onDecide("approve")}>Approve</button>
          <button className="ws-btn" disabled={busy} onClick={() => setRevising(true)}>
            Change the plan
          </button>
          <button className="ws-btn" disabled={busy} onClick={() => onDecide("deny")}>Deny</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- artifacts ---------------- */

export function ArtifactCard({
  name, bytes, kind, onOpen,
}: { name: string; bytes: number; kind: string; onOpen: () => void }) {
  const size = bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  return (
    <div className="ws-artifact ws-in" onClick={onOpen} role="button" tabIndex={0}
         onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="ws-artifact-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ws-artifact-name">{name}</div>
        <div className="ws-artifact-meta">{kind} · {size}</div>
      </div>
      <span className="ws-link">Open</span>
    </div>
  );
}

/** Scrolls itself, but stops if the reader has scrolled up to read something. */
export function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}
