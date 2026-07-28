// PHASE 0 SPIKE 1 — prove one real x402 `exact` payment settles on Hedera testnet.
//
// Uses the official @x402/hedera scheme for payload construction and the
// official HTTPFacilitatorClient for verify/settle. The HTTP layer is
// hand-rolled so a failure is legible rather than buried in a framework.
//
// Rules this exercises (from specs/schemes/exact/scheme_exact_hedera.md):
//   1. bare TransferTransaction, not wrapped
//   2. transactionId.accountId == extra.feePayer
//   3. feePayer never a negative entry
//   5. exact amount to payTo, no other positive transfers
//   6. facilitator verifies payer key via AccountInfoQuery  <- needs hydrated key

import { PrivateKey } from "@hiero-ledger/sdk";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { env, NETWORK, HBAR_ASSET, FACILITATORS, resolveFeePayer, mirror } from "../src/config.mjs";

const FACILITATOR = process.argv[2] === "blocky402" ? FACILITATORS.blocky402 : FACILITATORS.x402;
const PRICE_TINYBAR = "100000"; // 0.001 HBAR — a genuine micropayment

const payerId = env.HEDERA_ACCOUNT_ID;
const payerKey = PrivateKey.fromStringECDSA(env.HEDERA_PRIVATE_KEY.replace(/^0x/, ""));

// Seller is a distinct account so the transfer is a real two-party payment.
const sellerId = env.SELLER_ACCOUNT_ID;
if (!sellerId) throw new Error("SELLER_ACCOUNT_ID missing from .env");

console.log(`facilitator : ${FACILITATOR}`);
const feePayer = await resolveFeePayer(FACILITATOR); // never hardcoded
console.log(`feePayer    : ${feePayer}  (from /supported)`);
console.log(`payer       : ${payerId}`);
console.log(`payTo       : ${sellerId}`);
console.log(`amount      : ${PRICE_TINYBAR} tinybar (${Number(PRICE_TINYBAR) / 1e8} HBAR)\n`);

// ---- what a resource server would emit in the 402 -------------------------
const paymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  amount: PRICE_TINYBAR,
  asset: HBAR_ASSET,
  payTo: sellerId,
  maxTimeoutSeconds: 180,
  extra: { feePayer },
};

// ---- client builds + partially signs --------------------------------------
const signer = createClientHederaSigner(payerId, payerKey, { network: NETWORK });
const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));

const payload = await client.createPaymentPayload({
  x402Version: 2,
  accepts: [paymentRequirements],
  resource: {
    url: "https://pinout.local/stream",
    description: "Pinout metered stream session",
    mimeType: "application/json",
  },
});
console.log("payload built, transaction bytes:", payload.payload.transaction.length, "b64 chars");

// ---- resource server -> facilitator verify, then settle -------------------
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });

const verify = await facilitator.verify(payload, paymentRequirements);
console.log("\n/verify     :", JSON.stringify(verify));
if (!verify.isValid) {
  console.error("VERIFY FAILED —", verify.invalidReason ?? "(no reason given)");
  process.exit(1);
}

const settle = await facilitator.settle(payload, paymentRequirements);
console.log("/settle     :", JSON.stringify(settle));
if (!settle.success) {
  console.error("SETTLE FAILED —", settle.errorReason ?? "(no reason given)");
  process.exit(1);
}

// ---- confirm on-chain, not just in the response ---------------------------
const txId = settle.transaction;
console.log("\nconfirming on-chain…");
let record = null;
for (let i = 0; i < 12 && !record; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const norm = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
    const res = await mirror(`/api/v1/transactions/${norm}`);
    record = res.transactions?.[0] ?? null;
  } catch { /* not indexed yet */ }
}

if (!record) {
  console.error("NOT FOUND on mirror node after 30s:", txId);
  process.exit(1);
}

console.log("result          :", record.result);
console.log("charged_tx_fee  :", record.charged_tx_fee, "tinybar (paid by facilitator)");
console.log("transfers       :");
for (const t of record.transfers ?? []) {
  if (Math.abs(t.amount) >= 1000) console.log(`   ${t.account.padEnd(12)} ${t.amount > 0 ? "+" : ""}${t.amount}`);
}
console.log("\nHashScan: https://hashscan.io/testnet/transaction/" + txId);
