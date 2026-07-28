// Reproducible benchmark behind every number in FINDINGS.md §4.
// Prints a transaction ID for every row so each figure is independently checkable
// on HashScan. Aborts rather than substituting zero when the mirror node has not
// indexed a record — a missing record must never be reported as "free".
//
//   node scripts/bench-hcs.mjs
import {
  Client, PrivateKey, AccountId, Hbar,
  TopicMessageSubmitTransaction, TopicUpdateTransaction,
  CustomFixedFee, CustomFeeLimit,
} from "@hiero-ledger/sdk";
import { env, mirror, tinybarToUsd } from "../src/config.mjs";

const seller = AccountId.fromString(env.SELLER_ACCOUNT_ID);
const buyer = AccountId.fromString(env.HEDERA_ACCOUNT_ID);
const sellerKey = PrivateKey.fromStringECDSA(env.SELLER_PRIVATE_KEY.replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(seller, sellerKey);

const PLAIN = env.BURN_TOPIC_ID;
const FEED = env.TOPIC_ID;
if (!PLAIN || !FEED) throw new Error("BURN_TOPIC_ID and TOPIC_ID must be set");

/** Poll with bounded backoff. Throws if never indexed — never returns 0. */
async function txRecord(txId, { tries = 10 } = {}) {
  const norm = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  let delay = 1500;
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await mirror(`/api/v1/transactions/${norm}`);
      const rec = res.transactions?.[0];
      if (rec) return rec;
    } catch (e) {
      if (!String(e.message).includes("404")) throw e; // real error, not indexing lag
    }
    delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error(`mirror never indexed ${txId} — refusing to report a fee of 0`);
}

async function submit(topicId, bytes, { withFeeLimit, capTinybar = 20_000_000 } = {}) {
  let tx = new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage("x".repeat(bytes))
    .setMaxTransactionFee(new Hbar(5));
  if (withFeeLimit) {
    tx = tx.setCustomFeeLimits([
      new CustomFeeLimit().setAccountId(seller)
        .setFees([new CustomFixedFee().setAmount(capTinybar)]),
    ]);
  }
  const resp = await (await tx.freezeWith(client).sign(sellerKey)).execute(client);
  const receipt = await resp.getReceipt(client);
  if (receipt.status.toString() !== "SUCCESS") throw new Error(`submit ${receipt.status}`);

  const txId = resp.transactionId.toString();
  const rec = await txRecord(txId);
  if (rec.result !== "SUCCESS") throw new Error(`${txId} result=${rec.result}`);

  const network = Number(rec.charged_tx_fee);
  const custom = (rec.assessed_custom_fees ?? []).reduce((a, f) => a + Number(f.amount), 0);
  const { usd } = await tinybarToUsd(network + custom);
  return { bytes, network, custom, total: network + custom, usd, txId };
}

async function setFee(tinybar) {
  const resp = await (await new TopicUpdateTransaction()
    .setTopicId(FEED)
    .setCustomFees([new CustomFixedFee().setAmount(tinybar).setFeeCollectorAccountId(buyer)])
    .setMaxTransactionFee(new Hbar(40))
    .freezeWith(client).sign(sellerKey)).execute(client);
  const st = (await resp.getReceipt(client)).status.toString();
  if (st !== "SUCCESS") throw new Error(`fee update ${st}`);
  return resp.transactionId.toString();
}

const row = (label, r) =>
  console.log(
    `  ${label.padEnd(26)} ${String(r.bytes).padStart(5)}B  ` +
    `network ${String(r.network).padStart(10)}  custom ${String(r.custom).padStart(9)}  ` +
    `= $${r.usd.toFixed(6)}   ${r.txId}`
  );

console.log(`plain topic     : ${PLAIN}`);
console.log(`HIP-991 topic   : ${FEED}\n`);

console.log("A. payload-size sweep, PLAIN topic (expect per-byte scaling)");
for (const b of [100, 1000, 4000]) row("plain", await submit(PLAIN, b));

console.log("\nB. payload-size sweep, HIP-991 topic (expect flat)");
for (const b of [100, 1000, 4000]) row("hip991", await submit(FEED, b, { withFeeLimit: true }));

console.log("\nC. custom-fee-amount sweep on HIP-991 topic (expect network fee unchanged)");
for (const fee of [1, 10_000_000, 100_000]) {
  const upd = await setFee(fee);
  const r = await submit(FEED, 140, { withFeeLimit: true });
  row(`fee=${fee}`, r);
  const pct = (r.custom / r.total) * 100;
  console.log(`      custom fee is ${pct.toFixed(2)}% of seller's total cost   (fee update ${upd})`);
}

console.log("\nfee schedule restored to 100000 tinybar (live setting).");
client.close();
