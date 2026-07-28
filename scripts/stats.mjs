// On-chain + service statistics. Proves the claims rather than restating them.
//   node scripts/stats.mjs [sinceISO]
import { env, mirror, tinybarToUsd, hashscan } from "../src/config.mjs";

const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
async function all(topic) {
  const out = []; let next = `/api/v1/topics/${topic}/messages?order=asc&limit=100`;
  while (next) { const p = await mirror(next); out.push(...(p.messages ?? [])); next = p.links?.next ?? null; }
  return out;
}
const parse = (ms) => ms.map((m) => { try { return { raw: m, b: JSON.parse(b64(m.message)) }; } catch { return null; } }).filter(Boolean);

const burn = parse(await all(env.BURN_TOPIC_ID));
const settle = parse(await all(env.TOPIC_ID));

const sessions = new Map();
for (const { b } of burn) if (b.t === "burn") {
  const s = sessions.get(b.session) ?? { burned: 0, price: b.priceTinybar, checkpoints: 0 };
  s.burned = Math.max(s.burned, b.burned); s.checkpoints++; sessions.set(b.session, s);
}
const anchors = settle.filter((x) => x.b.t === "settle");
const batches = settle.filter((x) => x.b.t === "settle-batch");

let owed = 0, refunded = 0, paidToBuyer = 0;
for (const { b } of anchors) { owed += b.owedTinybar ?? 0; refunded += b.refundTinybar ?? 0; }
for (const { b } of batches) for (const s of b.sessions ?? []) { owed += s.owedTinybar ?? 0; refunded += s.refundTinybar ?? 0; }

// what the seller actually paid the buyer via HIP-991 custom fees
const t = await mirror(`/api/v1/topics/${env.TOPIC_ID}`);
const fee = t.custom_fees?.fixed_fees?.[0];
paidToBuyer = (anchors.length + batches.length) * Number(fee?.amount ?? 0);

const { usd: owedUsd } = await tinybarToUsd(owed);
const { usd: refUsd } = await tinybarToUsd(refunded);
const { usd: feeUsd } = await tinybarToUsd(paidToBuyer);

console.log("PINOUT — ON-CHAIN STATISTICS\n");
console.log(`burn ledger topic     ${env.BURN_TOPIC_ID}  ${hashscan.topic(env.BURN_TOPIC_ID)}`);
console.log(`settlement topic      ${env.TOPIC_ID}  ${hashscan.topic(env.TOPIC_ID)}\n`);
console.log(`sessions metered      ${sessions.size}`);
console.log(`burn checkpoints      ${burn.filter((x) => x.b.t === "burn").length}`);
console.log(`settlement anchors    ${anchors.length} single + ${batches.length} batched`);
console.log(`units billed          ${[...sessions.values()].reduce((a, s) => a + s.burned, 0)}`);
console.log(`\nrevenue owed          ${owed.toLocaleString()} tinybar  ($${owedUsd.toFixed(6)})`);
console.log(`refunded to buyers    ${refunded.toLocaleString()} tinybar  ($${refUsd.toFixed(6)})`);
console.log(`refund rate           ${owed + refunded ? ((refunded / (owed + refunded)) * 100).toFixed(1) : 0}% of everything paid in`);
console.log(`seller -> buyer fees  ${paidToBuyer.toLocaleString()} tinybar  ($${feeUsd.toFixed(6)})   [HIP-991]`);
console.log(`\nfee terms (public)    ${fee?.amount} tinybar -> collector ${fee?.collector_account_id}`);
console.log(`fee schedule key      ${t.fee_schedule_key ? "present" : "ABSENT (frozen)"}`);

for (const a of [env.HEDERA_ACCOUNT_ID, env.SELLER_ACCOUNT_ID]) {
  const acc = await mirror(`/api/v1/accounts/${a}`);
  console.log(`balance ${a}   ${(Number(acc.balance.balance) / 1e8).toFixed(6)} HBAR`);
}
