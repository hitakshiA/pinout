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
const MIN_FUND_TINYBAR = 100_000_000;      // 1 HBAR
/** Refuse to custody more than this per workspace on testnet. */
const MAX_FUND_TINYBAR = 5_000_000_000;    // 50 HBAR

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
  if (initialTinybar < MIN_FUND_TINYBAR) {
    throw new Error(`fund at least ${MIN_FUND_TINYBAR} tinybar so the account can pay its own way`);
  }
  if (initialTinybar > MAX_FUND_TINYBAR) {
    throw new Error(`this build will not custody more than ${MAX_FUND_TINYBAR} tinybar per workspace`);
  }

  const client = operator();
  try {
    const key = PrivateKey.generateECDSA();
    const receipt = await (await new AccountCreateTransaction()
      .setKeyWithoutAlias(key.publicKey)
      .setInitialBalance(Hbar.fromTinybars(initialTinybar))
      // the account cannot outlive the workspace unnoticed
      .setAccountMemo(`pinout.club workspace, returns to ${funderAccountId}`)
      .execute(client)).getReceipt(client);

    return {
      accountId: receipt.accountId.toString(),
      privateKey: key.toStringDer(),
      publicKey: key.publicKey.toStringDer(),
      boundFunder: funderAccountId,
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
export async function confirmFunding({ accountId, funderAccountId, expectTinybar }) {
  const res = await mirror(`/api/v1/transactions?account.id=${accountId}&limit=25&order=desc`);
  for (const tx of res.transactions ?? []) {
    if (tx.result !== "SUCCESS") continue;
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
};
