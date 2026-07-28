// Pinout exposed as Agent SDK tools. Deliberately thin wrappers over the same
// client a human would use — no special affordances for the model.
import { tool } from "@openrouter/agent";
import { z } from "zod";
import { PinoutClient } from "../src/client.mjs";
import { verifySession } from "../src/verifier.mjs";
import { env } from "../src/config.mjs";

export function pinoutTools({ base = env.PINOUT_URL ?? "http://localhost:4021" } = {}) {
  const client = new PinoutClient({ base, maxPerCallTinybar: 5_000_000, budgetTinybar: 100_000_000 });
  const received = new Map();

  const discover = tool({
    name: "discover",
    description: "Look up what this service sells and what it charges. Free, no payment required.",
    inputSchema: z.object({}),
    execute: async () => {
      const [d, b] = await Promise.all([
        fetch(`${base}/`).then((r) => r.json()),
        fetch(`${base}/bazaar`).then((r) => r.json()).catch(() => null),
      ]);
      return {
        service: d.service, network: d.network, asset: d.asset, pricing: d.pricing,
        ledger: d.ledger, facilitator: d.facilitator,
        catalog: b?.items?.map((i) => ({
          url: i.resource.url, description: i.resource.description,
          amount: i.accepts[0].amount, asset: i.accepts[0].asset,
        })),
      };
    },
  });

  const open_session = tool({
    name: "open_session",
    description:
      "Open a prepaid session by paying a real x402 micropayment in HBAR. " +
      "Pass a compute lane (see discover) to rent a MACHINE billed per second — " +
      "that is what run_compute needs. Omit lane for a token-billed data stream.",
    inputSchema: z.object({
      lane: z.string().optional()
        .describe("compute lane e.g. cpu-small. Omit for token-billed streaming."),
    }),
    execute: async (a) => {
      // A compute lane is a different priced route; the lane is committed in
      // the 402 the buyer signs, so it cannot be chosen later.
      const s = a.lane
        ? await client.openComputeSession(a.lane)
        : await client.openSession();
      received.set(s.sessionId, []);
      return {
        sessionId: s.sessionId, lane: s.lane ?? "token", unit: s.unit,
        credits: s.credits ?? s.secondsPurchased,
        pricePerUnitTinybar: s.pricePerSecondTinybar ?? s.pricePerEventTinybar,
        provider: s.provider,
        maxSessionDurationSeconds: s.maxSessionDurationSeconds,
        paymentTx: s.paymentTx, settledOnChain: s.settledOnChain,
        ...(a.lane ? { next: "call run_compute with this sessionId and your Python code" } : {}),
      };
    },
  });

  const stream = tool({
    name: "stream",
    description: "Consume events from an open session, burning one credit per event. If autoTopUp is true, buys more credits on-chain when the balance runs low without dropping the stream.",
    inputSchema: z.object({
      sessionId: z.string(),
      n: z.number().optional().describe("events to consume, default 300"),
      provider: z.enum(["llm", "mirror"]).optional(),
      autoTopUp: z.boolean().optional(),
    }),
    execute: async (a) => {
      const events = []; let topUps = 0;
      const { terminated } = await client.stream(a.sessionId, {
        n: a.n ?? 300, provider: a.provider,
        onEvent: (e) => events.push(e),
        onLow: async () => {
          if (a.autoTopUp === false || topUps >= 3) return;
          await client.topUp(a.sessionId); topUps++;
        },
      });
      const log = received.get(a.sessionId) ?? [];
      for (const e of events) log.push(e.id);
      received.set(a.sessionId, log);
      return {
        delivered: events.length, topUpsPurchased: topUps,
        terminated: terminated?.cause ?? null,
        totalReceivedThisSession: log.length,
        sample: events.slice(0, 5).map((e) => e.token ?? e.name ?? e.id),
      };
    },
  });

  const close_session = tool({
    name: "close_session",
    description: "Close a session. Writes the settlement anchor on-chain, then refunds unused credits.",
    inputSchema: z.object({ sessionId: z.string(), cause: z.string().optional() }),
    execute: async (a) => {
      const r = await client.close(a.sessionId, a.cause);
      return {
        consumedTinybar: r.consumedAmount, refundTinybar: r.refundAmount,
        settlementTx: r.settlementTx, refundTx: r.refundTxUrl,
        anchorFeeTinybar: r.settlementFeeTinybar,
        burnCheckpoints: r.burnCheckpoints,
      };
    },
  });

  const verify_session = tool({
    name: "verify_session",
    description: "Independently recompute the bill from the public Hedera mirror node and compare it against the events actually received. Use this to check you were billed correctly.",
    inputSchema: z.object({ sessionId: z.string() }),
    execute: async (a) => {
      const r = await verifySession(a.sessionId, received.get(a.sessionId) ?? null);
      return {
        verdict: r.verdict, ledgerBurned: r.ledgerBurned, checkpoints: r.checkpoints,
        failures: r.failures, note: r.note, feeTerms: r.feeTerms,
        checks: r.checks?.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.check}: ${c.detail}`),
      };
    },
  });

  const spend_report = tool({
    name: "spend_report",
    description: "How much this agent has spent on-chain so far and what budget remains.",
    inputSchema: z.object({}),
    execute: async () => ({
      spentTinybar: client.spent, budgetTinybar: client.budget,
      remainingTinybar: client.budget - client.spent, account: client.accountId,
    }),
  });

  const run_compute = tool({
    name: "run_compute",
    description:
      "Run Python on the machine you rented. REQUIRES a session opened with a " +
      "compute lane (open_session({lane:'cpu-small'})) — a token-billed session " +
      "cannot run code. You are billed per SECOND the machine is held; it is " +
      "released the moment your code finishes and unused seconds are refunded. " +
      "Print your answer to stdout.",
    inputSchema: z.object({
      sessionId: z.string(),
      code: z.string().describe("Python 3 source. Print results to stdout."),
      maxSeconds: z.number().optional().describe("hard ceiling on seconds held, default 120"),
    }),
    execute: async (a) => {
      const q = new URLSearchParams({
        n: String(a.maxSeconds ?? 120), provider: "compute",
        code: Buffer.from(a.code, "utf8").toString("base64"),
      });
      const secret = client.secrets.get(a.sessionId);
      const res = await fetch(`${base}/session/${a.sessionId}/stream?${q}`,
        { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
      if (!res.ok) {
        return { error: `stream ${res.status}`, detail: (await res.text()).slice(0, 300),
                 hint: "if this session was not opened with a compute lane, open a new one: open_session({lane:'cpu-small'})" };
      }

      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = "", ev = null, seconds = 0, coldStartMs = null;
      const stdout = []; const log = received.get(a.sessionId) ?? [];
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();
        for (const chunk of parts) for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            const d = JSON.parse(line.slice(5).trim());
            if (ev === "data") {
              seconds++; log.push(d.id);
              if (d.coldStartMs !== undefined) coldStartMs = d.coldStartMs;
              if (d.stdout) stdout.push(d.stdout);
            }
          }
        }
      }
      received.set(a.sessionId, log);
      return {
        secondsBilled: seconds, coldStartMs,
        stdout: stdout.join("\n").slice(0, 6000),
        note: "You were charged for the seconds above. Unused credits are refunded when you close the session.",
      };
    },
  });

  return [discover, open_session, run_compute, stream, close_session, verify_session, spend_report];
}
