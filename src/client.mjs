// Pinout client — pays x402 402 challenges, consumes the SSE stream, and
// tops up mid-stream without dropping the connection.
//
// Spend safety, modelled on @vybenetwork/x402-client:
//   maxPerCallTinybar — refuses to sign a challenge above this, BEFORE signing
//   budgetTinybar     — cumulative cap across the whole client
// Both throw before any signature exists, so no funds are ever at risk from a
// mispriced or injected 402.
import { PrivateKey } from "@hiero-ledger/sdk";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader, encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { env, NETWORK } from "./config.mjs";

export class BudgetExceededError extends Error {}
export class UntrustedPaymentError extends Error {}

export class PinoutClient {
  constructor({ base, accountId, privateKey, maxPerCallTinybar = 5_000_000, budgetTinybar = 50_000_000 }) {
    this.base = base.replace(/\/$/, "");
    this.accountId = accountId ?? env.HEDERA_ACCOUNT_ID;
    this.maxPerCall = maxPerCallTinybar;
    this.budget = budgetTinybar;
    this.spent = 0;
    this.secrets = new Map(); // sessionId -> bearer secret, issued once at mint
    const key = PrivateKey.fromStringECDSA(
      (privateKey ?? env.HEDERA_PRIVATE_KEY).replace(/^0x/, "")
    );
    const signer = createClientHederaSigner(this.accountId, key, { network: NETWORK });
    this.x402 = new x402Client().register(NETWORK, new ExactHederaScheme(signer));
  }

  /** Bearer header for a session, if we hold its secret. */
  #auth(sessionId) {
    const t = this.secrets.get(sessionId);
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  /** POST that transparently satisfies a 402 challenge. */
  async pay(path, { method = "POST", headers = {} } = {}) {
    const url = `${this.base}${path}`;
    const first = await fetch(url, { method, headers });
    if (first.status !== 402) return { paid: false, res: first, body: await first.json() };

    const header = first.headers.get("PAYMENT-REQUIRED");
    const challenge = header ? decodePaymentRequiredHeader(header) : await first.json();
    const amount = Number(challenge.accepts[0].amount);

    // --- guards run BEFORE any signature is produced ---
    if (amount > this.maxPerCall) {
      throw new UntrustedPaymentError(
        `402 demands ${amount} tinybar, per-call cap is ${this.maxPerCall}`
      );
    }
    if (this.spent + amount > this.budget) {
      throw new BudgetExceededError(
        `would spend ${this.spent + amount}, budget is ${this.budget}`
      );
    }
    if (challenge.accepts[0].network !== NETWORK) {
      throw new UntrustedPaymentError(`unexpected network ${challenge.accepts[0].network}`);
    }

    const payload = await this.x402.createPaymentPayload(challenge);
    const res = await fetch(url, {
      method,
      headers: { ...headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`paid request failed ${res.status}: ${JSON.stringify(body)}`);
    this.spent += amount;

    const pr = res.headers.get("PAYMENT-RESPONSE");
    return {
      paid: true, res, body, spent: this.spent,
      settlement: pr ? decodePaymentResponseHeader(pr) : null,
    };
  }

  /**
   * The official middleware settles AFTER the handler, so the settlement tx id
   * is not in the JSON body — it arrives in the PAYMENT-RESPONSE header.
   * Merge it back so callers get one object with the on-chain proof in it.
   */
  #withSettlement(r) {
    const tx = r.settlement?.transaction ?? null;
    return {
      ...r.body,
      paymentTx: tx,
      paymentTxUrl: tx ? `https://hashscan.io/testnet/transaction/${tx}` : null,
      settledOnChain: Boolean(r.settlement?.success),
    };
  }
  async openSession(laneOrOpts = "") {
    const opts = typeof laneOrOpts === "string" && laneOrOpts.startsWith("?")
      ? laneOrOpts
      : laneOrOpts ? `?lane=${laneOrOpts}` : "";
    return this.#open(opts);
  }
  async #open(opts) {
    const out = this.#withSettlement(await this.pay(`/session${opts}`));
    // The secret is returned exactly once; hold it for the session's lifetime.
    if (out.sessionSecret) this.secrets.set(out.sessionId, out.sessionSecret);
    return out;
  }
  async topUp(sessionId) {
    return this.#withSettlement(
      await this.pay(`/session/${sessionId}/topup`, { headers: this.#auth(sessionId) })
    );
  }
  async close(sessionId, cause) {
    const r = await fetch(
      `${this.base}/session/${sessionId}/close${cause ? `?cause=${cause}` : ""}`,
      { method: "POST", headers: this.#auth(sessionId) }
    );
    return r.json();
  }

  /**
   * Consume the SSE stream. Records every event id so the bill can be
   * recomputed independently later. Fires onLow when the balance crosses
   * the top-up threshold — the socket is NOT dropped to top up.
   */
  async stream(sessionId, { n = 500, provider, code, prompt, onEvent, onLow, onCheckpoint } = {}) {
    const q = new URLSearchParams({ n: String(n) });
    if (provider) q.set("provider", provider);
    if (prompt) q.set("prompt", prompt);
    // Arbitrary source is base64'd so quoting and newlines survive the URL.
    if (code) q.set("code", Buffer.from(code, "utf8").toString("base64"));
    const res = await fetch(`${this.base}/session/${sessionId}/stream?${q}`,
      { headers: this.#auth(sessionId) });
    if (!res.ok) throw new Error(`stream ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const received = [];
    let buf = "", event = null, terminated = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const chunk of parts) {
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            const data = JSON.parse(line.slice(5).trim());
            if (event === "data") { received.push(data.id); onEvent?.(data); }
            else if (event === "Checkpoint") onCheckpoint?.(data);
            else if (event === "SessionUpdate") {
              if (data.remainingUnits <= 0 || data.remainingUnits < 400) await onLow?.(data);
            } else if (event === "SessionTerminate") terminated = data;
          }
        }
      }
    }
    return { received, terminated };
  }
}
