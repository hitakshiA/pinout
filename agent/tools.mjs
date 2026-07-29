// Pinout exposed as Agent SDK tools. Deliberately thin wrappers over the same
// client a human would use — no special affordances for the model.
import { tool } from "@openrouter/agent";
import { z } from "zod";
import { PinoutClient } from "../src/client.mjs";
import { verifySession } from "../src/verifier.mjs";
import { env } from "../src/config.mjs";

/**
 * Truncating a job's stdout in the MIDDLE of a line, with no marker, made a
 * completed 150-iteration job look like a crashed one: the agent read the
 * severed final line as proof the work had stopped early and reported the
 * service as broken. Results are almost always printed at the END, so keep the
 * head and the tail and say plainly what was dropped.
 */
function clipOutput(text, limit = 6000) {
  if (text.length <= limit) return { stdout: text };
  const head = Math.floor(limit * 0.25), tail = limit - head;
  return {
    stdout: text.slice(0, head) +
      `\n\n… [${text.length - limit} characters omitted from the middle — ` +
      `this is a display limit, NOT the end of the job] …\n\n` +
      text.slice(-tail),
    stdoutTruncated: true,
    stdoutTotalChars: text.length,
  };
}

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
    description: "Close a session. Refunds unused credits on-chain immediately; the settlement anchor is recorded separately (batched by default).",
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

  const top_up = tool({
    name: "top_up",
    description:
      "Buy more seconds for a session you already have, on-chain, WITHOUT losing " +
      "the machine or the job running on it. Use this when a job runs out of " +
      "credits: the machine is held for a short grace period, and topping up " +
      "resumes the SAME process exactly where it paused. Opening a new session " +
      "instead throws away the work already paid for.",
    inputSchema: z.object({ sessionId: z.string() }),
    execute: async (a) => {
      const r = await client.topUp(a.sessionId);
      return { credits: r.credits, paidTinybar: r.paidTinybar ?? r.amountPaid,
               paymentTx: r.paymentTxUrl ?? r.paymentTx,
               note: "the job resumes on the same machine, from where it paused" };
    },
  });

  const run_compute = tool({
    name: "run_compute",
    description:
      "Run Python on the machine you rented. REQUIRES a session opened with a " +
      "compute lane (open_session({lane:'cpu-small'})) — a token-billed session " +
      "cannot run code. You are billed per SECOND the machine is held; it is " +
      "released the moment your code finishes and unused seconds are refunded. " +
      "If the session runs out of credits mid-job the machine is HELD, not killed, " +
      "and (unless autoTopUp is false) more seconds are bought automatically so the " +
      "job continues uninterrupted. Print your answer to stdout.",
    inputSchema: z.object({
      sessionId: z.string(),
      code: z.string().describe("Python 3 source. Print results to stdout."),
      maxSeconds: z.number().optional().describe("hard ceiling on seconds held, default 120"),
      autoTopUp: z.boolean().optional().describe("buy more seconds if the job outlives its credits, default true"),
    }),
    execute: async (a) => {
      // Uses the shared client rather than a private SSE parser. The old
      // hand-rolled loop read only `data` frames, so SessionPaused,
      // SessionWaiting and SessionTerminate were invisible: when credits ran
      // out the agent saw the stream simply stop and concluded the job had
      // finished. It could not discover that topping up would resume it, and
      // opened a whole new session instead — paying twice and abandoning work.
      const stdout = []; let seconds = 0, coldStartMs = null;
      let paused = 0, resumed = 0, topUps = 0, topUpError = null;
      let out;
      try {
        out = await client.stream(a.sessionId, {
          n: a.maxSeconds ?? 120, provider: "compute", code: a.code,
          onEvent: (e) => {
            seconds++;
            if (e.coldStartMs !== undefined) coldStartMs = e.coldStartMs;
            if (e.stdout) stdout.push(e.stdout);
          },
          onPaused: async () => {
            paused++;
            if (a.autoTopUp === false || topUps >= 3) return;
            try { await client.topUp(a.sessionId); topUps++; }
            catch (e) { topUpError = e.message; }
          },
          onResumed: () => { resumed++; },
        });
      } catch (e) {
        return { error: e.message, secondsBilled: seconds,
                 ...clipOutput(stdout.join("\n")),
                 hint: "if this session was not opened with a compute lane, open a new one: open_session({lane:'cpu-small'})" };
      }
      const log = received.get(a.sessionId) ?? [];
      for (const e of out.received) log.push(e);
      received.set(a.sessionId, log);
      return {
        secondsBilled: seconds, coldStartMs,
        ranOutOfCredits: paused > 0,
        topUpsPurchased: topUps, resumedAfterTopUp: resumed,
        ...(topUpError ? { topUpFailed: topUpError } : {}),
        terminated: out.terminated?.cause ?? null,
        ...clipOutput(stdout.join("\n")),
        note: "You were charged only for the seconds above. Time spent paused with " +
              "zero credits is not billed. Unused credits are refunded when you close.",
      };
    },
  });

  return [discover, open_session, run_compute, top_up, stream, close_session, verify_session, spend_report];
}
