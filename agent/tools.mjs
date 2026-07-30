// Pinout exposed as Agent SDK tools. Deliberately thin wrappers over the same
// client a human would use — no special affordances for the model.
import { tool } from "@openrouter/agent";
import { z } from "zod";
import { PinoutClient } from "../src/client.mjs";
import { verifySession } from "../src/verifier.mjs";
import { env } from "../src/config.mjs";
import { look, isVisual } from "./vision.mjs";

/**
 * Truncating a job's stdout in the MIDDLE of a line, with no marker, made a
 * completed 150-iteration job look like a crashed one: the agent read the
 * severed final line as proof the work had stopped early and reported the
 * service as broken. Results are almost always printed at the END, so keep the
 * head and the tail and say plainly what was dropped.
 */
/**
 * Report money in both units.
 *
 * An agent told only "18,960,000 tinybar" wrote "18.96 HBAR" in its receipt to
 * the user. It had divided by a million instead of a hundred million. Its own
 * arithmetic on the tinybar was correct throughout; the only wrong number was
 * the one a person would actually read. Doing the conversion here removes the
 * chance to get it wrong.
 */
function money(tinybar) {
  const t = Number(tinybar ?? 0);
  return { tinybar: t, hbar: Number((t / 1e8).toFixed(8)) };
}

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

/**
 * @param accountId/privateKey  pay from a specific wallet rather than the
 *        operator's. pinout.club gives every workspace its own custodial
 *        account, so without this every workspace would spend the host's money.
 */
export function pinoutTools({
  base = env.PINOUT_URL ?? "http://localhost:4021",
  accountId, privateKey, getWallet, assets, onSessionOpen, onSessionClose, onMoney,
  maxPerCallTinybar = 5_000_000,
  budgetTinybar = 100_000_000,
} = {}) {
  // The client is built on first paid use, not here.
  //
  // PinoutClient falls back to env.HEDERA_PRIVATE_KEY when it is handed no key,
  // which is the operator's own wallet. A hosted workspace builds its tools
  // before the user has funded anything, so an eager client would quietly sign
  // with the host's key and spend the host's money on a stranger's job. Nothing
  // paid can be reached until a wallet actually exists.
  let client = null;
  function pinout() {
    if (client) return client;
    const w = getWallet ? getWallet() : { accountId, privateKey };
    if (getWallet && !(w?.accountId && w?.privateKey)) {
      throw new Error(
        "this workspace has no wallet yet. Call request_funding and wait for the " +
        "human to approve it before trying to buy anything."
      );
    }
    client = new PinoutClient({
      base, accountId: w?.accountId ?? accountId, privateKey: w?.privateKey ?? privateKey,
      maxPerCallTinybar, budgetTinybar,
      onPayment: (p) => onMoney?.({ kind: "payment", ...p }),
    });
    return client;
  }
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
      "Use this ONLY for a one-shot job you will run with run_compute, or " +
      "(with no lane) for a token-billed data stream. " +
      "If you want to run several commands, move files, and keep state between " +
      "them, call rent_machine instead and do NOT call this first. Both hold a " +
      "machine and count against capacity, so opening one of each for the same " +
      "lane pays twice and can lock you out of the accelerator you just bought.",
    inputSchema: z.object({
      lane: z.string().optional()
        .describe("compute lane, e.g. cpu-1 or gpu-t4. Call discover for the real " +
                  "catalogue and prices. Omit for a token-billed stream."),
    }),
    execute: async (a) => {
      // A compute lane is a different priced route; the lane is committed in
      // the 402 the buyer signs, so it cannot be chosen later.
      const s = a.lane
        ? await pinout().openComputeSession(a.lane)
        : await pinout().openSession();
      received.set(s.sessionId, []);
      onSessionOpen?.(s.sessionId, a.lane);
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
      const { terminated } = await pinout().stream(a.sessionId, {
        n: a.n ?? 300, provider: a.provider,
        onEvent: (e) => events.push(e),
        onLow: async () => {
          if (a.autoTopUp === false || topUps >= 3) return;
          await pinout().topUp(a.sessionId); topUps++;
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
      const r = await pinout().close(a.sessionId, a.cause);
      onSessionClose?.(a.sessionId);
      const refunded = Number(r.refundAmount ?? 0);
      if (refunded > 0) {
        onMoney?.({ kind: "refund", tinybar: refunded, hashscan: r.refundTxUrl ?? null });
      }
      const anchor = Number(r.settlementFeeTinybar ?? 0);
      if (anchor > 0) {
        onMoney?.({ kind: "anchor", tinybar: anchor, hashscan: r.settlementTxUrl ?? null });
      }
      return {
        consumed: money(r.consumedAmount),
        refund: money(r.refundAmount),
        consumedTinybar: r.consumedAmount, refundTinybar: r.refundAmount,
        settlementTx: r.settlementTx, refundTx: r.refundTxUrl,
        anchorFeeTinybar: r.settlementFeeTinybar,
        burnCheckpoints: r.burnCheckpoints,
        note: "quote the hbar figures to the human; do not convert tinybar yourself",
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
    // Asking what you have spent must never be the thing that fails. Before a
    // wallet exists the honest answer is "nothing yet", not an error.
    execute: async () => {
      if (!client) {
        return {
          spentTinybar: 0, budgetTinybar, remainingTinybar: budgetTinybar,
          account: null, funded: false,
          note: "no wallet on this workspace yet, so nothing has been spent",
        };
      }
      return {
        spent: money(client.spent),
        budget: money(client.budget),
        remaining: money(client.budget - client.spent),
        account: client.accountId, funded: true,
        note: "quote the hbar figures to the human; do not convert tinybar yourself",
      };
    },
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
      // Prefer the machine handle. It owns the paused/starved state for a
      // rented session, and topping up around it leaves that state stale.
      const held = rented.get(a.sessionId);
      const r = held ? await held.topUp() : await pinout().topUp(a.sessionId);
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
      `no rented machine ${sessionId}. Rent one with rent_machine({lane:"cpu-1"}) ` +
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
      lane: z.string().optional().describe(
        "cpu-1, cpu-2, cpu-4, gpu-t4, gpu-l4, gpu-a10, gpu-l40s, gpu-a100-80, " +
        "gpu-h200, gpu-b200, gpu-b300. These are the only lanes that exist; " +
        "call discover for prices. Default cpu-1. Rent ONE machine and reuse " +
        "it; do not also call open_session for the same lane."),
      maxSeconds: z.number().optional().describe(
        "seconds to buy up front, default 900. Buy generously: unused seconds " +
        "are refunded on release, so over-buying costs nothing and running out " +
        "mid-job costs the whole job."),
    }),
    execute: async (a) => {
      const lane = a.lane ?? "cpu-1";
      const m = await pinout().rent(lane, { maxSeconds: a.maxSeconds ?? 900 });
      rented.set(m.sessionId, m);
      // the wall clock only matters at the moment work is being done, so it is
      // recorded here and reported on every exec rather than only at rent time
      m._rentedAt = Date.now();
      m._ceiling = m.maxSessionDurationSeconds ?? null;
      m._rate = m.pricePerSecondTinybar ?? null;
      onSessionOpen?.(m.sessionId, lane);
      // A machine has a wall clock, and an agent that does not know it plans a
      // job it cannot finish. One ran 31 exec calls across three machines,
      // each torn down at the ceiling with its filesystem, re-staging and
      // starting over every time and paying for the same work three times. It
      // was not looping stupidly; nobody had told it how long it had.
      const ceiling = m.maxSessionDurationSeconds ?? null;
      return {
        sessionId: m.sessionId, lane, secondsPurchased: m.secondsPurchased,
        ...(ceiling ? {
          machineLifetimeSeconds: ceiling,
          planWithin:
            `This machine is destroyed ${ceiling} seconds after its last activity, ` +
            `and its filesystem goes with it. Anything not delivered by then is ` +
            `lost and you will pay to redo it. If the job will not fit, split it: ` +
            `deliver what you have with deliver_file, release, and rent again. ` +
            `A delivered file is an input you can stage back onto the next machine.`,
        } : {}),
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
      let r;
      try {
        r = await m.exec(a.code);
      } catch (e) {
        // Running out of money mid-job is a normal event, not a crash. Say so
        // in terms the agent can act on, and be explicit that the work is not
        // lost, or it will assume the machine is gone and start over on a
        // fresh one it also has to pay for.
        if (e.outOfCredits) {
          return {
            outOfCredits: true,
            sessionId: a.sessionId,
            error: e.message,
            whatToDo:
              "Your machine is still held and your files are intact. Call " +
              "request_funding with what you still need and why, saying what " +
              "you have already produced. When the human funds it, call top_up " +
              "on this same sessionId and carry on. Do NOT rent a second machine.",
          };
        }
        throw e;
      }
      // The server has its own way of saying the same thing. /exec answers a
      // credit-less session with a plain error rather than throwing, so the
      // client-side branch above never sees it and the agent got the bare
      // string with no idea it was recoverable. Both paths mean "ask for more
      // money", so both should say so.
      if (r?.error && /no credits|out of credits|insufficient credit/i.test(r.error)) {
        return {
          outOfCredits: true,
          sessionId: a.sessionId,
          error: r.error,
          whatToDo:
            "Your machine is still held and your files are intact. Call " +
            "request_funding with what you still need and why, saying what you " +
            "have already produced. When the human funds it, call top_up on " +
            "this same sessionId and carry on. Do NOT rent a second machine.",
        };
      }
      // Surface the runway, not just the elapsed time. An agent told only how
      // long it has been running has to remember what it bought to know how
      // close it is to the edge, and it does not; it runs to zero and loses the
      // machine during the grace period while a human reads its funding request.
      const bought = m.secondsPurchased ?? 0;
      const left = Math.max(0, bought - m.secondsUsed);
      const low = bought > 0 && left <= Math.max(20, Math.floor(bought * 0.25));

      // Two clocks run, and only one of them is about money.
      //
      // Credits can be topped up; the machine's lifetime cannot. When it
      // expires the filesystem goes with it, and an agent told about it only
      // at rent time has long since stopped thinking about it. A job was
      // watched losing three machines this way, re-staging and redoing work it
      // had already paid for, because nothing warned it at the moment it was
      // still able to act.
      const age = m._rentedAt ? Math.floor((Date.now() - m._rentedAt) / 1000) : null;
      const life = m._ceiling ?? null;
      const lifeLeft = life != null && age != null ? Math.max(0, life - age) : null;
      const dying = lifeLeft != null && lifeLeft <= Math.max(120, Math.floor(life * 0.2));
      // Say what has not happened yet.
      //
      // A traced run made 48 exec calls on one machine and delivered nothing.
      // Not one of them processed the input: every single call read frame 0 of
      // the video and compared segmentation models on it. The agent was not
      // iterating on a result, it was still choosing an approach, forty-eight
      // calls in, which is why telling it to stop polishing had no effect.
      //
      // A count it cannot argue with lands where instructions do not.
      const runs = m._execs = (m._execs ?? 0) + 1;
      const delivered = m._delivered ?? 0;

      // Put the price on every call.
      //
      // Being told once that the meter is running does not survive twenty tool
      // calls. An agent was watched inventorying packages, re-probing the same
      // file with two libraries and benchmarking five models before starting
      // work that takes three minutes, and a warning in its instructions did
      // not change that at all. A number attached to the thing it just did
      // might: this call cost that much, and you have spent this much so far.
      const rate = m._rate ?? null;
      const thisCall = rate ? Math.round((r.ms / 1000) * rate) : null;
      const spent = client ? client.spent : null;
      return {
        exitCode: r.exitCode, ms: r.ms,
        ...clipOutput(r.stdout ?? ""),
        stderr: (r.stderr ?? "").slice(0, 4000),
        ...(thisCall != null ? {
          thisCallCostHbar: Number((thisCall / 1e8).toFixed(6)),
        } : {}),
        ...(spent != null ? {
          spentSoFarHbar: Number((spent / 1e8).toFixed(4)),
        } : {}),
        execsOnThisMachine: runs,
        filesDelivered: delivered,
        ...(runs >= 6 && delivered === 0 ? {
          nothingDeliveredYet: true,
          stopExploring:
            `${runs} calls on this machine and nothing delivered. Whatever you ` +
            `are still comparing, pick one and run it over the WHOLE input now, ` +
            `then deliver_file the result. If a sample looked acceptable, it is ` +
            `acceptable. A delivered result you would improve later beats a ` +
            `perfect one nobody receives, and the meter has been running for ` +
            `all ${runs} of these.`,
        } : {}),
        secondsHeldSoFar: m.secondsUsed,
        secondsRemaining: left,
        ...(lifeLeft != null ? { machineLifetimeRemaining: lifeLeft } : {}),
        ...(dying ? {
          machineExpiringSoon: true,
          actNow:
            `This machine has about ${lifeLeft}s of life left, and topping up ` +
            `credits will not extend it. Deliver whatever is usable NOW with ` +
            `deliver_file. Anything still only on the filesystem is lost when ` +
            `it goes, and you will pay to produce it again. If the job needs ` +
            `more time, deliver, release, rent a fresh machine and stage your ` +
            `delivered file back onto it to carry on from where you stopped.`,
        } : {}),
        ...(low ? {
          runningLow: true,
          warning:
            `Only ~${left}s left of the ${bought}s you bought. Call request_funding NOW, ` +
            `before you hit zero. Once credits run out the machine is held only ` +
            `briefly, and if the human has not approved by then it is destroyed ` +
            `with your files on it.`,
        } : {}),
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
      onSessionClose?.(a.sessionId);
      const back = Number(out.refundAmount ?? 0);
      if (back > 0) {
        onMoney?.({ kind: "refund", tinybar: back, hashscan: out.refundTxUrl ?? null });
      }
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
      "compute lane (open_session({lane:'cpu-1'})) — a token-billed session " +
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
        out = await pinout().stream(a.sessionId, {
          n: a.maxSeconds ?? 120, provider: "compute", code: a.code,
          onEvent: (e) => {
            seconds++;
            if (e.coldStartMs !== undefined) coldStartMs = e.coldStartMs;
            if (e.stdout) stdout.push(e.stdout);
          },
          onPaused: async () => {
            paused++;
            if (a.autoTopUp === false || topUps >= 3) return;
            try { await pinout().topUp(a.sessionId); topUps++; }
            catch (e) { topUpError = e.message; }
          },
          onResumed: () => { resumed++; },
        });
      } catch (e) {
        return { error: e.message, secondsBilled: seconds,
                 ...clipOutput(stdout.join("\n")),
                 hint: "if this session was not opened with a compute lane, open a new one: open_session({lane:'cpu-1'})" };
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

  /**
   * Staging a workspace input onto a machine WITHOUT it passing through the
   * model's context. upload_file needs the agent to hand over base64, which
   * means a 40 MB input would have to be read into the prompt to be moved four
   * feet. The bytes never leave the server here; the agent only names the file.
   */
  const stage_input = tool({
    name: "stage_input",
    description:
      "Copy a file from this chat onto a machine you are renting. Works for " +
      "files the human attached AND for files you delivered earlier in this " +
      "chat, so a later step can build on an earlier one without redoing it. " +
      "Call list_inputs to see what is available. You never need to read the " +
      "contents yourself, and doing so would waste your context.",
    inputSchema: z.object({
      sessionId: z.string(),
      name: z.string().describe("the input's filename, as shown by list_inputs"),
      destPath: z.string().describe("absolute path on the machine, e.g. /work/data.csv"),
    }),
    execute: async (a) => {
      if (!assets) return { error: "this chat has no files" };
      const asset = assets.byName(a.name);
      if (!asset) {
        return {
          error: `no file named ${a.name} in this chat`,
          available: assets.list().map((x) => x.name),
        };
      }
      const buf = assets.read(asset.id);
      const m = machineOr404(a.sessionId);

      // Big files go in pieces and are joined on the machine.
      //
      // The single-upload cap is 32 MiB. The asset store accepts 512 MB, so a
      // 200 MB video was accepted, listed, and then refused at the machine with
      // a message telling the agent to split it, which it had no tool to do.
      // Accepting a file and then having no way to use it is worse than
      // refusing it, so the chunking happens here rather than being someone
      // else's problem.
      const CAP = 32 * 1024 * 1024;
      if (buf.length <= CAP) {
        const r = await m.upload(a.destPath, buf);
        return { ...r, stagedBytes: buf.length, sha256: asset.sha256, path: a.destPath };
      }

      const parts = Math.ceil(buf.length / CAP);
      for (let i = 0; i < parts; i++) {
        await m.upload(`${a.destPath}.part${i}`, buf.subarray(i * CAP, (i + 1) * CAP));
      }
      // join, verify against the hash we hold, and clean up the pieces
      const join = await m.exec(
        `import hashlib, os
` +
        `parts = ${parts}
` +
        `dest = ${JSON.stringify(a.destPath)}
` +
        `h = hashlib.sha256()
` +
        `with open(dest, "wb") as out:
` +
        `    for i in range(parts):
` +
        `        p = f"{dest}.part{i}"
` +
        `        with open(p, "rb") as f:
` +
        `            while True:
` +
        `                b = f.read(1 << 20)
` +
        `                if not b: break
` +
        `                out.write(b); h.update(b)
` +
        `        os.remove(p)
` +
        `print(h.hexdigest())
`
      );
      const got = (join.stdout ?? "").trim().split("\n").pop();
      if (got !== asset.sha256) {
        return {
          error: `staged ${a.name} in ${parts} parts but the joined file does not match: ` +
                 `expected ${asset.sha256.slice(0, 16)}, got ${String(got).slice(0, 16)}`,
        };
      }
      return {
        ok: true, stagedBytes: buf.length, parts, sha256: asset.sha256, path: a.destPath,
        note: `staged in ${parts} pieces and rejoined on the machine; the hash matches`,
      };
    },
  });

  /**
   * The other direction, and the one that was missing entirely: getting a
   * result back to the human. download_file pulls bytes into the agent's
   * context, which is fine for a number in a text file and useless for a 40 MB
   * checkpoint. This takes the file off the machine and files it as a workspace
   * artifact the human can download, and hands the agent back only a receipt.
   */
  const deliver_file = tool({
    name: "deliver_file",
    description:
      "Give a file on the machine back to the human as a finished result. Use " +
      "this for anything they asked for: trained weights, a cleaned dataset, a " +
      "report, a chart. The bytes go straight to them without passing through " +
      "your context, so this works for large files. Do this BEFORE you release " +
      "the machine, because the filesystem is destroyed when you do.",
    inputSchema: z.object({
      sessionId: z.string(),
      path: z.string().describe("absolute path on the machine, e.g. /work/model.pt"),
      name: z.string().optional().describe("what to call it for the human"),
      description: z.string().optional().describe("one line on what this file is"),
    }),
    execute: async (a) => {
      if (!assets?.deliver) return { error: "this workspace cannot accept deliveries" };
      const m = machineOr404(a.sessionId);
      const got = await m.download(a.path);
      const buf = Buffer.isBuffer(got) ? got : Buffer.from(got.content ?? got, "base64");
      m._delivered = (m._delivered ?? 0) + 1;
      const art = assets.deliver({
        name: a.name ?? a.path.split("/").pop(),
        bytes: buf,
        description: a.description ?? null,
        fromPath: a.path,
        sessionId: a.sessionId,
      });
      return {
        delivered: true, name: art.name, bytes: art.bytes,
        sha256: art.sha256.slice(0, 16),
        note: "the human can download this now. it survives releasing the machine.",
      };
    },
  });

  const look_at = tool({
    name: "look_at",
    description:
      "Look at an image or a video on a machine you are renting and get back a " +
      "description of what is actually in the pixels. Videos are sampled across " +
      "their whole length, not just the first frame. This is the only way you " +
      "can see; an exit code of 0 tells you the code ran, not that the output " +
      "is right.",
    inputSchema: z.object({
      sessionId: z.string(),
      path: z.string().describe("absolute path on the machine, e.g. /work/out.mp4"),
      question: z.string().optional()
        .describe("something specific to check, e.g. 'is a person visible?'"),
    }),
    execute: async (a) => {
      const m = machineOr404(a.sessionId);
      const got = await m.download(a.path);
      const buf = Buffer.isBuffer(got) ? got : Buffer.from(got.content ?? got, "base64");
      try {
        return await look(buf, a.path, a.question);
      } catch (e) {
        return { looked: false, error: e.message, bytes: buf.length };
      }
    },
  });

  /**
   * Read a document, spreadsheet or recording well enough to work with it.
   *
   * look_at handles pixels. Everything else was reachable only by the agent
   * writing its own extraction code, which meant guessing at a library and
   * usually picking the slow one. The choices here are the ones the benchmarks
   * support: PyMuPDF for PDF text because it is roughly ten times faster than
   * pdfplumber, MarkItDown for office formats because it covers the long tail
   * cheaply, and faster-whisper for audio because CTranslate2 with int8 is the
   * clear winner on a GPU, which is what this machine already is.
   *
   * It runs on the rented machine rather than the server: the dependencies are
   * heavy, the buyer is already paying for compute, and a document worth
   * reading is usually one they want processed anyway.
   */
  const read_document = tool({
    name: "read_document",
    description:
      "Extract the text and structure of a file on a machine you are renting: " +
      "PDF, Word, PowerPoint, Excel, HTML, EPUB, or an audio recording, which " +
      "is transcribed. Use this instead of writing your own parser. For images " +
      "and video use look_at.",
    inputSchema: z.object({
      sessionId: z.string(),
      path: z.string().describe("absolute path on the machine, e.g. /work/report.pdf"),
      maxChars: z.number().optional().describe("how much to return, default 24000"),
    }),
    execute: async (a) => {
      const m = machineOr404(a.sessionId);
      const cap = a.maxChars ?? 24_000;
      const code = `
import os, sys, subprocess, json
p = ${JSON.stringify(a.path)}
cap = ${cap}
ext = os.path.splitext(p)[1].lower()

def pip(*pkgs):
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *pkgs],
                   capture_output=True)

out = {"path": p, "ext": ext}
try:
    if ext == ".pdf":
        try: import fitz
        except ImportError:
            pip("pymupdf"); import fitz
        d = fitz.open(p)
        out["pages"] = d.page_count
        text = []
        for i, page in enumerate(d):
            text.append(f"--- page {i+1} ---")
            text.append(page.get_text())
            if sum(len(t) for t in text) > cap: 
                out["truncatedAtPage"] = i + 1
                break
        out["text"] = "\\n".join(text)[:cap]
    elif ext in (".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus"):
        try: from faster_whisper import WhisperModel
        except ImportError:
            pip("faster-whisper"); from faster_whisper import WhisperModel
        import torch
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        model = WhisperModel("base", device=dev, compute_type="int8")
        segs, info = model.transcribe(p)
        out["language"] = info.language
        out["durationSeconds"] = round(info.duration, 1)
        out["device"] = dev
        parts = []
        for s in segs:
            parts.append(f"[{s.start:.1f}s] {s.text.strip()}")
            if sum(len(x) for x in parts) > cap: break
        out["text"] = "\\n".join(parts)[:cap]
    else:
        try: from markitdown import MarkItDown
        except ImportError:
            pip("markitdown[all]"); from markitdown import MarkItDown
        r = MarkItDown().convert(p)
        out["text"] = (r.text_content or "")[:cap]
        if r.title: out["title"] = r.title
    out["chars"] = len(out.get("text", ""))
except Exception as e:
    out["error"] = f"{type(e).__name__}: {e}"
print("<<<DOC>>>" + json.dumps(out))
`;
      const r = await m.exec(code);
      const raw = (r.stdout ?? "");
      const i = raw.lastIndexOf("<<<DOC>>>");
      if (i === -1) {
        return { error: "extraction produced no result", stderr: (r.stderr ?? "").slice(0, 800) };
      }
      try {
        const parsed = JSON.parse(raw.slice(i + 9));
        return { ...parsed, ms: r.ms };
      } catch {
        return { error: "could not parse the extraction result", raw: raw.slice(-600) };
      }
    },
  });

  return [discover, open_session, rent_machine, exec, upload_file, download_file, list_files,
          stage_input, deliver_file, look_at, read_document,
          release_machine, run_compute, top_up, stream, close_session, verify_session, spend_report];
}
