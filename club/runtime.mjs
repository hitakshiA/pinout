// The agent loop for a workspace.
//
// It runs server-side, not in the browser, for three reasons: the custodial key
// never leaves this process, a closed tab must not kill a job that is spending
// money, and the Pinout meter stream is not something a browser should hold.
//
// The one genuinely awkward part is funding. The agent cannot buy compute until
// the human signs a transfer, and the human may take minutes or never come
// back. So the run is a resumable state machine that parks at NEEDS_FUNDING and
// waits, rather than a promise chain that has to be kept alive.
import { EventEmitter } from "node:events";
import { OpenRouter } from "@openrouter/agent";
import { env } from "../src/config.mjs";
import { pinoutTools } from "../agent/tools.mjs";
import { generalTools } from "../agent/general-tools.mjs";
import * as ws from "./workspace.mjs";
import { createWorkspaceAccount, confirmFunding, balanceOf, sweepAndClose } from "./wallet.mjs";

export const RUN_STATE = {
  PLANNING: "planning",
  NEEDS_FUNDING: "needs_funding",
  WORKING: "working",
  DONE: "done",
  FAILED: "failed",
  CLOSED: "closed",
};

const SYSTEM = `You rent real compute and pay for it yourself over x402 on Hedera.

You are given a task, sometimes files, and a hard spending ceiling you cannot exceed.

How to work:
- Look at what is available and pick the machine the job actually needs. A GPU
  costs far more per second than a CPU box, so only take one when the work
  requires it.
- Rent for as long as the job needs, then release it. The meter runs until you do.
- If you run short mid job, top up. The machine is held, not destroyed, and the
  work continues from where it stopped.
- Say what you spent and check you were billed correctly.
- Never claim you did something you did not actually do.`;

/** One live run per workspace. */
const runs = new Map();

export function runOf(id) { return runs.get(id) ?? null; }

export class Run extends EventEmitter {
  constructor(workspaceId, { task, budgetTinybar }) {
    super();
    this.workspaceId = workspaceId;
    this.task = task;
    this.budgetTinybar = budgetTinybar;
    this.state = RUN_STATE.PLANNING;
    this.startedAt = Date.now();
    this.log = [];
    this.spentTinybar = 0;
    this.fundingRequest = null;
    this.abort = new AbortController();
  }

  say(type, data = {}) {
    const ev = { type, at: Date.now(), ...data };
    this.log.push(ev);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.emit("event", ev);
    return ev;
  }

  setState(s, extra = {}) {
    this.state = s;
    ws.update(this.workspaceId, { state: s });
    this.say("state", { state: s, ...extra });
  }

  /**
   * Ask the human for money and park. Resolves when funding is confirmed on
   * chain, or rejects if the run is cancelled first.
   */
  waitForFunding({ needTinybar, reason }) {
    this.fundingRequest = { needTinybar, reason, askedAt: Date.now() };
    this.setState(RUN_STATE.NEEDS_FUNDING, { needTinybar, reason });
    return new Promise((resolve, reject) => {
      this._fundingResolve = resolve;
      this.abort.signal.addEventListener("abort", () => reject(new Error("run cancelled")), { once: true });
    });
  }

  /** Called once the transfer is seen on the mirror node. */
  fundingArrived(info) {
    this.fundingRequest = null;
    this.say("funded", info);
    this._fundingResolve?.(info);
    this._fundingResolve = null;
  }

  cancel() { this.abort.abort(); }
}

/**
 * Start a run. Returns immediately; progress arrives through run events.
 */
export async function startRun(workspaceId, { task, budgetTinybar, funderAccountId }) {
  if (runs.has(workspaceId)) throw new Error("this workspace already has a run in progress");
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");

  const run = new Run(workspaceId, { task, budgetTinybar });
  runs.set(workspaceId, run);

  (async () => {
    try {
      run.say("task", { task, budgetTinybar });

      // 1. the workspace needs its own account before it can pay for anything
      if (!w.wallet) {
        const need = Math.min(budgetTinybar, 200_000_000);
        run.say("plan", {
          text: "This needs its own wallet before it can buy compute. " +
                "Fund it once and I will spend inside the ceiling you set.",
        });
        await run.waitForFunding({ needTinybar: need, reason: "open the workspace wallet" });
      }

      const wallet = ws.get(workspaceId).wallet;
      if (!wallet) throw new Error("funding confirmed but no wallet on the workspace");

      run.setState(RUN_STATE.WORKING);

      // 2. the agent pays from the workspace account, never the operator's
      const tools = [
        ...pinoutTools({
          base: env.PINOUT_URL ?? "http://localhost:4021",
          accountId: wallet.accountId,
          privateKey: wallet.privateKey,
          maxPerCallTinybar: Math.min(budgetTinybar, 2_000_000_000),
          budgetTinybar,
        }),
        ...generalTools(),
      ];

      const or = new OpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      const result = or.callModel({
        model: env.CLUB_MODEL ?? env.AGENT_MODEL ?? "deepseek/deepseek-chat-v3.1",
        instructions: SYSTEM,
        input: [{ role: "user", content: task }],
        tools,
      });

      (async () => {
        try {
          for await (const c of result.getToolCallsStream()) {
            run.say("tool", { name: c.name, args: JSON.stringify(c.arguments ?? c.input ?? {}).slice(0, 400) });
          }
        } catch { /* stream closed with the run */ }
      })();

      const answer = await result.getText();
      run.say("answer", { text: answer });
      ws.appendMessage(workspaceId, { role: "assistant", text: answer });

      // 3. whatever is left goes home
      const left = await balanceOf(wallet.accountId).catch(() => null);
      run.say("balance", { tinybar: left });
      run.setState(RUN_STATE.DONE, { remainingTinybar: left });
    } catch (e) {
      run.say("error", { message: e.message });
      run.setState(RUN_STATE.FAILED, { message: e.message });
    } finally {
      runs.delete(workspaceId);
    }
  })();

  return run;
}

/**
 * Confirm a funding transfer and release the parked run.
 * Creates the workspace account on first funding.
 */
export async function applyFunding(workspaceId, { funderAccountId, expectTinybar }) {
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  const run = runs.get(workspaceId);

  if (!w.wallet) {
    const acct = await createWorkspaceAccount({ funderAccountId, initialTinybar: expectTinybar });
    ws.update(workspaceId, { wallet: acct, funder: funderAccountId });
    run?.fundingArrived({ accountId: acct.accountId, tinybar: expectTinybar, opened: true });
    return { accountId: acct.accountId, opened: true };
  }

  const seen = await confirmFunding({
    accountId: w.wallet.accountId, funderAccountId, expectTinybar,
  });
  if (!seen.ok) return { pending: true };
  run?.fundingArrived({ accountId: w.wallet.accountId, tinybar: seen.amount, txId: seen.txId });
  return { accountId: w.wallet.accountId, txId: seen.txId, amount: seen.amount };
}

/** Close a workspace: stop the run, sweep the balance home, delete the account. */
export async function closeWorkspace(workspaceId) {
  const w = ws.get(workspaceId);
  if (!w) throw new Error("no such workspace");
  runs.get(workspaceId)?.cancel();

  let swept = null;
  if (w.wallet) {
    swept = await sweepAndClose(w.wallet).catch((e) => ({ closed: false, error: e.message }));
  }
  ws.update(workspaceId, { state: "closed", wallet: null, closedAt: Date.now(), swept });
  return swept;
}
