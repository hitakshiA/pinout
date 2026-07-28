// Minimal session persistence. Sessions were in-memory only, so a restart
// stranded any open session — the ledger survived but the credits did not,
// which in a paid system means the buyer loses what it paid for.
// Append-only JSONL: crash-safe enough for a single-node resource server.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";

const FILE = join(ROOT, "sessions.jsonl");

export function saveSession(s) {
  appendFileSync(FILE, JSON.stringify({
    id: s.id, payer: s.payer, state: s.state,
    pricePerEvent: s.pricePerEvent, credits: s.credits, burned: s.burned,
    paidTinybar: s.paidTinybar, fundingTxIds: s.fundingTxIds,
    lastCheckpointAt: s.lastCheckpointAt,
    checkpoints: s.checkpoints.map((c) => ({ seq: c.sequenceNumber, tx: c.txId })),
    settlementTx: s.settlement?.txId ?? null,
    refundTx: s.refund?.txId ?? null,
    at: new Date().toISOString(),
  }) + "\n");
}

/** Last-write-wins replay of the append-only log. */
export function loadSessions() {
  if (!existsSync(FILE)) return new Map();
  const out = new Map();
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); out.set(r.id, r); } catch { /* skip torn line */ }
  }
  return out;
}
