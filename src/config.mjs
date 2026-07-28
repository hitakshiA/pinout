import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * process.env wins; .env fills the gaps; .env is optional so a fresh checkout
 * can run entirely from real environment variables (CI, containers).
 */
function loadEnv() {
  const out = {};
  const dotenv = join(root, ".env");
  if (existsSync(dotenv)) {
    for (const line of readFileSync(dotenv, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return new Proxy(out, {
    get: (t, k) => process.env[k] ?? t[k],
    has: (t, k) => k in process.env || k in t,
  });
}

export const env = loadEnv();
export const ROOT = root;

export const NETWORK = "hedera:testnet";
export const MIRROR = env.MIRROR_NODE_URL || "https://testnet.mirrornode.hedera.com";
export const HBAR_ASSET = "0.0.0";

export const FACILITATORS = {
  x402: "https://x402.org/facilitator",
  blocky402: "https://api.testnet.blocky402.com",
};

const REQUIRED = [
  "HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY",
  "SELLER_ACCOUNT_ID", "SELLER_PRIVATE_KEY",
  "BURN_TOPIC_ID", "TOPIC_ID",
];

/** Fail fast with the whole list rather than one undefined at a time. */
export function requireConfig(keys = REQUIRED) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `missing config: ${missing.join(", ")}\n` +
      `set them in .env or the environment (see .env.example)`
    );
  }
  return true;
}

/** Never hardcode feePayer — always derive from /supported at boot. */
export async function resolveFeePayer(facilitatorUrl) {
  const r = await fetch(`${facilitatorUrl}/supported`);
  if (!r.ok) throw new Error(`/supported ${r.status} from ${facilitatorUrl}`);
  const { kinds = [] } = await r.json();
  const kind = kinds.find((k) => k.network === NETWORK && k.scheme === "exact");
  if (!kind) throw new Error(`${facilitatorUrl} does not advertise exact/${NETWORK}`);
  if (!kind.extra?.feePayer) throw new Error(`no extra.feePayer advertised by ${facilitatorUrl}`);
  return kind.extra.feePayer;
}

export async function mirror(path) {
  const r = await fetch(`${MIRROR}${path}`);
  if (!r.ok) {
    const e = new Error(`mirror ${r.status} ${path}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/**
 * Poll the mirror node with bounded backoff. Throws if never indexed —
 * a missing record must never be silently reported as zero cost.
 */
export async function awaitTx(txId, { tries = 12 } = {}) {
  const norm = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  let delay = 1200;
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const rec = (await mirror(`/api/v1/transactions/${norm}`)).transactions?.[0];
      if (rec) return rec;
    } catch (e) {
      if (e.status !== 404) throw e; // real error, not indexing lag
    }
    delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error(`mirror never indexed ${txId}`);
}

/** Honest tinybar -> USD via the network's own reported rate. */
export async function tinybarToUsd(tinybar) {
  const { current_rate } = await mirror("/api/v1/network/exchangerate");
  const usdPerHbar = current_rate.cent_equivalent / current_rate.hbar_equivalent / 100;
  return { usd: (Number(tinybar) / 1e8) * usdPerHbar, usdPerHbar };
}

export const hashscan = {
  tx: (id) => `https://hashscan.io/testnet/transaction/${id}`,
  topic: (id) => `https://hashscan.io/testnet/topic/${id}`,
  account: (id) => `https://hashscan.io/testnet/account/${id}`,
};
