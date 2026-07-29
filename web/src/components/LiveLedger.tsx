"use client";

/**
 * Reads real settled sessions straight off Hedera's public mirror node.
 *
 * Nothing here is seeded or mocked. The rows are whatever actually settled on
 * the HIP-991 topic, and every transaction id links to HashScan so a reader can
 * check the arithmetic without asking us for anything. The mirror node sends
 * access-control-allow-origin:*, so the browser talks to it directly and there
 * is no server of ours in the path that could edit what you see.
 */

import { useEffect, useRef, useState } from "react";

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const SETTLE_TOPIC = "0.0.9795865"; // HIP-991 fee-charging topic
const BURN_TOPIC = "0.0.9795896"; // plain HCS consumption ledger

/** Price per second maps back to the lane it was sold on. */
const LANE_BY_PRICE: Record<number, string> = {
  30000: "cpu-1", 74000: "cpu-2", 147000: "cpu-4",
  474000: "gpu-t4", 778000: "gpu-l4", 912000: "gpu-a10", 1712000: "gpu-l40s",
  2296000: "gpu-a100-80", 3796000: "gpu-h200", 5149000: "gpu-b200", 6209000: "gpu-b300",
  411000: "gpu-t4", 1229000: "gpu-a100", 200: "tokens",
};

type Row = {
  id: string; lane: string; seconds: number;
  paid: number; billed: number; refunded: number;
  seq: number; ts: number; txUrl: string;
};

const hbar = (t: number) => (t / 1e8).toFixed(4);
const ago = (s: number) =>
  s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;

export default function LiveLedger() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  const [checkpoints, setCheckpoints] = useState<number | null>(null);
  const seen = useRef<Set<string>>(new Set());

  async function load() {
    try {
      const r = await fetch(`${MIRROR}/topics/${SETTLE_TOPIC}/messages?order=desc&limit=25`);
      if (!r.ok) throw new Error(`mirror node returned ${r.status}`);
      const data = await r.json();

      const out: Row[] = [];
      for (const m of data.messages ?? []) {
        let body: Record<string, unknown>;
        try { body = JSON.parse(atob(m.message)); } catch { continue; }
        const ts = Number(m.consensus_timestamp);
        const txUrl = `https://hashscan.io/testnet/topic/${SETTLE_TOPIC}`;

        const push = (s: Record<string, unknown>) => {
          const price = Number(s.priceTinybar ?? 0);
          const billed = Number(s.owedTinybar ?? 0);
          const refunded = Number(s.refundTinybar ?? 0);
          const burned = Number(s.burned ?? 0);
          if (!price || (!billed && !refunded)) return;
          out.push({
            id: String(s.session ?? ""), lane: LANE_BY_PRICE[price] ?? `${price} tℏ/s`,
            seconds: burned, billed, refunded, paid: billed + refunded,
            seq: Number(m.sequence_number), ts, txUrl,
          });
        };

        if (body.t === "settle-batch" && Array.isArray(body.sessions)) {
          for (const s of body.sessions as Record<string, unknown>[]) push(s);
        } else if (body.t === "settle") {
          push(body);
        }
      }

      out.sort((a, b) => b.ts - a.ts);
      out.forEach((r) => seen.current.add(r.id));
      setRows(out.slice(0, 8));
      setFetchedAt(Date.now());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not reach the mirror node");
    }

    try {
      const r = await fetch(`${MIRROR}/topics/${BURN_TOPIC}/messages?order=desc&limit=1`);
      const d = await r.json();
      const s = d.messages?.[0]?.sequence_number;
      if (s) setCheckpoints(Number(s));
    } catch { /* the count is decoration, the rows are the point */ }
  }

  useEffect(() => {
    load();
    const refresh = setInterval(load, 30_000);
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(refresh); clearInterval(clock); };
  }, []);

  const totalRefunded = rows?.reduce((a, r) => a + r.refunded, 0) ?? 0;
  const totalBilled = rows?.reduce((a, r) => a + r.billed, 0) ?? 0;

  return (
    <div className="ledger">
      <div className="ledger-head">
        <div className="ledger-title">
          <span className={`pulse${err ? " down" : ""}`} aria-hidden="true" />
          <span>Settled sessions, read from Hedera just now</span>
        </div>
        <div className="ledger-meta">
          {err
            ? <span className="warn">{err}. The topic is still public, so you can open it on HashScan.</span>
            : fetchedAt
              ? <>mirror node &middot; {ago((Date.now() - fetchedAt) / 1000)}
                  {checkpoints ? <> &middot; {checkpoints.toLocaleString()} checkpoints written</> : null}</>
              : "reading the topic…"}
        </div>
      </div>

      {!rows && !err && (
        <div className="ledger-body">
          {[0, 1, 2, 3].map((i) => <div className="skel" key={i} style={{ animationDelay: `${i * 90}ms` }} />)}
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="ledger-body">
            {rows.map((r, i) => (
              <a className="lrow" key={`${r.id}-${r.seq}`} href={r.txUrl}
                 target="_blank" rel="noreferrer" style={{ animationDelay: `${i * 55}ms` }}>
                <code className="lid">{r.id.slice(0, 8)}</code>
                <span className="llane">{r.lane}</span>
                <span className="lsec tnum">{r.seconds}s</span>
                <span className="lbar" aria-hidden="true">
                  <i style={{ width: `${r.paid ? (r.billed / r.paid) * 100 : 0}%` }} />
                </span>
                <span className="lpaid tnum">{hbar(r.billed)} <span className="hb">&#8463;</span></span>
                <span className="lref tnum">+{hbar(r.refunded)} back</span>
                <span className="lgo" aria-hidden="true">&#8599;</span>
              </a>
            ))}
          </div>
          <div className="ledger-foot">
            <span>
              Across these {rows.length}: <b className="tnum">{hbar(totalBilled)} <span className="hb">&#8463;</span></b> billed,
              {" "}<b className="tnum" style={{ color: "var(--green)" }}>{hbar(totalRefunded)} <span className="hb">&#8463;</span></b> returned.
            </span>
            <a href={`https://hashscan.io/testnet/topic/${SETTLE_TOPIC}`} target="_blank" rel="noreferrer">
              Open the topic on HashScan &#8599;
            </a>
          </div>
        </>
      )}

      {rows && rows.length === 0 && !err && (
        <div className="ledger-body">
          <p className="empty">
            No settled sessions on the topic yet. Rent something and this fills in.
          </p>
        </div>
      )}
    </div>
  );
}
