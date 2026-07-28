// End-to-end: 402 -> pay -> stream -> checkpoint -> mid-stream top-up ->
// settlement anchor -> refund. Every on-chain step prints a HashScan link.
//
//   node scripts/e2e.mjs
//   node scripts/e2e.mjs --cheat 500     (seller over-bills; verifier should catch it)
import { start } from "../src/server.mjs";
import { PinoutClient } from "../src/client.mjs";
import { env, hashscan } from "../src/config.mjs";
import { writeFileSync } from "node:fs";

const cheatIdx = process.argv.indexOf("--cheat");
const CHEAT = cheatIdx > -1 ? Number(process.argv[cheatIdx + 1] ?? 500) : 0;
const PORT = 4021;

const server = await start(PORT);
await new Promise((r) => setTimeout(r, 400));

const client = new PinoutClient({ base: `http://localhost:${PORT}` });

console.log("\n=== 1. open session (real HTTP 402) ===");
const s = await client.openSession(CHEAT ? `?cheat=${CHEAT}` : "");
console.log(`session      : ${s.sessionId}`);
console.log(`credits      : ${s.credits} events @ ${s.pricePerEventTinybar} tinybar`);
console.log(`unit         : ${s.unit}   refundPolicy: ${s.refundPolicy}`);
console.log(`payment tx   : ${s.paymentTxUrl}`);
if (CHEAT) console.log(`!! CHEAT MODE: ledger will over-report by ${CHEAT} events`);

console.log("\n=== 2. stream, burning one credit per token ===");
let topUps = 0, lastUpdate = null;
const { received, terminated } = await client.stream(s.sessionId, {
  n: 2600,
  onCheckpoint: (cp) =>
    console.log(`   checkpoint seq=${cp.seq} burned=${cp.burned}  ${cp.txUrl}`),
  onLow: async (u) => {
    if (topUps >= 1 || u.remainingUnits > 400) return;
    lastUpdate = u;
    console.log(`   low balance (${u.remainingUnits} left) -> topping up mid-stream…`);
    const t = await client.topUp(s.sessionId);
    topUps++;
    console.log(`   +${t.credited} credits, now ${t.credits}. socket never dropped.`);
    console.log(`   top-up tx  : ${t.paymentTxUrl}`);
  },
});
console.log(`events received: ${received.length}`);
if (terminated) console.log(`terminated   : ${terminated.cause}`);

console.log("\n=== 3. close: settlement anchor THEN refund ===");
const out = await client.close(s.sessionId, "client-disconnect");
console.log(`consumed     : ${out.consumedAmount} tinybar`);
console.log(`refund       : ${out.refundAmount} tinybar`);
console.log(`burn ckpts   : ${out.burnCheckpoints}`);
console.log(`settlement tx: ${out.settlementTxUrl}`);
console.log(`  -> HIP-991 anchor fee (fixed collector): ${out.settlementPaidToBuyerTinybar} tinybar`);
console.log(`refund tx    : ${out.refundTxUrl ?? "(nothing unused)"}`);

writeFileSync("last-session.json", JSON.stringify({
  sessionId: s.sessionId,
  receivedEventIds: received,
  paymentTx: s.paymentTx,
  cheat: CHEAT,
}, null, 2));
console.log("\nclient's own record written to last-session.json");
console.log(`burn topic   : ${hashscan.topic(env.BURN_TOPIC_ID)}`);
console.log(`settle topic : ${hashscan.topic(env.TOPIC_ID)}`);
console.log(`\nnow run:  node scripts/verify.mjs ${s.sessionId}`);

server.close();
process.exit(0);
