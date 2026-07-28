// Two-tier consumption ledger on Hedera Consensus Service.
//
// Tier 1 — BURN LEDGER (plain HCS topic, ~$0.0008/write, high frequency)
//   A checkpoint every N events. Carries everything a third party needs to
//   recompute the bill: which session, which payer, which payment funded it,
//   the price it was struck at, the exact event range, the cumulative burn,
//   and a commitment over the event IDs the client actually received.
//
// Tier 2 — SETTLEMENT ANCHOR (HIP-991 fee-charging topic, ~$0.050/write, rare)
//   Written once at session close. The seller PAYS THE BUYER to write it.
//   It is a protocol-enforced precondition: no refund is issued until this
//   message lands, so the seller cannot walk away with the unused balance
//   without paying to publish its final numbers on an immutable ledger whose
//   fee terms anyone can read from the mirror node.
//
// The anchor embeds the burn ledger's final sequence_number and running_hash,
// which binds the cheap tier to the expensive one: you cannot restate history
// on tier 1 without invalidating the tier-2 anchor that committed to it.
import {
  Client, PrivateKey, AccountId, Hbar,
  TopicMessageSubmitTransaction, CustomFixedFee, CustomFeeLimit,
} from "@hiero-ledger/sdk";
import { createHash } from "node:crypto";
import { env, mirror, awaitTx } from "./config.mjs";

export const CHECKPOINT_VERSION = 1;
export const PRICING_VERSION = 1;

/** Commitment over the event IDs the client can independently reproduce. */
export function commit(eventIds) {
  return createHash("sha256").update(eventIds.join("\n")).digest("hex");
}

export function makeClient() {
  const seller = AccountId.fromString(env.SELLER_ACCOUNT_ID);
  const key = PrivateKey.fromStringECDSA(env.SELLER_PRIVATE_KEY.replace(/^0x/, ""));
  return { client: Client.forTestnet().setOperator(seller, key), seller, key };
}

/**
 * Tier 1: append a burn checkpoint.
 * Every field here exists so the bill can be recomputed by someone who trusts
 * nothing but the mirror node and their own record of received events.
 */
export async function writeCheckpoint(ctx, {
  sessionId, payer, fundingTxIds, pricePerEvent, from, to, cumulativeBurned,
  remaining, eventIds,
}) {
  const body = {
    t: "burn",
    v: CHECKPOINT_VERSION,
    session: sessionId,
    payer,
    funding: fundingTxIds,          // every payment that funded this session
    priceTinybar: pricePerEvent,
    pricingVersion: PRICING_VERSION,
    from, to,                        // half-open event range [from, to)
    burned: cumulativeBurned,        // cumulative, not per-batch
    remaining,
    commit: commit(eventIds),        // client-verifiable
  };
  const msg = JSON.stringify(body);

  const resp = await (await new TopicMessageSubmitTransaction()
    .setTopicId(env.BURN_TOPIC_ID)
    .setMessage(msg)
    .setMaxTransactionFee(new Hbar(2))
    .freezeWith(ctx.client).sign(ctx.key)).execute(ctx.client);

  const receipt = await resp.getReceipt(ctx.client);
  if (receipt.status.toString() !== "SUCCESS") {
    throw new Error(`burn checkpoint failed: ${receipt.status}`);
  }
  // Take seq + running hash from the RECEIPT, not the mirror node. The mirror
  // node lags consensus by seconds, so reading the head there immediately after
  // a write races and returns the previous message.
  return {
    txId: resp.transactionId.toString(),
    sequenceNumber: receipt.topicSequenceNumber?.toNumber?.() ?? null,
    runningHash: receipt.topicRunningHash
      ? Buffer.from(receipt.topicRunningHash).toString("base64")
      : null,
    body,
    bytes: msg.length,
  };
}

/**
 * Tier 2: the settlement anchor. Costs the seller ~$0.050, of which the
 * custom fee is paid directly to the buyer. Refund MUST NOT be issued
 * before this lands — see settleSession().
 */
export async function writeSettlement(ctx, {
  sessionId, payer, fundingTxIds, pricePerEvent, totalBurned, unusedTinybar,
  burnFinalSeq, burnFinalRunningHash, cause,
}) {
  const body = {
    t: "settle",
    v: CHECKPOINT_VERSION,
    session: sessionId,
    payer,
    funding: fundingTxIds,
    priceTinybar: pricePerEvent,
    pricingVersion: PRICING_VERSION,
    burned: totalBurned,
    owedTinybar: totalBurned * pricePerEvent,
    refundTinybar: unusedTinybar,
    // binds tier 1 to tier 2 — restating burn history invalidates this anchor
    burnTopic: env.BURN_TOPIC_ID,
    burnFinalSeq,
    burnFinalRunningHash,
    cause, // #2273 SessionTerminate cause code
  };
  const msg = JSON.stringify(body);

  // Cap what we're willing to pay. The submitter still pays node+network fees
  // on a breach, so this is deliberate, not decorative.
  const limit = new CustomFeeLimit()
    .setAccountId(ctx.seller)
    .setFees([new CustomFixedFee().setAmount(1_000_000)]);

  const resp = await (await new TopicMessageSubmitTransaction()
    .setTopicId(env.TOPIC_ID)
    .setMessage(msg)
    .setCustomFeeLimits([limit])
    .setMaxTransactionFee(new Hbar(5))
    .freezeWith(ctx.client).sign(ctx.key)).execute(ctx.client);

  const receipt = await resp.getReceipt(ctx.client);
  if (receipt.status.toString() !== "SUCCESS") {
    throw new Error(`settlement anchor failed: ${receipt.status}`);
  }

  const txId = resp.transactionId.toString();
  const rec = await awaitTx(txId); // confirm on-chain, don't trust the receipt alone
  const paidToBuyer = (rec.assessed_custom_fees ?? [])
    .reduce((a, f) => a + Number(f.amount), 0);

  return {
    txId,
    sequenceNumber: receipt.topicSequenceNumber?.toNumber?.() ?? null,
    body,
    networkFee: Number(rec.charged_tx_fee),
    paidToBuyer,
  };
}

/**
 * ONE HIP-991 anchor covering MANY sessions.
 *
 * Settling each abandoned session with its own anchor would cost the seller
 * ~0.73 HBAR apiece while the buyer risks only its 0.004 HBAR session price —
 * a 180x asymmetry that turns "open sessions and walk away" into a cheap drain
 * on the seller. Batching makes the cost per session arbitrarily small and is
 * the batched-settlement answer to open question #1 of x402 issue #2273.
 */
export async function writeBatchSettlement(ctx, { sessions, burnFinalSeq, burnFinalRunningHash, cause }) {
  const body = {
    t: "settle-batch",
    v: CHECKPOINT_VERSION,
    cause,
    count: sessions.length,
    sessions: sessions.map((s) => ({
      session: s.id, payer: s.payer, funding: s.fundingTxIds,
      priceTinybar: s.pricePerEvent, burned: s.burned,
      owedTinybar: s.burned * s.pricePerEvent,
      refundTinybar: Math.max(0, s.paidTinybar - s.burned * s.pricePerEvent),
    })),
    burnTopic: env.BURN_TOPIC_ID,
    burnFinalSeq,
    burnFinalRunningHash,
  };
  const msg = JSON.stringify(body);
  const limit = new CustomFeeLimit().setAccountId(ctx.seller)
    .setFees([new CustomFixedFee().setAmount(1_000_000)]);

  const resp = await (await new TopicMessageSubmitTransaction()
    .setTopicId(env.TOPIC_ID).setMessage(msg)
    .setCustomFeeLimits([limit]).setMaxTransactionFee(new Hbar(5))
    .freezeWith(ctx.client).sign(ctx.key)).execute(ctx.client);
  const receipt = await resp.getReceipt(ctx.client);
  if (receipt.status.toString() !== "SUCCESS") throw new Error(`batch anchor failed: ${receipt.status}`);
  const txId = resp.transactionId.toString();
  const rec = await awaitTx(txId);
  return {
    txId, body,
    networkFee: Number(rec.charged_tx_fee),
    paidToBuyer: (rec.assessed_custom_fees ?? []).reduce((a, f) => a + Number(f.amount), 0),
  };
}

/** Read the burn ledger's head so the anchor can commit to it. */
export async function burnLedgerHead(topicId = env.BURN_TOPIC_ID) {
  const res = await mirror(`/api/v1/topics/${topicId}/messages?order=desc&limit=1`);
  const m = res.messages?.[0];
  if (!m) return { sequenceNumber: 0, runningHash: null };
  return {
    sequenceNumber: m.sequence_number,
    runningHash: m.running_hash,
    runningHashVersion: m.running_hash_version,
  };
}
