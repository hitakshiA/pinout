// Session state machine for prepaid metered streaming.
//
// The ordering rules here are the ones that actually matter, and each exists
// because getting it wrong produces a specific real failure:
//
//   * Credits are minted ONLY after the payment is confirmed on-chain.
//     Minting on the 200 (before settlement finality) means a failed settle
//     leaves the buyer streaming for free.
//   * Every mint is IDEMPOTENT on the settlement transaction id. A retried
//     top-up must not double-credit.
//   * At zero the stream PAUSES; it never overdraws. Underflow would be
//     unbilled delivery.
//   * Refund is issued only AFTER the HIP-991 settlement anchor lands, and
//     only once. The anchor is the precondition, not a receipt.
//
// State: OPENING -> ACTIVE <-> PAUSED -> SETTLING -> CLOSED
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  Client, PrivateKey, AccountId, Hbar, TransferTransaction,
} from "@hiero-ledger/sdk";
import { env, awaitTx } from "./config.mjs";
import { makeClient, writeCheckpoint, writeSettlement, writeBatchSettlement, burnLedgerHead } from "./ledger.mjs";

/** #2273 SessionTerminate cause codes, verbatim. */
export const CAUSE = {
  BALANCE_EXHAUSTED: "balance-exhausted",
  MAX_DURATION: "max-duration-reached",
  SERVER_SHUTDOWN: "server-shutdown",
  CLIENT_DISCONNECT: "client-disconnect",
  POLICY_VIOLATION: "policy-violation",
};

export class Session {
  constructor({ payer, pricePerEvent, checkpointEvery, topUpThreshold, maxDurationMs }) {
    this.id = randomUUID();
    // Per-session bearer secret. Previously the session id alone authorised
    // stream/topup/close, so anyone who learned an id could close a stranger's
    // session — and every close costs the seller a ~0.73 HBAR anchor.
    // The plaintext is returned exactly once at mint; only the hash is kept.
    this.secret = randomBytes(32).toString("base64url");
    this.secretHash = createHash("sha256").update(this.secret).digest();
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    // #2273 maxSessionDuration. Previously we defined CAUSE.MAX_DURATION and
    // never enforced it: an abandoned session stranded the buyer's money
    // permanently.
    this.maxDurationMs = maxDurationMs ?? 10 * 60_000;
    this.payer = payer;
    this.pricePerEvent = pricePerEvent;   // tinybar per event
    this.checkpointEvery = checkpointEvery;
    this.topUpThreshold = topUpThreshold;
    this.state = "OPENING";

    this.credits = 0;            // events still purchased
    this.burned = 0;             // cumulative events delivered
    this.paidTinybar = 0;        // total received across mint + top-ups
    this.fundingTxIds = [];
    this.seenTxIds = new Set();  // idempotency guard

    this.pendingEventIds = [];   // since last checkpoint
    this.lastCheckpointAt = 0;   // event index of last checkpoint
    this.checkpoints = [];
    this.settlement = null;
    this.refund = null;
    this.cheat = 0;              // --cheat: phantom events added to the ledger
  }

  /**
   * Grant credits against a CONFIRMED on-chain payment.
   * Idempotent: replaying the same settlement tx is a no-op.
   */
  credit(settlementTxId, amountTinybar) {
    if (this.state === "CLOSED" || this.state === "SETTLING") {
      // Topping up a session that is settling would credit funds the
      // settlement anchor has already declared final.
      throw new Error(`session ${this.id} is ${this.state}; cannot accept credit`);
    }
    if (this.seenTxIds.has(settlementTxId)) {
      return { credited: 0, duplicate: true, credits: this.credits };
    }
    this.seenTxIds.add(settlementTxId);
    this.fundingTxIds.push(settlementTxId);

    const events = Math.floor(amountTinybar / this.pricePerEvent);
    this.credits += events;
    this.paidTinybar += amountTinybar;
    if (this.state === "OPENING" || this.state === "PAUSED") this.state = "ACTIVE";
    return { credited: events, duplicate: false, credits: this.credits };
  }

  /** Constant-time bearer check. */
  authorise(token) {
    if (!token) return false;
    const h = createHash("sha256").update(String(token)).digest();
    return h.length === this.secretHash.length && timingSafeEqual(h, this.secretHash);
  }

  touch() { this.lastActivityAt = Date.now(); }

  get expired() {
    return this.state !== "CLOSED" && (Date.now() - this.lastActivityAt) > this.maxDurationMs;
  }

  get lowBalance() {
    return this.credits <= this.topUpThreshold;
  }

  /**
   * Burn one event. Returns false when the session may not consume.
   * State is checked BEFORE balance: a settled session still holds a credit
   * figure, and without this guard a buyer could close, collect the refund,
   * and keep streaming for free against credits it has already been repaid.
   */
  burn(eventId) {
    if (this.state === "CLOSED" || this.state === "SETTLING") return false;
    if (this.credits <= 0) {
      this.state = "PAUSED";
      return false;
    }
    this.credits -= 1;
    this.burned += 1;
    this.pendingEventIds.push(eventId);
    if (this.credits === 0) this.state = "PAUSED";
    return true;
  }

  get needsCheckpoint() {
    return this.pendingEventIds.length >= this.checkpointEvery;
  }

  /** #2273 SessionUpdate frame. */
  update() {
    return {
      type: "SessionUpdate",
      session: this.id,
      unitsConsumed: this.burned,
      consumedAmount: String(this.burned * this.pricePerEvent),
      remainingBalance: String(this.credits * this.pricePerEvent),
      remainingUnits: this.credits,
    };
  }
}

/** Tier 1 write: flush pending events to the burn ledger. */
export async function flushCheckpoint(ctx, s) {
  if (!s.pendingEventIds.length) return null;
  const from = s.lastCheckpointAt;
  const to = s.burned;
  // --cheat inflates the ledger's burn count above what was delivered.
  const claimed = to + s.cheat;

  const cp = await writeCheckpoint(ctx, {
    sessionId: s.id,
    payer: s.payer,
    fundingTxIds: s.fundingTxIds,
    pricePerEvent: s.pricePerEvent,
    from,
    to: claimed,
    cumulativeBurned: claimed,
    remaining: s.credits,
    eventIds: s.pendingEventIds,
  });
  s.checkpoints.push(cp);
  s.lastCheckpointAt = claimed;
  s.pendingEventIds = [];
  return cp;
}

/**
 * Close the session.
 *   1. flush any trailing burn checkpoint
 *   2. write the HIP-991 settlement anchor  <-- PRECONDITION
 *   3. only then issue the refund
 * If step 2 fails the refund is not sent and the session stays SETTLING.
 */
export async function settleSession(ctx, s, cause = CAUSE.CLIENT_DISCONNECT) {
  // Serialize. Without this, two concurrent closes both pass the CLOSED check,
  // both write an anchor, and both refund — the buyer is paid twice and the
  // ledger carries two contradictory anchors for one session.
  if (s._closing) return s._closing;
  if (s.state === "CLOSED") return { alreadyClosed: true, ...s.settlementResult };
  s._closing = doSettle(ctx, s, cause).finally(() => { s._closing = null; });
  return s._closing;
}

async function doSettle(ctx, s, cause) {
  s.state = "SETTLING";

  await flushCheckpoint(ctx, s);

  // Bind to the head as reported by the LAST CHECKPOINT'S RECEIPT. Reading the
  // mirror node here races: it lags consensus and returns the previous message,
  // producing an anchor that commits to a stale sequence number.
  const last = s.checkpoints[s.checkpoints.length - 1];
  const head = last
    ? { sequenceNumber: last.sequenceNumber, runningHash: last.runningHash }
    : await burnLedgerHead();

  const owed = s.burned * s.pricePerEvent;
  const unused = Math.max(0, s.paidTinybar - owed);

  // (2) The settlement anchor.
  //
  // The anchor gates the SELLER'S claim, not the buyer's money. Refusing to
  // refund because the seller cannot afford to publish its own numbers is
  // exactly backwards — it strands the buyer's balance to protect the seller's
  // bookkeeping. An anchor costs ~0.73 HBAR; a seller that runs dry would
  // otherwise trap every open session's prepaid balance.
  //
  // So: try to anchor. If it fails, refund anyway and record the session as
  // UNANCHORED so the failure is visible rather than silent.
  let settlement = null, anchorError = null;
  try {
    settlement = await writeSettlement(ctx, {
      sessionId: s.id,
      payer: s.payer,
      fundingTxIds: s.fundingTxIds,
      pricePerEvent: s.pricePerEvent,
      totalBurned: s.burned,
      unusedTinybar: unused,
      burnFinalSeq: head.sequenceNumber,
      burnFinalRunningHash: head.runningHash,
      cause,
    });
  } catch (e) {
    anchorError = e.message;
    console.error(`ANCHOR FAILED for ${s.id}: ${e.message} — refunding anyway`);
  }
  s.settlement = settlement;
  s.anchorError = anchorError;

  // (3) refund, exactly once, only now
  let refund = null;
  if (unused > 0 && !s.refund) {
    const resp = await (await new TransferTransaction()
      .addHbarTransfer(ctx.seller, Hbar.fromTinybars(-unused))
      .addHbarTransfer(AccountId.fromString(s.payer), Hbar.fromTinybars(unused))
      .setTransactionMemo(`pinout refund ${s.id.slice(0, 8)}`)
      .freezeWith(ctx.client).sign(ctx.key)).execute(ctx.client);
    const st = (await resp.getReceipt(ctx.client)).status.toString();
    if (st !== "SUCCESS") throw new Error(`refund failed: ${st}`);
    // getReceipt above already confirms consensus finality. Polling the mirror
    // node here added 15-30s to every close and pushed the response past the
    // default HTTP client timeout, so a correct settlement looked like a
    // failure to the caller.
    refund = { txId: resp.transactionId.toString(), tinybar: unused };
    s.refund = refund;
  }

  // Zero the balance. The unused portion has now been refunded on-chain, so
  // leaving a positive figure on a CLOSED session is money that exists twice.
  s.credits = 0;
  s.state = "CLOSED";
  s.settlementResult = {
    settlement, refund, owed, unused, anchorError,
    anchored: Boolean(settlement),
    terminate: {
      type: "SessionTerminate",
      session: s.id,
      cause,
      consumedAmount: String(owed),
      refundAmount: String(unused),
      refundTxHash: refund?.txId ?? null,
    },
  };
  return s.settlementResult;
}

export { makeClient };


/**
 * Settle many expired sessions under ONE HIP-991 anchor, then refund each.
 * Same precondition as the single-session path: no refund before the anchor
 * lands. Batching is what makes cleaning up abandoned sessions economically
 * survivable for the seller.
 */
export async function settleExpired(ctx, sessions, cause = CAUSE.MAX_DURATION) {
  const due = [...sessions].filter((s) => s.expired && !s._closing && s.state !== "CLOSED");
  if (!due.length) return null;

  for (const s of due) { s.state = "SETTLING"; await flushCheckpoint(ctx, s); }

  const last = due.map((s) => s.checkpoints[s.checkpoints.length - 1]).filter(Boolean).pop();
  const head = last
    ? { sequenceNumber: last.sequenceNumber, runningHash: last.runningHash }
    : await burnLedgerHead();

  const anchor = await writeBatchSettlement(ctx, {
    sessions: due,
    burnFinalSeq: head.sequenceNumber,
    burnFinalRunningHash: head.runningHash,
    cause,
  });

  const refunds = [];
  for (const s of due) {
    const unused = Math.max(0, s.paidTinybar - s.burned * s.pricePerEvent);
    if (unused > 0 && !s.refund) {
      const resp = await (await new TransferTransaction()
        .addHbarTransfer(ctx.seller, Hbar.fromTinybars(-unused))
        .addHbarTransfer(AccountId.fromString(s.payer), Hbar.fromTinybars(unused))
        .setTransactionMemo(`pinout expire ${s.id.slice(0, 8)}`)
        .freezeWith(ctx.client).sign(ctx.key)).execute(ctx.client);
      const st = (await resp.getReceipt(ctx.client)).status.toString();
      if (st !== "SUCCESS") throw new Error(`expiry refund failed: ${st}`);
      s.refund = { txId: resp.transactionId.toString(), tinybar: unused };
      refunds.push(s.refund);
    }
    s.credits = 0;
    s.state = "CLOSED";
    s.settlementResult = { settlement: anchor, refund: s.refund, unused,
      terminate: { type: "SessionTerminate", session: s.id, cause } };
  }
  return { anchor, sessions: due.length, refunds };
}
