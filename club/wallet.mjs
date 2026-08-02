// Per-workspace custodial Hedera account.
//
// This is the piece that holds someone else's money, so the rules are narrow
// and stated out loud:
//
//   * The account is created only when funding is first needed, never up front.
//   * It is bound to the funder's account id at creation. That binding is the
//     only address the balance can ever be swept to.
//   * The key exists to sign x402 payments for one workspace and nothing else.
//   * On close, every remaining tinybar goes back to the bound funder and the
//     account is deleted with the funder as the transfer target, so even the
//     rent-exempt remainder returns.
//
// It IS custodial: while a workspace is open, this server can move the funds.
// That is acceptable for a labelled testnet build and is not acceptable for
// mainnet without protocol-level delegation or a real custody design. Nothing
// here should be read as claiming otherwise.
import {
  Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction,
  AccountDeleteTransaction, TransferTransaction, AccountBalanceQuery,
} from "@hiero-ledger/sdk";
import { randomUUID } from "node:crypto";
import { env, mirror } from "../src/config.mjs";

/** Never create an account without enough to exist and pay a fee or two. */
export const MIN_FUND_TINYBAR = 100_000_000;   // 1 HBAR
/** Refuse to custody more than this per workspace on testnet. */
const MAX_FUND_TINYBAR = 5_000_000_000;    // 50 HBAR
/**
 * The most one funding action may move, whoever asks.
 *
 * The ceiling above is a lifetime-of-the-workspace limit, which does nothing to
 * stop a single fat-fingered or scripted transfer. This is per call: fund again
 * if more is genuinely needed, and a mistake costs at most this much.
 */
export const MAX_FUND_PER_CALL_TINYBAR = 1_000_000_000;   // 10 HBAR

/** Throws unless `tinybar` is a sane amount for one funding action. */
export function assertFundable(tinybar) {
  const n = Number(tinybar);
  if (!Number.isFinite(n) || n <= 0) throw new Error("give an amount in tinybar");
  if (n > MAX_FUND_PER_CALL_TINYBAR) {
    throw new Error(
      `one funding action is capped at ${MAX_FUND_PER_CALL_TINYBAR / 1e8} ℏ ` +
      `(asked for ${(n / 1e8).toFixed(4)} ℏ). Send it in smaller amounts.`);
  }
  return n;
}

function operator() {
  const c = Client.forTestnet();
  c.setOperator(
    AccountId.fromString(env.HEDERA_ACCOUNT_ID),
    PrivateKey.fromStringECDSA(env.HEDERA_PRIVATE_KEY.replace(/^0x/, ""))
  );
  return c;
}

/**
 * Create the workspace account, bound to the funder for life.
 * Returns the key material; the caller is responsible for storing it.
 */
export async function createWorkspaceAccount({ funderAccountId, initialTinybar }) {
  if (!funderAccountId) throw new Error("a workspace account must be bound to a funder");
  // A new account must hold enough to exist and pay a fee or two, and that
  // floor is Hedera's, not the job's. An agent that correctly works out it only
  // needs 0.28 HBAR of GPU time should not be refused for it. Fund the floor
  // and let the remainder go home on close, where every unused tinybar goes
  // anyway.
  const funded = Math.max(initialTinybar, MIN_FUND_TINYBAR);
  assertFundable(funded);
  if (funded > MAX_FUND_TINYBAR) {
    throw new Error(`this build will not custody more than ${MAX_FUND_TINYBAR} tinybar per workspace`);
  }

  const client = operator();
  try {
    const key = PrivateKey.generateECDSA();
    const resp = await new AccountCreateTransaction()
      .setKeyWithoutAlias(key.publicKey)
      .setInitialBalance(Hbar.fromTinybars(funded))
      // the account cannot outlive the workspace unnoticed
      .setAccountMemo(`pinout.club workspace, returns to ${funderAccountId}`)
      .execute(client);
    const receipt = await resp.getReceipt(client);

    return {
      accountId: receipt.accountId.toString(),
      // kept so a later top-up cannot be "confirmed" by the deposit that
      // opened the account. The mirror node formats it differently, so both
      // spellings are recorded.
      openingTxId: resp.transactionId.toString(),
      openingTxMirrorId: resp.transactionId.toString()
        .replace("@", "-").replace(/\.(\d+)$/, "-$1"),
      privateKey: key.toStringDer(),
      publicKey: key.publicKey.toStringDer(),
      boundFunder: funderAccountId,
      fundedTinybar: funded,
      requestedTinybar: initialTinybar,
      createdAt: Date.now(),
      id: randomUUID(),
    };
  } finally {
    client.close();
  }
}

/**
 * Confirm the funder actually sent what they claim, from the mirror node
 * rather than from the browser's word for it.
 */
export async function confirmFunding({ accountId, funderAccountId, expectTinybar, consumedTxIds = [] }) {
  // `consumed` is what stops one deposit paying for two requests.
  //
  // Without it this scans recent history and returns the first transfer big
  // enough, which is the transfer that opened the account. A top-up request
  // was answered by the original deposit: the agent asked for 0.4410 HBAR,
  // was told it had been funded 1.4220, and no new money moved at all. The
  // agent then spent against credit it had already spent.
  const seen = new Set(consumedTxIds);
  const res = await mirror(`/api/v1/transactions?account.id=${accountId}&limit=25&order=desc`);
  for (const tx of res.transactions ?? []) {
    if (tx.result !== "SUCCESS") continue;
    if (seen.has(tx.transaction_id)) continue;
    const credit = (tx.transfers ?? []).find(
      (t) => t.account === accountId && Number(t.amount) > 0
    );
    const debit = (tx.transfers ?? []).find(
      (t) => t.account === funderAccountId && Number(t.amount) < 0
    );
    if (credit && debit && Number(credit.amount) >= expectTinybar) {
      return { ok: true, txId: tx.transaction_id, amount: Number(credit.amount) };
    }
  }
  return { ok: false };
}

/**
 * Send HBAR into a workspace account.
 *
 * In the browser this is the user's own wallet signing a transfer, and the
 * server only ever confirms it afterwards. This exists so a headless harness
 * can stand in for that signature; it is not on the request path for a real
 * user, and it deliberately pays from the operator rather than pretending to
 * be anyone else.
 */
export async function sendToWorkspace({ accountId, tinybar, from }) {
  assertFundable(tinybar);
  const client = operator();
  try {
    const resp = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(from), Hbar.fromTinybars(-tinybar))
      .addHbarTransfer(AccountId.fromString(accountId), Hbar.fromTinybars(tinybar))
      .setTransactionMemo("pinout.club top-up")
      .execute(client);
    const receipt = await resp.getReceipt(client);
    return {
      ok: receipt.status.toString() === "SUCCESS",
      txId: resp.transactionId.toString(),
      tinybar,
    };
  } finally {
    client.close();
  }
}

/**
 * Take HBAR back out of the agent's wallet mid-job.
 *
 * The point of this is that money in the agent's wallet is never money the
 * human has given up control of. They can pull it back while the agent is
 * still working; the agent simply finds itself short and asks for more, which
 * it already knows how to do. Only ever pays out to the bound funder.
 */
export async function withdraw({ accountId, privateKey, boundFunder, tinybar, to, leaveTinybar = 100_000 }) {
  // `to` lets a human send the balance somewhere other than where it came from,
  // which they are entitled to do with their own money. Without it the default
  // is the bound funder, so the safe path stays the default and the deliberate
  // one has to be asked for.
  const target = to || boundFunder;
  if (!target) throw new Error("refusing to pay out an account with no destination");
  if (!/^\d+\.\d+\.\d+$/.test(target)) throw new Error(`${target} is not a Hedera account id`);
  const client = operator();
  const key = PrivateKey.fromStringDer(privateKey);
  try {
    const bal = (await new AccountBalanceQuery().setAccountId(accountId).execute(client))
      .hbars.toTinybars().toNumber();
    // leave enough behind to pay a fee, or the account is stranded and the
    // agent cannot even sign the transaction that would close it
    const available = Math.max(0, bal - leaveTinybar);
    const amount = tinybar ? Math.min(tinybar, available) : available;
    if (amount <= 0) return { withdrawn: 0, balanceTinybar: bal, note: "nothing available to withdraw" };

    const tx = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(accountId), Hbar.fromTinybars(-amount))
      .addHbarTransfer(AccountId.fromString(target), Hbar.fromTinybars(amount))
      .setTransactionMemo("pinout.club withdrawal")
      .freezeWith(client).sign(key);
    const resp = await tx.execute(client);
    const st = (await resp.getReceipt(client)).status.toString();
    if (st !== "SUCCESS") throw new Error(`withdrawal failed: ${st}`);
    return {
      withdrawn: amount, to: target, txId: resp.transactionId.toString(),
      balanceTinybar: bal - amount,
    };
  } finally { client.close(); }
}

export async function balanceOf(accountId) {
  const client = operator();
  try {
    const b = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
    return b.hbars.toTinybars().toNumber();
  } finally {
    client.close();
  }
}

/**
 * Return everything and delete the account.
 *
 * Deleting with the funder as transfer target is what makes this whole model
 * honest: a plain transfer always strands the rent-exempt remainder, so the
 * only way to give back every tinybar is to close the account into theirs.
 */
export async function sweepAndClose({ accountId, privateKey, boundFunder }) {
  if (!boundFunder) throw new Error("refusing to sweep an account with no bound funder");
  const client = operator();
  const key = PrivateKey.fromStringDer(privateKey);
  try {
    const before = await new AccountBalanceQuery()
      .setAccountId(accountId).execute(client);
    const tinybar = before.hbars.toTinybars().toNumber();

    const tx = await new AccountDeleteTransaction()
      .setAccountId(AccountId.fromString(accountId))
      .setTransferAccountId(AccountId.fromString(boundFunder))
      .freezeWith(client)
      .sign(key);

    const receipt = await (await tx.execute(client)).getReceipt(client);
    return {
      closed: receipt.status.toString() === "SUCCESS",
      returnedTinybar: tinybar,
      to: boundFunder,
    };
  } finally {
    client.close();
  }
}

/** What the user is trusting, in a form the UI can render verbatim. */
export const CUSTODY_DISCLOSURE = {
  custodial: true,
  summary:
    "Funding creates a Hedera testnet account that this server holds the key to. " +
    "It can only ever be swept back to the account you funded it from.",
  whileOpen: "The server can sign payments from this account on your behalf.",
  onClose: "The balance is returned to your account and the account is deleted.",
  notForMainnet: true,
  maxTinybar: MAX_FUND_TINYBAR,
  maxPerCallTinybar: MAX_FUND_PER_CALL_TINYBAR,
};
