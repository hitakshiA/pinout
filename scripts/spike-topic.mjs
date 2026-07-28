// PHASE 0 SPIKE 2 — create the HIP-991 metering topic and measure what a
// checkpoint actually costs, so the checkpoint interval N is derived from
// measurement rather than from HIP-991's quoted $0.0008.
//
// Design decisions locked here (some are IRREVERSIBLE):
//   * fee collector    = THE BUYER. Every checkpoint the seller writes pays
//                        the buyer. Over-billing costs the seller money paid
//                        directly to the party it would defraud. The meter
//                        pays its own auditor.
//   * feeScheduleKey   = set at creation. It can NEVER be added later; a topic
//                        created without one has a frozen fee schedule forever.
//   * submitKey        = seller only. Without it anyone could forge checkpoints
//                        and the burn ledger would be meaningless.
//   * feeExemptKeyList = EMPTY. The seller must NOT be exempt — paying is the
//                        entire incentive mechanism.
import {
  Client, PrivateKey, AccountId, Hbar,
  TopicCreateTransaction, TopicMessageSubmitTransaction,
  CustomFixedFee, CustomFeeLimit,
} from "@hiero-ledger/sdk";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { env, ROOT, mirror, tinybarToUsd } from "../src/config.mjs";

const FEE_TINYBAR = 100_000; // 0.001 HBAR per checkpoint, seller -> buyer

const buyer = AccountId.fromString(env.HEDERA_ACCOUNT_ID);
const seller = AccountId.fromString(env.SELLER_ACCOUNT_ID);
const sellerKey = PrivateKey.fromStringECDSA(env.SELLER_PRIVATE_KEY.replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(seller, sellerKey);

let topicId = env.TOPIC_ID;

if (!topicId) {
  const fee = new CustomFixedFee()
    .setAmount(FEE_TINYBAR)            // no denominating token => HBAR
    .setFeeCollectorAccountId(buyer);  // <-- the inversion

  const resp = await new TopicCreateTransaction()
    .setTopicMemo("pinout metered burn ledger v1")
    .setAdminKey(sellerKey.publicKey)
    .setSubmitKey(sellerKey.publicKey)
    .setFeeScheduleKey(sellerKey.publicKey) // irreversible if omitted
    .setCustomFees([fee])
    // A HIP-991 topic costs materially more to create than a plain one;
    // the SDK default max fee is not enough and fails INSUFFICIENT_TX_FEE.
    .setMaxTransactionFee(new Hbar(40)) // measured: HIP-991 topic costs ~29.36 HBAR
    .freezeWith(client)
    .sign(sellerKey)
    .then((tx) => tx.execute(client));

  const receipt = await resp.getReceipt(client);
  topicId = receipt.topicId.toString();
  console.log("topic created  :", topicId);
  console.log("tx             :", resp.transactionId.toString());
  appendFileSync(join(ROOT, ".env"), `\nTOPIC_ID=${topicId}\n`);
} else {
  console.log("reusing topic  :", topicId);
}

// ---- read the fee terms back from the public mirror node ------------------
await new Promise((r) => setTimeout(r, 5000));
const t = await mirror(`/api/v1/topics/${topicId}`);
console.log("\n--- fee terms, publicly verifiable ---");
console.log("custom_fees         :", JSON.stringify(t.custom_fees));
console.log("fee_schedule_key    :", t.fee_schedule_key ? t.fee_schedule_key._type : "NONE (frozen forever)");
console.log("fee_exempt_key_list :", JSON.stringify(t.fee_exempt_key_list ?? []));

// ---- measure checkpoint cost at 3 realistic payload sizes ------------------
// The submit fee has a per-byte component, so N depends on payload size.
const sizes = [
  { label: "small  (10 events)", events: 10 },
  { label: "medium (100 events)", events: 100 },
  { label: "large  (1000 events)", events: 1000 },
];

console.log("\n--- checkpoint cost by payload size ---");
const results = [];
let seq = 0;

for (const s of sizes) {
  const eventIds = Array.from({ length: s.events }, (_, i) => `evt-${seq}-${i}`);
  const digest = createHash("sha256").update(eventIds.join(",")).digest("hex");
  const checkpoint = JSON.stringify({
    v: 1, seq: ++seq, from: 0, to: s.events,
    burned: s.events, remaining: 100000 - s.events,
    digest,
  });

  const limit = new CustomFeeLimit()
    .setAccountId(seller)
    .setFees([new CustomFixedFee().setAmount(FEE_TINYBAR * 2)]); // cap = 2x expected

  const resp = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(checkpoint)
    .setCustomFeeLimits([limit])
    .setMaxTransactionFee(new Hbar(5))
    .freezeWith(client)
    .sign(sellerKey)
    .then((tx) => tx.execute(client));

  await resp.getReceipt(client);
  await new Promise((r) => setTimeout(r, 4000));

  const norm = resp.transactionId.toString().replace("@", "-").replace(/\.(\d+)$/, "-$1");
  const rec = (await mirror(`/api/v1/transactions/${norm}`)).transactions?.[0];
  const networkFee = rec?.charged_tx_fee ?? 0;
  const assessed = (rec?.assessed_custom_fees ?? []).reduce((a, f) => a + Number(f.amount), 0);
  const total = networkFee + assessed;
  const { usd, usdPerHbar } = await tinybarToUsd(total);

  results.push({ ...s, bytes: checkpoint.length, networkFee, assessed, total, usd, usdPerHbar });
  console.log(
    `${s.label.padEnd(21)} ${String(checkpoint.length).padStart(5)}B  ` +
    `network ${String(networkFee).padStart(7)}  custom ${String(assessed).padStart(7)}  ` +
    `total ${String(total).padStart(7)} tinybar = $${usd.toFixed(6)}`
  );
}

client.close();

// ---- derive N from measurement --------------------------------------------
const mid = results[1];
console.log("\n--- deriving checkpoint interval N ---");
console.log(`HBAR/USD (network reported): $${mid.usdPerHbar.toFixed(6)}`);
console.log(`HIP-991 quoted submit price: $0.0008`);
console.log(`measured total per checkpoint (100 events): $${mid.usd.toFixed(6)}`);
for (const pricePerEvent of [0.00001, 0.0001, 0.001]) {
  const nBreakeven = mid.usd / pricePerEvent;
  console.log(
    `  @ $${pricePerEvent.toFixed(5)}/event -> checkpoint cost equals revenue at N=${nBreakeven.toFixed(1)}; ` +
    `use N>=${Math.ceil(nBreakeven * 10)} to keep metering <=10% of revenue`
  );
}
console.log(`\ntopic: https://hashscan.io/testnet/topic/${topicId}`);
