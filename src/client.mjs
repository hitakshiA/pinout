// Pinout client — pays x402 402 challenges, consumes the SSE stream, and
// tops up mid-stream without dropping the connection.
//
// Spend safety, modelled on @vybenetwork/x402-client:
//   maxPerCallTinybar — refuses to sign a challenge above this, BEFORE signing
//   budgetTinybar     — cumulative cap across the whole client
// Both throw before any signature exists, so no funds are ever at risk from a
// mispriced or injected 402.
import { createHash } from "node:crypto";
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
    this.secrets = new Map();    // sessionId -> bearer secret, issued once at mint
    this.thresholds = new Map(); // sessionId -> remaining units at which to top up
    this.lanes = new Map();      // sessionId -> compute lane, so top-ups price correctly
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
    if (first.status !== 402) {
      const body = await first.json().catch(() => ({}));
      // A non-402, non-OK first response is a refusal (503 at capacity, 400 bad
      // lane, 404 unknown). Returning it quietly made refusals look like
      // successes to callers — a test of mine miscounted 3 refusals as opens.
      if (!first.ok) {
        const err = new Error(body.error ?? `request failed ${first.status}`);
        err.status = first.status;
        err.detail = body.detail;
        err.body = body;
        throw err;
      }
      return { paid: false, res: first, body };
    }

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
  /** Rent a machine on a priced lane. The lane is committed in the 402. */
  async openComputeSession(lane = "cpu-small") {
    const out = this.#withSettlement(await this.pay(`/compute/${lane}`));
    if (out.sessionSecret) this.secrets.set(out.sessionId, out.sessionSecret);
    if (out.topUpAtSecondsRemaining) this.thresholds.set(out.sessionId, out.topUpAtSecondsRemaining);
    if (out.lane) this.lanes.set(out.sessionId, out.lane);
    return out;
  }
  async topUp(sessionId, lane) {
    const l = lane ?? this.lanes.get(sessionId);
    const path = l ? `/topup/${l}/${sessionId}` : `/session/${sessionId}/topup`;
    return this.#withSettlement(await this.pay(path, { headers: this.#auth(sessionId) }));
  }
  /**
   * Close writes an on-chain settlement anchor and then a refund, so it is
   * legitimately slower than a normal request. The default fetch timeout is
   * too short for it.
   */
  /**
   * Current server-side view of a session: state, credits, burned.
   * Every real integration needs this — "how much do I have left?" should not
   * require hand-rolling a fetch with the right bearer header.
   */
  async status(sessionId) {
    const secret = this.secrets.get(sessionId);
    const r = await fetch(`${this.base}/session/${sessionId}`,
      secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(body.error ?? `status ${r.status}`); e.status = r.status; throw e; }
    return body;
  }

  /**
   * Rent a machine and work on it.
   *
   * The returned handle holds a real machine for the seconds you bought: run
   * code, look at the result, decide what to do next, put files on it, take
   * artifacts off it, then release it and get the unused seconds back. The
   * background stream is the rental clock — it is what bills you per second and
   * what the on-chain burn ledger records.
   *
   *   const m = await client.rent("cpu-4");
   *   await m.upload("/tmp/in.csv", buf);
   *   const r = await m.exec("import pandas as pd; ...");
   *   const out = await m.download("/tmp/out.parquet");
   *   await m.release();
   */
  async rent(lane = "cpu-small", { maxSeconds = 600, autoTopUp = true, onTick } = {}) {
    const s = await this.openComputeSession(lane);
    const id = s.sessionId;
    let ticks = 0, paused = false, topUps = 0;
    const streamDone = this.stream(id, {
      n: maxSeconds, provider: "compute", hold: true,
      onEvent: () => { ticks++; onTick?.(ticks); },
      onPaused: async () => {
        paused = true;
        if (!autoTopUp || topUps >= 5) return;
        try { await this.topUp(id); topUps++; } catch { /* surfaced on next call */ }
      },
      onResumed: () => { paused = false; },
    }).catch((e) => ({ error: e }));

    // The machine is not usable until it has actually been provisioned; the
    // first tick is the signal that it is up.
    const upBy = Date.now() + 180_000;
    while (ticks === 0 && Date.now() < upBy) await new Promise((r) => setTimeout(r, 250));
    if (ticks === 0) {
      await this.close(id, "provision-timeout").catch(() => {});
      throw new Error("machine did not come up within 180s");
    }

    const call = async (path, init, timeoutMs = 630_000) => {
      // Explicit timeout: undici's default surfaces a hung exec as a bare
      // "fetch failed" with no indication that the machine is still rented and
      // still billing.
      let r;
      try {
        r = await fetch(`${this.base}/session/${id}${path}`, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { ...this.#auth(id), "Content-Type": "application/json", ...(init?.headers ?? {}) },
        });
      } catch (e) {
        const err = new Error(
          `${path} failed after ${Math.round(timeoutMs / 1000)}s: ${e.message}. ` +
          `The machine is STILL RENTED and still billing — call release() to stop the meter and be refunded.`);
        err.cause = e; err.stillRented = true;
        throw err;
      }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(body.error ?? `${r.status}`); e.status = r.status; e.detail = body.detail; throw e; }
      return body;
    };

    return {
      sessionId: id, lane, secondsPurchased: s.credits,
      get secondsUsed() { return ticks; },
      get paused() { return paused; },
      get topUps() { return topUps; },
      exec: (code) => call("/exec", { method: "POST", body: JSON.stringify({ code }) }),
      upload: (path, buf) => call("/files", { method: "POST",
        body: JSON.stringify({ path, contentBase64: Buffer.from(buf).toString("base64") }) }),
      download: async (path) => {
        const b = await call(`/files?path=${encodeURIComponent(path)}`);
        const buf = Buffer.from(b.contentBase64, "base64");
        // Verify in transit rather than trusting the length field.
        const got = createHash("sha256").update(buf).digest("hex");
        if (got !== b.sha256) throw new Error(`download corrupted: sha mismatch for ${path}`);
        return buf;
      },
      ls: (dir = "/tmp") => call(`/files?dir=${encodeURIComponent(dir)}`),
      status: () => this.status(id),
      topUp: () => this.topUp(id),
      release: async (cause = "work-finished") => {
        const out = await this.close(id, cause);
        await streamDone;
        return out;
      },
    };
  }

  async close(sessionId, cause, { timeoutMs = 120000, settlement } = {}) {
    const q = new URLSearchParams();
    if (cause) q.set("cause", cause);
    // 'priority' buys an immediate dedicated anchor; default is batched.
    if (settlement) q.set("settlement", settlement);
    const r = await fetch(
      `${this.base}/session/${sessionId}/close${q.toString() ? `?${q}` : ""}`,
      { method: "POST", headers: this.#auth(sessionId), signal: AbortSignal.timeout(timeoutMs) }
    );
    return r.json();
  }

  /**
   * Consume the SSE stream. Records every event id so the bill can be
   * recomputed independently later. Fires onLow when the balance crosses
   * the top-up threshold — the socket is NOT dropped to top up.
   */
  async stream(sessionId, { n = 500, provider, code, prompt, onEvent, onLow, onCheckpoint,
                            onPaused, onResumed, onWaiting, hold = false } = {}) {
    const q = new URLSearchParams({ n: String(n) });
    if (provider) q.set("provider", provider);
    if (hold) q.set("hold", "1");
    if (prompt) q.set("prompt", prompt);
    // Arbitrary source is base64'd so quoting and newlines survive the URL.
    // Large payloads must be staged in a body; a long query string is reset by
    // the server before it can be rejected politely.
    if (code && Buffer.byteLength(code, "utf8") > 8000) {
      const r = await fetch(`${this.base}/session/${sessionId}/code`, {
        method: "POST",
        headers: { ...this.#auth(sessionId), "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) throw new Error(`stage code failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else if (code) {
      q.set("code", Buffer.from(code, "utf8").toString("base64"));
    }
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
              // The server tells us where the line is (topUpAtSecondsRemaining);
              // a hardcoded 400 fires immediately on a 120-second session and
              // never fires on a large one.
              const line = this.thresholds.get(sessionId) ?? 400;
              if (data.remainingUnits <= line) await onLow?.(data);
            } else if (event === "SessionPaused") {
              // The machine is held, not billing. Top up and the SAME job continues.
              onPaused?.(data);
              await onLow?.({ ...data, remainingUnits: 0 });
            } else if (event === "SessionWaiting") {
              // Grace ticking down while we wait for a top-up. Not billed.
              onWaiting?.(data);
            } else if (event === "SessionResumed") {
              onResumed?.(data);
            } else if (event === "SessionTerminate") terminated = data;
          }
        }
      }
    }
    return { received, terminated };
  }
}
