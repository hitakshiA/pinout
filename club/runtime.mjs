// The agent loop for a workspace.
//
// It runs server-side, not in the browser, for three reasons: the custodial key
// never leaves this process, a closed tab must not kill a job that is spending
// money, and the Pinout meter stream is not something a browser should hold.
//
// The awkward part is money. The agent cannot buy anything until a human looks
// at what it intends to spend and agrees, and that human may take minutes or
// never come back. An earlier version of this file hand-rolled that pause with
// an EventEmitter and a parked promise, which meant the conversation only
// existed in a closure: a restart, or a second run, lost the agent's plan.
//
// The SDK already models this. `requireApproval` on a tool halts the loop
// before the tool executes and persists the whole conversation through a
// StateAccessor, so the pause survives anything. Approving runs the tool.
// Rejecting hands the model an error it can re-plan from, which is why "change
// the plan" is the same mechanism as "no" and not a third code path.
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  OpenRouter, tool, serializeConversationState, deserializeConversationState,
} from "@openrouter/agent";
import { z } from "zod";
import { ROOT, env } from "../src/config.mjs";
import { pinoutTools } from "../agent/tools.mjs";
import * as ws from "./workspace.mjs";
import * as assets from "./assets.mjs";
import * as threads from "./threads.mjs";
import {
  createWorkspaceAccount, confirmFunding, balanceOf, sweepAndClose,
  CUSTODY_DISCLOSURE, MIN_FUND_TINYBAR,
} from "./wallet.mjs";

/**
 * Lane prices, so an approval can be checked rather than taken on faith.
 * Cached because it is the same answer every time and the human is waiting.
 */
let laneCache = null;
async function lanes() {
  if (laneCache) return laneCache;
  const base = env.PINOUT_URL ?? "http://localhost:4021";
  try {
    const r = await fetch(`${base}/lanes`).then((x) => x.json());
    const rows = Array.isArray(r) ? r : (r.lanes ?? []);
    laneCache = new Map(rows.map((l) => [l.lane ?? l.id ?? l.name, l]));
  } catch { laneCache = new Map(); }
  return laneCache;
}

/** Every money event should be one click from the public record. */
const NET = (env.HEDERA_NETWORK ?? "testnet").replace("hedera:", "");
export const hashscanTx = (id) =>
  id ? `https://hashscan.io/${NET}/transaction/${encodeURIComponent(id)}` : null;
export const hashscanAccount = (id) =>
  id ? `https://hashscan.io/${NET}/account/${id}` : null;

export const RUN_STATE = {
  PLANNING: "planning",
  AWAITING_APPROVAL: "awaiting_approval",
  FUNDING: "funding",
  WORKING: "working",
  DONE: "done",
  FAILED: "failed",
  CLOSED: "closed",
};

const SYSTEM = `You rent real compute and pay for it yourself over x402 on Hedera.

You have your own wallet. A human puts HBAR into it and can take HBAR out of it
at any time, including while you are working. Everything left over comes back to
them when the job ends, so money in your wallet is never money they have lost.

You do not ask permission for each purchase. You ask for HBAR when you need it,
and then you spend it as the work requires.

How to work:

1. Look before you ask. Call discover and list_inputs first, and peek_input on
   anything text that says what the job is. Read the lane catalogue and the real
   sizes of the inputs. A plan built on a guess about the data is a plan the
   human cannot judge.

2. Ask for HBAR once, for the whole job. Call request_hbar with what you intend
   to do, which lane, and roughly what you expect it to cost. Ask for enough to
   finish comfortably, because unused HBAR is refunded and being short is what
   actually costs the human their work. Do not ask for the ceiling just because
   it is there.

3. Spend it without asking again. Rent the machine, buy more seconds whenever
   the meter runs low, and keep going. Topping up a session is not a decision
   the human needs to make; it is just your wallet paying for the seconds you
   already committed to using.

4. Watch your wallet, not your session. Call wallet_balance when you want to
   know how much room you have left. If it is getting thin relative to the work
   remaining, call request_hbar again EARLY and say what you have produced so
   far. Do not wait until a session is starving: a human takes time to respond,
   and a machine whose credits run out is only held briefly before it is
   destroyed with your files on it.

5. Move inputs with stage_input, never by reading them into your context. Hand
   results back with deliver_file BEFORE you release the machine, because
   releasing destroys the filesystem.

   A chat is one continuous piece of work. list_inputs shows both what the
   human attached and what you delivered earlier, and stage_input takes either
   by name, so a later step builds on an earlier one instead of repeating it.
   If you cleaned a file in step one, stage that cleaned file in step two
   rather than the raw one.

   Match the machine to the step, not to the job. Preparation, parsing and
   cleaning belong on a CPU lane; only put the step that needs an accelerator
   on one, and release it as soon as that step is done. Holding a GPU through
   a CPU step is the most expensive mistake available to you.

6. If you do get stuck without funds, say so plainly and stop. Say what you
   produced, what it cost, what still needs doing, and how much more you need.
   Do not thrash: renting a second machine to retry the same step wastes the
   money they gave you.

7. Check your own work before you hand it over. An exit code of 0 means the
   code ran, not that the output is right. If what you produced is visual, use
   look_at to see it, and decide for yourself whether it is what was asked for.
   If it is not, fix it and look again. Do not describe a step you did not
   verify as a step that succeeded.

8. At the end, tell them what you produced and where it is, what it cost, and
   what came back as refund. Get the numbers from close_session and
   spend_report rather than estimating. Never claim you did something you did
   not do, and never present a step you did not verify as a step that
   succeeded.`;

/**
 * Say what kind of failure this was.
 *
 * Running out of money is not a crash and should not be presented as one. A
 * user who reads "error: no credits" concludes the service is broken; a user
 * who reads "paused, needs more HBAR to continue" tops up. The difference is
 * entirely in the framing, and the work sitting on the machine is the same
 * either way.
 */
function classify(e) {
  const m = String(e?.message ?? "");
  if (e?.outOfCredits || /no credits|out of credits|could not top up/i.test(m)) {
    return {
      kind: "paused_needs_funding",
      recoverable: true,
      humanMessage: "The agent ran out of HBAR partway through. Add more to its " +
                    "wallet and it can carry on from where it stopped.",
    };
  }
  if (/cancelled while waiting for funding/i.test(m)) {
    return { kind: "cancelled", recoverable: true,
             humanMessage: "Stopped while waiting for funding." };
  }
  if (/at capacity/i.test(m)) {
    return { kind: "capacity", recoverable: true,
             humanMessage: "No machine of that type was free. Nothing was charged for it." };
  }
  if (/insufficient|INSUFFICIENT_(PAYER|ACCOUNT)_BALANCE/i.test(m)) {
    return { kind: "wallet_empty", recoverable: true,
             humanMessage: "The agent's wallet is empty. Add HBAR to continue." };
  }
  return { kind: "error", recoverable: false };
}

/** One live run per workspace. */
const runs = new Map();
export function runOf(id) { return runs.get(id) ?? null; }

/**
 * Fires when a run starts, so an SSE client that subscribed first has
 * something to wait on. A browser opens the event stream and then posts the
 * task, in that order, because doing it the other way round races the first
 * few events out of existence.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Resolve with the run for this workspace, waiting if it has not started. */
export function waitForRun(workspaceId, { signal } = {}) {
  const now = runs.get(workspaceId);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const on = (r) => {
      if (r.workspaceId !== workspaceId) return;
      bus.off("run", on); resolve(r);
    };
    bus.on("run", on);
    signal?.addEventListener("abort", () => { bus.off("run", on); resolve(null); }, { once: true });
  });
}

const DIR = join(ROOT, ".club");
const stateFile = (id) => join(DIR, `conv-${id}.json`);
// keyed by chat, not workspace: each chat is its own agent with its own memory

/**
 * Conversation state on disk, so an approval pause outlives the process.
 * A run parked waiting for a human is the single most likely thing to be
 * interrupted by a deploy, and losing it would lose their money's context.
 */
function fileState(workspaceId) {
  return {
    load: async () => {
      const f = stateFile(workspaceId);
      if (!existsSync(f)) return null;
      try {
        // the SDK's own deserialiser, not JSON.parse: the blob is versioned and
        // a hand-rolled read would silently drop whatever it does not know about
        return deserializeConversationState(readFileSync(f, "utf8"));
      } catch { return null; }
    },
    save: async (s) => {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(stateFile(workspaceId), serializeConversationState(s));
    },
  };
}

export class Run extends EventEmitter {
  constructor(workspaceId, { task, ceilingTinybar, threadId = null }) {
    super();
    this.workspaceId = workspaceId;
    this.threadId = threadId;
    this.task = task;
    this.ceilingTinybar = ceilingTinybar;
    this.state = RUN_STATE.PLANNING;
    this.startedAt = Date.now();
    this.log = [];
    this.pendingApproval = null;   // {callId, ask} while a human is deciding
    this.fundingWaiter = null;     // resolves when HBAR actually lands
    this.approvals = [];           // every decision, for the receipt
    this.openSessions = new Set(); // compute sessions this run still holds
    this.abort = new AbortController();
  }

  say(type, data = {}) {
    const ev = { type, at: Date.now(), ...data };
    this.log.push(ev);
    if (this.log.length > 800) this.log.splice(0, this.log.length - 800);
    this.emit("event", ev);
    return ev;
  }

  /**
   * Emit without recording. Token deltas arrive in the thousands and are only
   * meaningful while they are arriving: a client that reconnects wants the
   * finished answer, not to watch it typed again. Keeping them out of the log
   * also stops a few seconds of streaming evicting the funding events and
   * artifacts that replay actually needs.
   */
  live(type, data = {}) {
    const ev = { type, at: Date.now(), ...data };
    this.emit("event", ev);
    return ev;
  }

  setState(s, extra = {}) {
    this.state = s;
    ws.update(this.workspaceId, { state: s });
    this.say("state", { state: s, ...extra });
  }

  /**
   * Park until the funding transfer is confirmed on chain. Called from inside
   * the approved tool, so the model is blocked here and cannot wander off and
   * try to spend money that has not arrived.
   */
  awaitFunding(needTinybar, reason) {
    this.setState(RUN_STATE.FUNDING, { needTinybar, reason });
    this.say("funding_needed", { needTinybar, reason });
    return new Promise((resolve, reject) => {
      // A run parked for money is live work, not idle. Without something
      // holding the event loop a headless process exits here while a rented
      // machine is still billing, and the exit looks exactly like success.
      // The timer is deliberately NOT unref'd for that reason.
      const hold = setInterval(() => {}, 30_000);
      const done = (fn) => (v) => { clearInterval(hold); fn(v); };

      this.fundingWaiter = done(resolve);
      this.abort.signal.addEventListener(
        "abort", () => done(reject)(new Error("run cancelled while waiting for funding")),
        { once: true }
      );
    });
  }

  fundingArrived(info) {
    this.say("funded", info);
    this.fundingWaiter?.(info);
    this.fundingWaiter = null;
  }

  cancel() { this.abort.abort(); }
}

/**
 * Tools the agent gets. Paid ones refuse until the workspace has a wallet.
 *
 * Built ONCE per run and cached on it. drive() is called again on every
 * approval, and rebuilding here handed the agent a fresh pinoutTools closure
 * each time: a new empty `rented` map and a new PinoutClient with none of the
 * session secrets. So the moment a human approved a top-up, the machine the
 * agent was working on became invisible to it. top_up answered "unauthorized"
 * because the new client had never seen that session, and the next exec said
 * "no rented machine" about a machine that was still running and still
 * billing. Both demos died here.
 */
function buildTools(run) {
  if (run.tools) return run.tools;
  const request_hbar = tool({
    name: "request_hbar",
    description:
      "Ask the human to put HBAR into your wallet. This is NOT approval for a " +
      "single purchase: once the HBAR is there you spend it as the work needs, " +
      "including buying more seconds mid job, without asking again. Anything " +
      "you do not spend is refunded to them, and they can withdraw at any time. " +
      "Ask once for the whole job, and ask again EARLY if you are running low.",
    inputSchema: z.object({
      plan: z.string().describe("What you will do with the money, in plain language"),
      lane: z.string().describe("The lane you intend to rent, e.g. gpu-t4"),
      estimatedSeconds: z.number().describe("Roughly how long you expect to hold it"),
      requestTinybar: z.number().describe("How much HBAR you are asking for, in tinybar"),
      reasoning: z.string().describe("Why this lane and this amount, and not something cheaper"),
      progressSoFar: z.string().optional()
        .describe("If this is a follow-up, what you have already produced"),
    }),
    outputSchema: z.object({
      funded: z.boolean(),
      accountId: z.string().nullable(),
      balanceTinybar: z.number(),
      note: z.string(),
    }),
    // The human approves money entering the wallet. They do not approve each
    // purchase: an agent that has to stop and ask before every top-up loses
    // the machine it is standing on while it waits for an answer.
    requireApproval: true,
    execute: async (input) => {
      // If the money is already there, take it and go.
      //
      // A human can fund the wallet before approving the ask, and with the
      // panel sitting right next to the transcript that is the natural order:
      // read the request, top the wallet up, then say yes. The tool used to
      // park regardless and wait for a transfer that had already happened, so
      // the run hung with a funded wallet on screen. Watched it sit at
      // "waiting for 0.9 HBAR" for nine minutes against a balance of 3.
      const already = threads.get(run.threadId)?.wallet;
      if (already) {
        const have = await balanceOf(already.accountId).catch(() => 0);
        if (have >= Number(input.requestTinybar)) {
          run.setState(RUN_STATE.WORKING);
          run.say("funded", {
            accountId: already.accountId, tinybar: have, alreadyHeld: true,
            hashscan: hashscanAccount(already.accountId),
          });
          return {
            funded: true, accountId: already.accountId, balanceTinybar: have,
            note: `Your wallet already holds ${(have / 1e8).toFixed(4)} HBAR, which covers this. ` +
                  `Spend it as the job needs; call wallet_balance to see what is left.`,
          };
        }
      }
      const info = await run.awaitFunding(input.requestTinybar, input.plan);
      const balance = await balanceOf(info.accountId).catch(() => 0);
      run.setState(RUN_STATE.WORKING);
      return {
        funded: true,
        accountId: info.accountId,
        balanceTinybar: balance,
        balanceHbar: Number((balance / 1e8).toFixed(8)),
        note:
          `Your wallet holds ${(balance / 1e8).toFixed(4)} HBAR (${balance} tinybar). ` +
          `Spend it as the job needs, ` +
          `including topping up sessions, without asking again. Call ` +
          `wallet_balance to check how much room is left.`,
      };
    },
  });

  const wallet_balance = tool({
    name: "wallet_balance",
    description:
      "How much HBAR is in your wallet right now, read from the network. Free. " +
      "Use it to decide whether you can afford to keep going, and call " +
      "request_hbar EARLY if the answer is thin.",
    inputSchema: z.object({}),
    execute: async () => {
      const w = threads.get(run.threadId)?.wallet;
      if (!w) return { funded: false, tinybar: 0, note: "no wallet yet, call request_hbar" };
      const tinybar = await balanceOf(w.accountId).catch(() => null);
      if (tinybar == null) return { error: "could not read the balance from the network" };
      // A bare number invites the agent to guess whether it is a lot. Say what
      // it buys on the lane it is actually renting.
      const rate = run.currentLaneRate ?? null;
      return {
        accountId: w.accountId,
        tinybar,
        hbar: Number((tinybar / 1e8).toFixed(4)),
        ...(rate ? {
          secondsAffordable: Math.floor(tinybar / rate),
          onLane: run.currentLane,
        } : {}),
        low: rate ? tinybar < rate * 60 : tinybar < 20_000_000,
      };
    },
  });

  const list_inputs = tool({
    name: "list_inputs",
    description:
      "List the files the human attached to this workspace, with sizes and " +
      "types. Free. Call this before planning: the size of the data decides " +
      "which machine the job needs.",
    inputSchema: z.object({}),
    execute: async () => {
      // Everything in this chat, including what the agent made earlier.
      //
      // These used to be separate: inputs were the human's uploads and
      // artifacts were hidden from the agent entirely. That made a multi-step
      // job impossible. Clean a file in step one, deliver it, and step two
      // cannot see the thing step one just produced, so it either redoes the
      // work or gives up. A delivered artifact is an input to whatever comes
      // next, and stage_input already accepts it by name.
      const given = assets.forWorkspace(run.workspaceId, run.threadId);
      const made = assets.artifactsOf(run.workspaceId, run.threadId);
      const shape = (a, made) => ({
        name: a.name, bytes: a.bytes, contentType: a.contentType,
        sha256: a.sha256.slice(0, 16), needsChunking: a.needsChunking,
        source: made ? "you made this earlier" : "the human attached this",
        ...(a.description ? { description: a.description } : {}),
      });
      const files = [...given.map((a) => shape(a, false)), ...made.map((a) => shape(a, true))];
      if (!files.length) return { files: [], note: "nothing is attached to this chat" };
      return {
        files,
        totalBytes: files.reduce((n, a) => n + a.bytes, 0),
        note: "stage_input puts any of these on a machine by name, including the ones " +
              "you produced earlier. Do not read them into your context.",
      };
    },
  });

  const peek_input = tool({
    name: "peek_input",
    description:
      "Read the first few hundred characters of a text input, to see its shape " +
      "before planning. Free. Binary files are not previewable: run them on a " +
      "machine instead.",
    inputSchema: z.object({ name: z.string() }),
    execute: async (a) => {
      const asset = assets.byName(run.workspaceId, a.name, run.threadId);
      if (!asset) {
        return {
          error: `no file named ${a.name} in this chat`,
          available: [
            ...assets.forWorkspace(run.workspaceId, run.threadId),
            ...assets.artifactsOf(run.workspaceId, run.threadId),
          ].map((x) => x.name),
        };
      }
      return assets.preview(asset.id);
    },
  });

  const paid = pinoutTools({
    base: env.PINOUT_URL ?? "http://localhost:4021",
    // read at call time: the wallet does not exist when these are built
    getWallet: () => threads.get(run.threadId)?.wallet ?? null,
    assets: {
      byName: (n) => assets.byName(run.workspaceId, n, run.threadId),
      list: () => [
        ...assets.forWorkspace(run.workspaceId, run.threadId),
        ...assets.artifactsOf(run.workspaceId, run.threadId),
      ],
      read: (id) => assets.read(id),
      deliver: (spec) => {
        const art = assets.deliver(run.workspaceId, { ...spec, threadId: run.threadId });
        run.say("artifact", {
          name: art.name, bytes: art.bytes, sha256: art.sha256,
          description: art.description, fromPath: art.fromPath,
        });
        return art;
      },
    },
    onSessionOpen: (id, lane) => {
      run.openSessions.add(id);
      if (lane) {
        run.currentLane = lane;
        lanes().then((c) => { run.currentLaneRate = c.get(lane)?.tinybarPerSecond ?? null; });
      }
    },
    onSessionClose: (id) => run.openSessions.delete(id),
    maxPerCallTinybar: Math.min(run.ceilingTinybar, 2_000_000_000),
    budgetTinybar: run.ceilingTinybar,
  });

  run.tools = [request_hbar, wallet_balance, list_inputs, peek_input, ...paid];
  return run.tools;
}

/**
 * Drive the conversation until it either finishes or stops for a human.
 * Every entry point (start, approve, reject) funnels through here so there is
 * one place that knows how a turn ends.
 */
async function drive(run, { input, approveToolCalls, rejectToolCalls }) {
  const or = new OpenRouter({ apiKey: env.OPENROUTER_API_KEY });

  const result = or.callModel({
    model: env.CLUB_MODEL ?? env.AGENT_MODEL ?? "deepseek/deepseek-chat-v3.1",
    instructions: SYSTEM,
    input,
    tools: buildTools(run),
    state: fileState(run.threadId ?? run.workspaceId),
    ...(approveToolCalls ? { approveToolCalls } : {}),
    ...(rejectToolCalls ? { rejectToolCalls } : {}),
  });

  // A UI that only receives finished events can only draw a spinner. These
  // three streams are what let it show the agent thinking, calling something,
  // and composing an answer, in the order those things actually happen.
  //
  // Consumed concurrently on purpose: the SDK multiplexes one underlying
  // stream to several readers, so this costs nothing extra.

  // the model's reasoning, token by token
  (async () => {
    try {
      let seq = 0;
      for await (const delta of result.getReasoningStream()) {
        if (delta) run.live("reasoning", { delta, seq: seq++ });
      }
    } catch { /* not every model emits reasoning */ }
  })();

  // the answer as it is written, so text can type itself out
  (async () => {
    try {
      let seq = 0;
      for await (const delta of result.getTextStream()) {
        if (delta) run.live("text", { delta, seq: seq++ });
      }
    } catch { /* stream ends with the turn */ }
  })();

  // Tool calls stream out as they happen so the UI shows work, not a spinner.
  (async () => {
    try {
      for await (const c of result.getToolCallsStream()) {
        run.say("tool", {
          name: c.name,
          args: JSON.stringify(c.arguments ?? c.input ?? {}).slice(0, 600),
        });
      }
    } catch { /* stream ends with the turn */ }
  })();

  // And their RESULTS.
  //
  // Only calls were streamed before, so when a tool failed the agent could see
  // why and nobody else could. A run ended with the agent reporting "the
  // service is having issues" and the log showed nothing but the call that
  // provoked it, which made the one error that mattered the only thing not
  // written down. A chat log that shows what was attempted but never what came
  // back cannot be debugged by the user either.
  (async () => {
    try {
      for await (const ev of result.getFullResponsesStream()) {
        const out = ev?.result ?? ev?.output ?? null;
        if (!out || !/tool/i.test(ev.type ?? "")) continue;
        const text = typeof out === "string" ? out : JSON.stringify(out);
        // The SDK surfaces each result twice: once as the tool's own result and
        // again wrapped as the function_call_output item sent back to the model.
        // They carry identical payloads, so the wrapper is noise in a chat log.
        if (text.startsWith('{"type":"function_call_output"')) continue;
        const failed = /"error"|outOfCredits|"status":\s*[45]\d\d/.test(text);
        run.say(failed ? "tool_failed" : "tool_result", {
          name: ev.name ?? ev.toolName ?? "?",
          result: text.slice(0, 700),
        });
      }
    } catch { /* stream ends with the turn */ }
  })();

  const text = await result.getText().catch((e) => {
    // An approval pause is not a failure, it is the design working.
    if (/approval|pending/i.test(e?.message ?? "")) return "";
    throw e;
  });

  const needsApproval = await Promise.resolve(result.requiresApproval?.()).catch(() => false);
  const pending = (await Promise.resolve(result.getPendingToolCalls?.()).catch(() => null)) ?? [];
  const waiting = pending.find((p) => p.name === "request_hbar")
    ?? (needsApproval ? pending[0] : null);

  if (waiting) {
    const ask = waiting.arguments ?? waiting.input ?? {};
    run.pendingApproval = { callId: waiting.callId ?? waiting.id, ask };
    run.setState(RUN_STATE.AWAITING_APPROVAL);

    // Check the ask against the price list instead of relaying it. An agent
    // asked for "300 seconds" of a T4 on the first run here and requested
    // enough tinybar for 60. Both numbers were in the same sentence and neither
    // was wrong on its own, which is exactly the kind of thing a human skims
    // past. So say plainly what the money buys.
    const catalogue = await lanes();
    const rate = catalogue.get(ask.lane)?.tinybarPerSecond ?? null;
    const req = Number(ask.requestTinybar ?? 0);

    // An agent asked to be funded for lane "local" here. No such lane is for
    // sale, and because an unknown lane has no rate, every arithmetic check
    // below silently passed and the human was shown a tidy request to buy a
    // machine that does not exist. Nobody should be asked to approve that, so
    // it is refused here rather than escalated: it is a machine-checkable
    // mistake, not a judgement call.
    if (catalogue.size && !catalogue.has(ask.lane)) {
      run.badLaneAttempts = (run.badLaneAttempts ?? 0) + 1;
      const real = [...catalogue.keys()].join(", ");
      run.say("bad_lane", { lane: ask.lane, attempt: run.badLaneAttempts, available: real });

      if (run.badLaneAttempts > 2) {
        throw new Error(`agent kept asking for lanes that do not exist (last: ${ask.lane})`);
      }
      const callId = waiting.callId ?? waiting.id;
      run.pendingApproval = null;
      return await drive(run, {
        input: [{ role: "user", content:
          `There is no lane called "${ask.lane}". The lanes actually for sale are: ` +
          `${real}. Call discover to read the catalogue and their prices, then ask ` +
          `again for a real one.` }],
        rejectToolCalls: [callId],
      });
    }
    const covers = rate ? Math.floor(req / rate) : null;
    const claimed = Number(ask.estimatedSeconds ?? 0);

    // The account floor is Hedera's, not the job's, and the human is the one
    // being asked to send it. Show the number that will actually leave their
    // wallet, not the number the agent asked for.
    const firstFunding = !threads.get(run.threadId)?.wallet;
    const transfer = firstFunding ? Math.max(req, MIN_FUND_TINYBAR) : req;

    run.say("approval_needed", {
      callId: run.pendingApproval.callId,
      ...ask,
      ceilingTinybar: run.ceilingTinybar,
      overCeiling: req > run.ceilingTinybar,
      transferTinybar: transfer,
      accountFloorApplied: transfer > req,
      laneTinybarPerSecond: rate,
      secondsCovered: covers,
      shortOfClaim: covers != null && claimed > 0 && covers < claimed * 0.9
        ? `asks for ${claimed}s but the amount covers about ${covers}s`
        : null,
      options: ["approve", "deny", "revise"],
    });
    return { parked: true };
  }

  if (text) {
    run.say("answer", { text });
    ws.appendMessage(run.workspaceId, { role: "assistant", text });
  }
  return { parked: false, text };
}

/** Start a run. Returns immediately; progress arrives as run events. */
export async function startRun(workspaceId, { task, ceilingTinybar, budgetTinybar, threadId = null }) {
  const ceiling = ceilingTinybar ?? budgetTinybar;
  if (runs.has(workspaceId)) throw new Error("this workspace already has a run in progress");
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  if (!(ceiling > 0)) throw new Error("set a spending ceiling in tinybar");
  if (ceiling > CUSTODY_DISCLOSURE.maxTinybar) {
    throw new Error(`ceiling above what this build will custody (${CUSTODY_DISCLOSURE.maxTinybar})`);
  }

  const run = new Run(workspaceId, { task, ceilingTinybar: ceiling, threadId });
  runs.set(workspaceId, run);
  bus.emit("run", run);

  (async () => {
    try {
      run.say("task", { task, ceilingTinybar: ceiling });
      const out = await drive(run, { input: [{ role: "user", content: task }] });
      if (!out.parked) await finish(run);
    } catch (e) {
      // Say what survived, not just what broke.
      //
      // A run that delivered everything asked for and then tripped while
      // tidying up is not the same event as one that produced nothing, and
      // reporting both as "failed" makes the good outcome unreadable. The
      // state stays honest; the artifacts are carried alongside it so a client
      // can tell the two apart.
      const delivered = assets.artifactsOf(workspaceId, run.threadId)
        .map((a) => ({ name: a.name, bytes: a.bytes, sha256: a.sha256 }));
      run.say("error", { message: e.message, ...classify(e), delivered });
      run.setState(RUN_STATE.FAILED, {
        message: e.message, ...classify(e),
        delivered,
        deliveredCount: delivered.length,
        partial: delivered.length > 0,
      });
      runs.delete(workspaceId);
    }
  })();

  return run;
}

/**
 * The human's verdict on a funding request.
 *
 * approve  -> the tool runs, and blocks until the transfer lands
 * deny     -> the model is told no and can wrap up or propose something else
 * revise   -> the same rejection, plus what to do differently
 */
export async function decide(workspaceId, { verdict, feedback }) {
  const run = runs.get(workspaceId);
  if (!run) throw new Error("no run in progress");
  if (!run.pendingApproval) throw new Error("nothing is waiting for approval");

  const { callId, ask } = run.pendingApproval;
  run.approvals.push({ at: Date.now(), verdict, feedback, ask });
  run.pendingApproval = null;
  run.say("decision", { verdict, feedback, callId });

  const go = async (args) => {
    const out = await drive(run, args);
    if (!out.parked) await finish(run);
  };

  if (verdict === "approve") {
    run.setState(RUN_STATE.FUNDING);
    // drive() resumes the tool, which parks inside awaitFunding until the
    // transfer is confirmed. Deliberately not awaited: the caller is an HTTP
    // request and the human still has to sign.
    go({ input: [], approveToolCalls: [callId] }).catch((e) => {
      run.say("error", { message: e.message });
      run.setState(RUN_STATE.FAILED, { message: e.message });
    });
    return { approved: true, awaitingTransfer: true, needTinybar: ask.requestTinybar };
  }

  const note = verdict === "revise"
    ? `The human did not approve that plan. They said: ${feedback ?? "(no reason given)"}. ` +
      `Re-plan around it and ask again with different reasoning.`
    : `The human denied funding.${feedback ? ` They said: ${feedback}` : ""} ` +
      `Do not ask again unless you have something materially different to propose. ` +
      `Tell them what you would have done and stop.`;

  run.setState(RUN_STATE.PLANNING);
  go({
    input: [{ role: "user", content: note }],
    rejectToolCalls: [callId],
  }).catch((e) => {
    run.say("error", { message: e.message });
    run.setState(RUN_STATE.FAILED, { message: e.message });
  });

  return { approved: false, verdict };
}

/**
 * Confirm the funding transfer and release the parked tool.
 * The amount is never taken on trust from the browser.
 */
export async function applyFunding(workspaceId, { funderAccountId, expectTinybar, threadId }) {
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  const run = runs.get(workspaceId);
  const tid = threadId ?? run?.threadId;
  if (!tid) throw new Error("funding needs a chat: money belongs to a task, not an account");
  const t = threads.get(tid);
  if (!t || t.workspaceId !== workspaceId) throw new Error("no such chat");

  if (t.funder && t.funder !== funderAccountId) {
    throw new Error(`this chat's wallet returns to ${t.funder} and cannot be funded from elsewhere`);
  }

  if (!t.wallet) {
    const acct = await createWorkspaceAccount({ funderAccountId, initialTinybar: expectTinybar });
    threads.setWallet(tid, acct, funderAccountId);
    // marked spent so a later top-up cannot be "confirmed" by this deposit
    for (const id of [acct.openingTxId, acct.openingTxMirrorId]) threads.noteFundingTx(tid, id);
    threads.addLedgerEntry(tid, {
      kind: "wallet_opened", tinybar: acct.fundedTinybar,
      accountId: acct.accountId, from: funderAccountId,
      txId: acct.openingTxId, hashscan: hashscanTx(acct.openingTxId),
    });
    run?.fundingArrived({
      accountId: acct.accountId, tinybar: acct.fundedTinybar, opened: true,
      requestedTinybar: acct.requestedTinybar, hashscan: hashscanTx(acct.openingTxId),
    });
    return { accountId: acct.accountId, opened: true, tinybar: acct.fundedTinybar,
             hashscan: hashscanTx(acct.openingTxId) };
  }

  const seen = await confirmFunding({
    accountId: t.wallet.accountId, funderAccountId, expectTinybar,
    consumedTxIds: t.fundingTxIds ?? [],
  });
  if (!seen.ok) return { pending: true };
  threads.noteFundingTx(tid, seen.txId);
  threads.addLedgerEntry(tid, {
    kind: "funded", tinybar: seen.amount, from: funderAccountId,
    txId: seen.txId, hashscan: hashscanTx(seen.txId),
  });
  run?.fundingArrived({
    accountId: t.wallet.accountId, tinybar: seen.amount, txId: seen.txId,
    hashscan: hashscanTx(seen.txId),
  });
  return { accountId: t.wallet.accountId, txId: seen.txId, tinybar: seen.amount,
           hashscan: hashscanTx(seen.txId) };
}

/** Settle up once the model has nothing left to say. */
async function finish(run) {
  const w = ws.get(run.workspaceId);
  const left = w?.wallet ? await balanceOf(w.wallet.accountId).catch(() => null) : null;
  run.say("balance", { tinybar: left });
  const delivered = assets.artifactsOf(run.workspaceId, run.threadId)
    .map((a) => ({ name: a.name, bytes: a.bytes, sha256: a.sha256 }));
  run.setState(RUN_STATE.DONE, {
    remainingTinybar: left,
    remainingHbar: left == null ? null : Number((left / 1e8).toFixed(8)),
    approvals: run.approvals, delivered, deliveredCount: delivered.length,
  });
  runs.delete(run.workspaceId);
}

/** Close: stop the run, sweep the balance home, delete the account. */
/**
 * Close one chat: settle what it holds, sweep its wallet home, delete it.
 *
 * Ordering is the whole thing. The compute server refunds unused seconds by
 * transferring to the buyer, and the buyer is this chat's account, so deleting
 * it first makes every one of those refunds fail ACCOUNT_DELETED forever, on a
 * sweep that retries and can never succeed. Sessions close, then the wallet.
 */
export async function closeChat(threadId) {
  const t = threads.get(threadId);
  if (!t) throw new Error("no such chat");
  const run = runs.get(t.workspaceId);
  const mine = run?.threadId === threadId;
  if (mine) { run.cancel(); runs.delete(t.workspaceId); }

  const closed = [];
  if (mine && run?.openSessions?.size) {
    const base = env.PINOUT_URL ?? "http://localhost:4021";
    for (const sessionId of run.openSessions) {
      try {
        const r = await fetch(`${base}/session/${sessionId}/close?cause=chat-closed`,
          { method: "POST" });
        closed.push({ sessionId, ok: r.ok });
      } catch (e) { closed.push({ sessionId, ok: false, error: e.message }); }
    }
  }

  let swept = null;
  if (t.wallet) {
    swept = await sweepAndClose(t.wallet).catch((e) => ({ closed: false, error: e.message }));
    if (swept?.closed) {
      threads.addLedgerEntry(threadId, {
        kind: "swept", tinybar: swept.returnedTinybar, to: swept.to,
      });
    }
    threads.setWallet(threadId, null, t.funder);
  }
  return { swept, sessionsClosed: closed };
}

/** Close a workspace: every chat's wallet goes home, then the workspace shuts. */
export async function closeWorkspace(workspaceId) {
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  runs.get(workspaceId)?.cancel();
  runs.delete(workspaceId);

  const chats = [];
  for (const t of threads.forWorkspace(workspaceId)) {
    if (!t.wallet) continue;
    const out = await closeChat(t.id).catch((e) => ({ error: e.message }));
    chats.push({ chatId: t.id, ...out });
  }
  ws.update(workspaceId, { state: "closed", wallet: null, closedAt: Date.now(), chats });
  return { chats, swept: chats.map((c) => c.swept).filter(Boolean) };
}
