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

You have no money until a human gives you some. Nothing you can buy will work
before that, and trying will fail with a clear error.

How to work:

1. Look before you ask. Call discover and list_inputs first, and peek_input on
   anything text that tells you what the job is. Read the lane catalogue and the
   real sizes of the inputs. A plan built on a guess about the data is a plan
   the human cannot judge.

2. Work out what the job needs, then ask for it once. Call request_funding with
   a real plan: which lane, how many seconds, what that costs, and why that lane
   rather than a cheaper one. A human reads this and decides. Ask for what the
   job needs plus a sensible margin, not for the whole ceiling.

3. If they say no, or say change it, you get told why. Re-plan properly. Do not
   ask again for the same thing with the same reasoning.

4. Once funded, rent the machine and do the work. Move inputs onto it with
   stage_input, never by reading them into your own context. Then, BEFORE you
   release the machine, hand back everything the human asked for with
   deliver_file. Releasing destroys the filesystem, and a result you did not
   deliver is a result they paid for and did not get.

   Release when you are done. The meter runs until you do, and thinking time is
   billed at the same rate as computing.

5. If you run out mid job, call request_funding again. The machine is held, not
   destroyed, and your files and processes survive a top-up. Say what you have
   already produced so the human knows what they are protecting.

6. At the end, tell the human three things: what you produced and where it is,
   what it cost, and what came back as refund. Get the numbers from
   close_session and spend_report rather than estimating them, and say so if
   they disagree with what you expected. Never claim you did something you did
   not do.`;

/** One live run per workspace. */
const runs = new Map();
export function runOf(id) { return runs.get(id) ?? null; }

const DIR = join(ROOT, ".club");
const stateFile = (id) => join(DIR, `conv-${id}.json`);

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
  constructor(workspaceId, { task, ceilingTinybar }) {
    super();
    this.workspaceId = workspaceId;
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

/** Tools the agent gets. Paid ones refuse until the workspace has a wallet. */
function buildTools(run) {
  const request_funding = tool({
    name: "request_funding",
    description:
      "Ask the human to fund this workspace so you can buy compute. Use this " +
      "before your first purchase, and again if you run out mid job. A human " +
      "reads your plan and approves, denies, or tells you to change it. " +
      "Explain your reasoning: they are deciding whether to spend real money.",
    inputSchema: z.object({
      plan: z.string().describe("What you will do with the machine, in plain language"),
      lane: z.string().describe("The lane you intend to rent, e.g. gpu-l4"),
      estimatedSeconds: z.number().describe("How long you expect to hold it"),
      requestTinybar: z.number().describe("How much you are asking for, in tinybar"),
      reasoning: z.string().describe("Why this lane and this amount, and not something cheaper"),
    }),
    outputSchema: z.object({
      funded: z.boolean(),
      accountId: z.string().nullable(),
      balanceTinybar: z.number(),
      note: z.string(),
    }),
    // The whole point: never runs without a human saying yes.
    requireApproval: true,
    execute: async (input) => {
      const info = await run.awaitFunding(input.requestTinybar, input.plan);
      const balance = await balanceOf(info.accountId).catch(() => 0);
      run.setState(RUN_STATE.WORKING);
      return {
        funded: true,
        accountId: info.accountId,
        balanceTinybar: balance,
        note:
          `Funded with ${info.tinybar} tinybar. This wallet is yours for this ` +
          `workspace. Spend it on the job and release what you rent.`,
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
      const list = assets.forWorkspace(run.workspaceId);
      if (!list.length) return { inputs: [], note: "the human attached no files" };
      return {
        inputs: list.map((a) => ({
          name: a.name, bytes: a.bytes, contentType: a.contentType,
          sha256: a.sha256.slice(0, 16), needsChunking: a.needsChunking,
        })),
        totalBytes: list.reduce((n, a) => n + a.bytes, 0),
        note: "use stage_input to put these on a machine. Do not read them into your context.",
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
      const asset = assets.byName(run.workspaceId, a.name);
      if (!asset) {
        return {
          error: `no input named ${a.name}`,
          available: assets.forWorkspace(run.workspaceId).map((x) => x.name),
        };
      }
      return assets.preview(asset.id);
    },
  });

  const paid = pinoutTools({
    base: env.PINOUT_URL ?? "http://localhost:4021",
    // read at call time: the wallet does not exist when these are built
    getWallet: () => ws.get(run.workspaceId)?.wallet ?? null,
    assets: {
      byName: (n) => assets.byName(run.workspaceId, n),
      list: () => assets.forWorkspace(run.workspaceId),
      read: (id) => assets.read(id),
      deliver: (spec) => {
        const art = assets.deliver(run.workspaceId, spec);
        run.say("artifact", {
          name: art.name, bytes: art.bytes, sha256: art.sha256,
          description: art.description, fromPath: art.fromPath,
        });
        return art;
      },
    },
    onSessionOpen: (id) => run.openSessions.add(id),
    onSessionClose: (id) => run.openSessions.delete(id),
    maxPerCallTinybar: Math.min(run.ceilingTinybar, 2_000_000_000),
    budgetTinybar: run.ceilingTinybar,
  });

  return [request_funding, list_inputs, peek_input, ...paid];
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
    state: fileState(run.workspaceId),
    ...(approveToolCalls ? { approveToolCalls } : {}),
    ...(rejectToolCalls ? { rejectToolCalls } : {}),
  });

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

  const text = await result.getText().catch((e) => {
    // An approval pause is not a failure, it is the design working.
    if (/approval|pending/i.test(e?.message ?? "")) return "";
    throw e;
  });

  const needsApproval = await Promise.resolve(result.requiresApproval?.()).catch(() => false);
  const pending = (await Promise.resolve(result.getPendingToolCalls?.()).catch(() => null)) ?? [];
  const waiting = pending.find((p) => p.name === "request_funding")
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
    const firstFunding = !ws.get(run.workspaceId)?.wallet;
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
export async function startRun(workspaceId, { task, ceilingTinybar, budgetTinybar }) {
  const ceiling = ceilingTinybar ?? budgetTinybar;
  if (runs.has(workspaceId)) throw new Error("this workspace already has a run in progress");
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  if (!(ceiling > 0)) throw new Error("set a spending ceiling in tinybar");
  if (ceiling > CUSTODY_DISCLOSURE.maxTinybar) {
    throw new Error(`ceiling above what this build will custody (${CUSTODY_DISCLOSURE.maxTinybar})`);
  }

  const run = new Run(workspaceId, { task, ceilingTinybar: ceiling });
  runs.set(workspaceId, run);

  (async () => {
    try {
      run.say("task", { task, ceilingTinybar: ceiling });
      const out = await drive(run, { input: [{ role: "user", content: task }] });
      if (!out.parked) await finish(run);
    } catch (e) {
      run.say("error", { message: e.message });
      run.setState(RUN_STATE.FAILED, { message: e.message });
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
export async function applyFunding(workspaceId, { funderAccountId, expectTinybar }) {
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  const run = runs.get(workspaceId);

  if (!w.wallet) {
    const acct = await createWorkspaceAccount({ funderAccountId, initialTinybar: expectTinybar });
    ws.update(workspaceId, {
      wallet: acct, funder: funderAccountId,
      // marked spent so a later top-up cannot be "confirmed" by this deposit
      fundingTxIds: [acct.openingTxId, acct.openingTxMirrorId].filter(Boolean),
    });
    run?.fundingArrived({
      accountId: acct.accountId, tinybar: acct.fundedTinybar, opened: true,
      requestedTinybar: acct.requestedTinybar,
    });
    return { accountId: acct.accountId, opened: true, tinybar: acct.fundedTinybar };
  }

  const seen = await confirmFunding({
    accountId: w.wallet.accountId, funderAccountId, expectTinybar,
    // every deposit is spent once; the account-opening transfer is already spent
    consumedTxIds: w.fundingTxIds ?? [],
  });
  if (!seen.ok) return { pending: true };
  ws.update(workspaceId, { fundingTxIds: [...(w.fundingTxIds ?? []), seen.txId] });
  run?.fundingArrived({ accountId: w.wallet.accountId, tinybar: seen.amount, txId: seen.txId });
  return { accountId: w.wallet.accountId, txId: seen.txId, tinybar: seen.amount };
}

/** Settle up once the model has nothing left to say. */
async function finish(run) {
  const w = ws.get(run.workspaceId);
  const left = w?.wallet ? await balanceOf(w.wallet.accountId).catch(() => null) : null;
  run.say("balance", { tinybar: left });
  run.setState(RUN_STATE.DONE, { remainingTinybar: left, approvals: run.approvals });
  runs.delete(run.workspaceId);
}

/** Close: stop the run, sweep the balance home, delete the account. */
export async function closeWorkspace(workspaceId) {
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  const run = runs.get(workspaceId);
  run?.cancel();
  runs.delete(workspaceId);

  // Settle what the agent still holds BEFORE deleting the account it must be
  // refunded to.
  //
  // Deleting first is unrecoverable, not merely untidy. The compute server
  // refunds unused seconds by transferring to the buyer, and the buyer is this
  // custodial account. Delete it while sessions are open and every one of
  // those refunds fails ACCOUNT_DELETED, forever, on a sweep that retries them
  // every sixty seconds and can never succeed. Two sessions worth 0.745 HBAR
  // were lost exactly this way.
  const closed = [];
  if (w.wallet && run?.openSessions?.size) {
    const base = env.PINOUT_URL ?? "http://localhost:4021";
    for (const sessionId of run.openSessions) {
      try {
        const r = await fetch(`${base}/session/${sessionId}/close?cause=workspace-closed`,
          { method: "POST" });
        closed.push({ sessionId, ok: r.ok });
      } catch (e) {
        closed.push({ sessionId, ok: false, error: e.message });
      }
    }
  }

  let swept = null;
  if (w.wallet) {
    swept = await sweepAndClose(w.wallet).catch((e) => ({ closed: false, error: e.message }));
  }
  ws.update(workspaceId, {
    state: "closed", wallet: null, closedAt: Date.now(), swept,
    sessionsClosed: closed,
  });
  return swept;
}
