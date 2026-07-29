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

// A machine the agent is holding, keyed by session id, so it survives across
// tool calls. Renting is only useful if the agent can come back to the machine.
const rented = new Map();

function machineOr404(sessionId) {
  const m = rented.get(sessionId);
  if (!m) {
    throw new Error(
      `no rented machine ${sessionId}. Rent one with rent_machine({lane:"cpu-small"}) ` +
      `— and note that machines you released are gone.`);
  }
  return m;
}

  const rent_machine = tool({
    name: "rent_machine",
    description:
      "Rent a real machine by the second and KEEP IT while you work on it. " +
      "Unlike run_compute (which runs one script and gives the machine back), " +
      "this holds the machine so you can run code, look at the result, decide " +
      "what to do next, put files on it and take files off it — all on the same " +
      "filesystem, with state carried between steps. You are billed per second " +
      "you hold it, so release it when you are done and the unused seconds are " +
      "refunded on-chain. ALWAYS call release_machine when finished.",
    inputSchema: z.object({
      lane: z.string().optional().describe("cpu-small (1 vCPU), cpu-4 (4 vCPU/8GiB), gpu-t4, gpu-a100-80. Default cpu-small"),
      maxSeconds: z.number().optional().describe("hard ceiling on seconds held, default 300"),
    }),
    execute: async (a) => {
      const lane = a.lane ?? "cpu-small";
      const m = await client.rent(lane, { maxSeconds: a.maxSeconds ?? 300 });
      rented.set(m.sessionId, m);
      return {
        sessionId: m.sessionId, lane, secondsPurchased: m.secondsPurchased,
        youCanNow: ["exec", "upload_file", "download_file", "list_files"],
        remember: "the meter is running until you call release_machine",
      };
    },
  });

  const exec = tool({
    name: "exec",
    description:
      "Run Python on a machine you are already renting. The filesystem and any " +
      "files you wrote persist between calls, so you can build up work step by " +
      "step. Returns stdout, stderr and the exit code — a non-zero exit means " +
      "your code failed, and stderr will say why.",
    inputSchema: z.object({
      sessionId: z.string(),
      code: z.string().describe("Python 3 source. Print what you want to see."),
    }),
    execute: async (a) => {
      const m = machineOr404(a.sessionId);
      const r = await m.exec(a.code);
      return {
        exitCode: r.exitCode, ms: r.ms,
        ...clipOutput(r.stdout ?? ""),
        stderr: (r.stderr ?? "").slice(0, 4000),
        secondsHeldSoFar: m.secondsUsed,
      };
    },
  });

  const upload_file = tool({
    name: "upload_file",
    description:
      "Put a file onto a machine you are renting, so your code can read it. " +
      "Give either text or base64 for binary. Parent directories are created.",
    inputSchema: z.object({
      sessionId: z.string(),
      path: z.string().describe("absolute path on the machine, e.g. /work/input.csv"),
      text: z.string().optional().describe("text content"),
      contentBase64: z.string().optional().describe("base64 for binary content"),
    }),
    execute: async (a) => {
      const m = machineOr404(a.sessionId);
      if (a.text === undefined && a.contentBase64 === undefined) {
        return { error: "give either text or contentBase64" };
      }
      const buf = a.contentBase64 !== undefined
        ? Buffer.from(a.contentBase64, "base64")
        : Buffer.from(a.text, "utf8");
      return await m.upload(a.path, buf);
    },
  });

  const download_file = tool({
    name: "download_file",
    description:
      "Take a file OFF a machine you are renting — a result, a trained model, a " +
      "generated dataset. The content is checked against its sha256 in transit, " +
      "so a truncated or corrupted read is an error rather than silently wrong data.",
    inputSchema: z.object({
      sessionId: z.string(),
      path: z.string().describe("absolute path on the machine"),
      asText: z.boolean().optional().describe("return text instead of base64, default true when it decodes cleanly"),
    }),
    execute: async (a) => {
      const m = machineOr404(a.sessionId);
      const buf = await m.download(a.path);
      const text = buf.toString("utf8");
      const printable = !text.includes("\u0000") && Buffer.from(text, "utf8").equals(buf);
      if (a.asText === false || !printable) {
        return { path: a.path, bytes: buf.length, binary: true,
                 contentBase64: buf.toString("base64").slice(0, 200_000) };
      }
      return { path: a.path, bytes: buf.length, ...clipOutput(text, 8000) };
    },
  });

  const list_files = tool({
    name: "list_files",
    description: "List a directory on a machine you are renting.",
    inputSchema: z.object({ sessionId: z.string(), dir: z.string().optional() }),
    execute: async (a) => {
      const m = machineOr404(a.sessionId);
      return await m.ls(a.dir ?? "/work");
    },
  });

  const release_machine = tool({
    name: "release_machine",
    description:
      "Give the machine back and stop the meter. Unused seconds are refunded " +
      "on-chain immediately. Anything on its filesystem is gone, so download " +
      "what you need first.",
    inputSchema: z.object({ sessionId: z.string(), cause: z.string().optional() }),
    execute: async (a) => {
      const m = machineOr404(a.sessionId);
      const out = await m.release(a.cause ?? "work-finished");
      rented.delete(a.sessionId);
      return {
        secondsHeld: m.secondsUsed,
        consumedTinybar: out.consumedAmount, refundTinybar: out.refundAmount,
        topUpsPurchased: m.topUps, refundTx: out.refundTxUrl,
      };
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

  return [discover, open_session, rent_machine, exec, upload_file, download_file, list_files,
          release_machine, run_compute, top_up, stream, close_session, verify_session, spend_report];
}
