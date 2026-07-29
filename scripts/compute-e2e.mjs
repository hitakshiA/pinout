// Metered compute, end to end: x402 payment -> real sandbox -> per-second burn
// -> HCS checkpoints -> settlement anchor -> refund of unheld seconds -> verify.
//
//   node scripts/compute-e2e.mjs [lane]
import { start } from "../src/server.mjs";
import { PinoutClient } from "../src/client.mjs";
import { jobResult } from "../providers/compute.mjs";
import { env, hashscan } from "../src/config.mjs";
import { writeFileSync } from "node:fs";

const LANE = process.argv[2] ?? "cpu-small";
const CODE = `
import time, math
print("provisioned; starting work", flush=True)
primes=[]
n=2
t0=time.time()
while time.time()-t0 < 8:
    if all(n%p for p in primes if p*p<=n): primes.append(n)
    n+=1
print(f"RESULT: found {len(primes)} primes below {n}", flush=True)
`;

const server = await start(4021);
await new Promise((r) => setTimeout(r, 400));
const BASE = process.env.PINOUT_URL ?? "http://localhost:4021";
const client = new PinoutClient({ base: BASE });

console.log(`\n=== 1. buy compute credits (real x402) ===`);
// Compute is sold ONLY through /compute/<lane>, which commits the lane's price
// inside the 402 the buyer signs. Opening on the generic /session route bought
// generic credits with no lane, and the compute provider then rejected the
// stream with "unknown lane llm".
const s = await client.openComputeSession(LANE);
console.log(`session   : ${s.sessionId}`);
console.log(`credits   : ${s.credits} seconds @ ${s.pricePerSecondTinybar} tinybar/s on ${s.lane}`);
console.log(`payment   : ${s.paymentTxUrl}`);

console.log(`\n=== 2. run code on ${LANE}, metered per second ===`);
const q = new URLSearchParams({
  // No lane here on purpose: the server takes the lane from the SESSION, so a
  // caller cannot pay cpu-small prices and ask for a GPU.
  n: "60", provider: "compute",
  code: Buffer.from(CODE, "utf8").toString("base64"),
});
const res = await fetch(`${BASE}/session/${s.sessionId}/stream?${q}`,
  { headers: { Authorization: `Bearer ${s.sessionSecret}` } });
const reader = res.body.getReader(); const dec = new TextDecoder();
let buf = "", ev = null, secs = 0; const received = [];
let firstFrame = null, lastFrame = null;   // for the reconciliation below
while (true) {
  const { done, value } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n"); buf = parts.pop();
  for (const chunk of parts) for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) ev = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const d = JSON.parse(line.slice(5).trim());
      if (ev === "data") {
        secs++; received.push(d.id);
        firstFrame ??= d; lastFrame = d;
        const cold = d.coldStartMs !== undefined ? ` cold=${d.coldStartMs}ms` : "";
        console.log(`  sec ${String(d.i).padStart(2)}${cold}${d.stdout ? "  | " + d.stdout.replace(/\n/g, " / ") : ""}`);
      } else if (ev === "Checkpoint") console.log(`  ↳ HCS checkpoint seq=${d.seq} burned=${d.burned}`);
    }
  }
}
console.log(`seconds held (credits burned): ${secs}`);

console.log(`\n=== 3. close: anchor -> refund unheld seconds ===`);
const out = await client.close(s.sessionId, "client-disconnect");
console.log(`consumed  : ${out.consumedAmount} tinybar (${secs}s)`);
const rate = s.pricePerSecondTinybar;
console.log(`refunded  : ${out.refundAmount} tinybar (${Number(out.refundAmount) / rate}s unheld)`);
console.log(`checks    : ${Number(out.consumedAmount) + Number(out.refundAmount)} tinybar back out of ` +
            `${s.credits * rate} paid in -> ${Number(out.consumedAmount) + Number(out.refundAmount) === s.credits * rate ? "balances" : "MISMATCH"}`);
console.log(`anchor    : ${out.settlementTxUrl}`);
console.log(`refund tx : ${out.refundTxUrl}`);

console.log(`\n=== 4. provider-side truth (reconciliation) ===`);
// The last data frame carries the meter's own elapsed clock, which is what the
// bill is derived from. Comparing it to the billed count is the reconciliation:
// billed seconds must never exceed wall-clock seconds actually held.
const heldMs = lastFrame?.elapsedMs ?? null;
console.log(`machine held    : ${heldMs ? (heldMs / 1000).toFixed(2) : "?"}s wall-clock`);
console.log(`billed          : ${secs}s  -> ${heldMs && secs <= Math.ceil(heldMs / 1000) ? "never billed beyond time held" : "CHECK"}`);
console.log(`cold start      : ${firstFrame?.coldStartMs ?? "?"}ms (inside second 0, not billed separately)`);
if (lastFrame?.metrics) console.log(`provider metrics: ${JSON.stringify(lastFrame.metrics)}`);

writeFileSync("last-session.json", JSON.stringify({ sessionId: s.sessionId, receivedEventIds: received }, null, 2));
console.log(`\nverify: node scripts/verify.mjs ${s.sessionId}`);
server.close(); process.exit(0);
