"use client";

/**
 * Connecting a real Hedera wallet.
 *
 * The old "Connect wallet" tab asked you to type your account id, go and send
 * the HBAR yourself from somewhere else, then come back and press a button
 * promising you had. That is not a connect flow, it is a form, and the honest
 * reading of it is the one people arrived at: there is no way to send HBAR
 * from here.
 *
 * This is the flow every EVM app has trained people to expect. Press connect,
 * pick a wallet, approve, and the transfer is signed in the wallet and
 * executed on the network. Hedera-native only: no EVM adapter, because
 * everything here is an HBAR transfer to an account id, and pulling in wagmi
 * to reach a JSON-RPC relay we never call would be weight for nothing.
 */

import type { AppKit } from "@reown/appkit";

export const PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
export const NETWORK = "testnet";
export const walletAvailable = () => Boolean(PROJECT_ID);

type Ready = {
  appKit: AppKit;
  provider: {
    hedera_signAndExecuteTransaction: (a: {
      signerAccountId: string; transactionList: string;
    }) => Promise<{ transactionId?: string; nodeId?: string }>;
  };
};

let ready: Promise<Ready> | null = null;

/**
 * Built once, on first use, and never during render.
 *
 * AppKit reaches for window and for indexedDB, so importing it at module scope
 * breaks the server render of a page that may never open the wallet tab. The
 * imports are dynamic for the same reason.
 */
export function initWallet(): Promise<Ready> {
  if (ready) return ready;
  ready = (async () => {
    const [{ createAppKit }, hwc] = await Promise.all([
      import("@reown/appkit"),
      import("@hashgraph/hedera-wallet-connect"),
    ]);
    const { HederaAdapter, HederaProvider, HederaChainDefinition, hederaNamespace } = hwc;

    const metadata = {
      name: "Pinout",
      description: "Metered payments for AI agents, on Hedera",
      url: typeof window === "undefined" ? "https://pinout.club" : window.location.origin,
      icons: ["https://pinout.club/icon.svg"],
    };
    const networks = [HederaChainDefinition.Native.Testnet];

    const provider = await HederaProvider.init({ projectId: PROJECT_ID, metadata });
    const adapter = new HederaAdapter({
      projectId: PROJECT_ID,
      networks,
      namespace: hederaNamespace,
    });

    const appKit = createAppKit({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters: [adapter as any],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      universalProvider: provider as any,
      projectId: PROJECT_ID,
      metadata,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      networks: networks as any,
      features: { analytics: false, email: false, socials: false },
    });

    return { appKit, provider: provider as unknown as Ready["provider"] };
  })();
  return ready;
}

/** Open the wallet chooser. Resolves when a wallet is picked, or not. */
export async function connect(): Promise<string | null> {
  const { appKit } = await initWallet();
  await appKit.open();
  return account();
}

export async function disconnect() {
  const { appKit } = await initWallet();
  await appKit.disconnect();
}

/** The connected account in Hedera form, `0.0.x`, or null. */
export function account(): string | null {
  if (typeof window === "undefined") return null;
  const raw = readCaip();
  if (!raw) return null;
  // CAIP-10 is `hedera:testnet:0.0.1234`; we want the tail
  const tail = raw.split(":").pop() ?? "";
  return /^\d+\.\d+\.\d+$/.test(tail) ? tail : null;
}

function readCaip(): string | null {
  try {
    // AppKit keeps the session where a reload can find it, which is how the
    // panel still knows who you are after refreshing the page.
    for (const k of Object.keys(localStorage)) {
      if (!/wc@2|@appkit|reown/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if (!v) continue;
      const m = /hedera:(?:testnet|mainnet):(\d+\.\d+\.\d+)/.exec(v);
      if (m) return m[0];
    }
  } catch { /* private mode, or no storage: treat as not connected */ }
  return null;
}

/**
 * Sign and execute an HBAR transfer from the connected wallet.
 *
 * The wallet signs and submits; we only learn the transaction id, which is
 * exactly what the funding endpoint needs to go and verify the transfer on the
 * mirror node. Nothing here is trusted on the client's word.
 */
export async function sendHbar(
  from: string, to: string, tinybar: number,
): Promise<{ transactionId: string }> {
  const [{ provider }, { TransferTransaction, Hbar, HbarUnit, AccountId }, { transactionToBase64String }] =
    await Promise.all([
      initWallet(),
      import("@hiero-ledger/sdk"),
      import("@hashgraph/hedera-wallet-connect"),
    ]);

  const amount = Hbar.from(tinybar, HbarUnit.Tinybar);
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(from), amount.negated())
    .addHbarTransfer(AccountId.fromString(to), amount)
    .setTransactionMemo("pinout: fund agent wallet");

  const res = await provider.hedera_signAndExecuteTransaction({
    signerAccountId: `hedera:${NETWORK}:${from}`,
    transactionList: transactionToBase64String(tx),
  });
  if (!res?.transactionId) {
    throw new Error("the wallet did not return a transaction id, so nothing can be verified");
  }
  return { transactionId: res.transactionId };
}
