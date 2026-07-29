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

/**
 * @param accountId/privateKey  pay from a specific wallet rather than the
 *        operator's. pinout.club gives every workspace its own custodial
 *        account, so without this every workspace would spend the host's money.
 */
export function pinoutTools({
  base = env.PINOUT_URL ?? "http://localhost:4021",
  accountId, privateKey, getWallet, assets, onSessionOpen, onSessionClose,
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
      onSessionOpen?.(s.sessionId);
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
        spentTinybar: client.spent, budgetTinybar: client.budget,
        remainingTinybar: client.budget - client.spent, account: client.accountId,
        funded: true,
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
      maxSeconds: z.number().optional().describe("hard ceiling on seconds held, default 300"),
    }),
    execute: async (a) => {
      const lane = a.lane ?? "cpu-1";
      const m = await pinout().rent(lane, { maxSeconds: a.maxSeconds ?? 300 });
      rented.set(m.sessionId, m);
      onSessionOpen?.(m.sessionId);
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
      onSessionClose?.(a.sessionId);
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
      "Copy a file the human attached to this workspace onto a machine you are " +
      "renting. Use this for every input file. You never need to read the " +
      "contents yourself, and doing so would waste your context.",
    inputSchema: z.object({
      sessionId: z.string(),
      name: z.string().describe("the input's filename, as shown by list_inputs"),
      destPath: z.string().describe("absolute path on the machine, e.g. /work/data.csv"),
    }),
    execute: async (a) => {
      if (!assets) return { error: "this workspace has no attached inputs" };
      const asset = assets.byName(a.name);
      if (!asset) {
        return {
          error: `no input named ${a.name}`,
          available: assets.list().map((x) => x.name),
        };
      }
      if (asset.needsChunking) {
        return {
          error: `${a.name} is ${asset.bytes} bytes, over the ${32 * 1024 * 1024} byte ` +
                 `single-upload cap. Split it or process it in parts.`,
        };
      }
      const buf = assets.read(asset.id);
      const m = machineOr404(a.sessionId);
      const r = await m.upload(a.destPath, buf);
      return { ...r, stagedBytes: buf.length, sha256: asset.sha256, path: a.destPath };
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

  return [discover, open_session, rent_machine, exec, upload_file, download_file, list_files,
          stage_input, deliver_file,
          release_machine, run_compute, top_up, stream, close_session, verify_session, spend_report];
}
