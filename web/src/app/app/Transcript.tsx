"use client";

import { useEffect, useRef, useState } from "react";
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

/** "ran code twice, looked at the output" */
export function toolLine(names: string[]) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts.entries()].map(([n, c]) => {
    const said = SAID[n] ?? `used ${n}`;
    if (c === 1) return said;
    if (c === 2) return `${said} twice`;
    return `${said} ${c} times`;
  });
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Light markdown: bold, inline code, links. Enough for what an agent writes. */
function rich(text: string) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else out.push(
      <a key={k++} href={tok} target="_blank" rel="noreferrer">{tok}</a>
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
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
  return (
    <div className="ws-agent">
      {rich(text)}
      {streaming && <span className="ws-caret" />}
    </div>
  );
}

export function ToolLine({ names }: { names: string[] }) {
  if (!names.length) return null;
  return <div className="ws-tools ws-in">{toolLine(names)}</div>;
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
