// Pinout plugin for Hedera Agent Kit v4.
//
// This is the pattern hashgraph/hedera-agent-kit-js#1007 and #894 ask for and
// nobody has shipped: agent tools whose execution is gated behind a confirmed
// x402 micropayment, with the resulting consumption recorded on HCS and
// verifiable from the mirror node.
//
// Tools extend BaseTool rather than returning plain object literals, because
// only BaseTool-based tools participate in v4's hooks and policies — which is
// exactly what you want on a payments plugin (spend limits, HCS audit hooks,
// human-in-the-loop confirmation).
//
//   import { pinoutPlugin } from "pinout/agent-kit";
//   const discovery = new ToolDiscovery([pinoutPlugin]);
import { BaseTool } from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import { PinoutClient, BudgetExceededError, UntrustedPaymentError } from "./client.mjs";
import { verifySession } from "./verifier.mjs";
import { env, hashscan } from "./config.mjs";

const DEFAULT_URL = env.PINOUT_URL ?? "http://localhost:4021";

/** One client per (url, account) so spend caps accumulate across tool calls. */
const clients = new Map();
function clientFor(context) {
  const url = context?.pinoutUrl ?? DEFAULT_URL;
  const accountId = context?.accountId ?? env.HEDERA_ACCOUNT_ID;
  const key = `${url}|${accountId}`;
  if (!clients.has(key)) {
    clients.set(key, new PinoutClient({
      base: url,
      accountId,
      privateKey: context?.privateKey ?? env.HEDERA_PRIVATE_KEY,
      maxPerCallTinybar: Number(context?.maxPerCallTinybar ?? 2_000_000),
      budgetTinybar: Number(context?.budgetTinybar ?? 20_000_000),
    }));
  }
  return clients.get(key);
}

/** Events this agent has actually received, so the bill can be checked. */
const received = new Map();

/** Agent Kit expects { raw, humanMessage }. */
const out = (raw, humanMessage) => ({ raw, humanMessage });

class PinoutBaseTool extends BaseTool {
  // NOTE: `method` is the tool's UNIQUE key in the Agent Kit registry, not an
  // HTTP verb. Setting it to "post"/"get" collides with core tools and the kit
  // silently drops yours ("Plugin tool 'post' conflicts with core tool").
  async normalizeParams(params) { return params ?? {}; }
  async secondaryAction(request) { return request; }
  async shouldSecondaryAction() { return false; }
  async handleError(error) {
    // Surface spend guards as typed, actionable messages so an agent can
    // reason about them instead of retrying blindly into its own budget.
    if (error instanceof BudgetExceededError) {
      return out({ error: "BUDGET_EXCEEDED", detail: error.message },
        `Refused: this would exceed the agent's cumulative spend budget. ${error.message}`);
    }
    if (error instanceof UntrustedPaymentError) {
      return out({ error: "UNTRUSTED_PAYMENT", detail: error.message },
        `Refused before signing: ${error.message}`);
    }
    return out({ error: error.name, detail: error.message }, `Pinout call failed: ${error.message}`);
  }
}

class OpenSessionTool extends PinoutBaseTool {
  method = "pinout_open_session";
  name = "pinout_open_session";
  description =
    "Open a prepaid metered streaming session on Pinout. Pays a real x402 " +
    "micropayment in HBAR on Hedera and returns a session id plus purchased " +
    "credits. The settlement transaction is returned so the payment can be " +
    "checked on HashScan.";
  parameters = z.object({});

  async coreAction(_p, context) {
    const c = clientFor(context);
    const s = await c.openSession();
    received.set(s.sessionId, []);
    return out({
      sessionId: s.sessionId,
      credits: s.credits,
      pricePerEventTinybar: s.pricePerEventTinybar,
      unit: s.unit,
      maxSessionDurationSeconds: s.maxSessionDurationSeconds,
      paymentTx: s.paymentTx,
      hashscan: s.paymentTxUrl,
    },
      `Opened session ${s.sessionId.slice(0, 8)} with ${s.credits} credits ` +
      `at ${s.pricePerEventTinybar} tinybar/${s.unit}. Payment settled on-chain: ${s.paymentTx}`);
  }
}

class StreamTool extends PinoutBaseTool {
  method = "pinout_stream";
  name = "pinout_stream";
  description =
    "Consume events from an open Pinout session, burning one credit per event. " +
    "Automatically tops up mid-stream (another on-chain x402 payment) if the " +
    "balance runs low, without dropping the connection.";
  parameters = z.object({
    sessionId: z.string().describe("session id from pinout_open_session"),
    n: z.number().optional().describe("events to consume (default 200)"),
    provider: z.enum(["llm", "mirror", "compute"]).optional(),
    code: z.string().optional().describe("Python source to execute when provider is 'compute'"),
    autoTopUp: z.boolean().optional().describe("buy more credits if low (default true)"),
  });

  async coreAction(p, context) {
    const c = clientFor(context);
    const events = [];
    let topUps = 0;
    const { terminated } = await c.stream(p.sessionId, {
      n: p.n ?? 200,
      provider: p.provider,
      code: p.code,
      onEvent: (e) => events.push(e),
      onLow: async () => {
        if (p.autoTopUp === false || topUps >= 2) return;
        await c.topUp(p.sessionId);
        topUps++;
      },
    });
    const log = received.get(p.sessionId) ?? [];
    for (const e of events) log.push(e.id);
    received.set(p.sessionId, log);

    return out({
      delivered: events.length,
      topUpsPurchased: topUps,
      terminated: terminated?.cause ?? null,
      totalReceivedThisSession: log.length,
      sample: events.slice(0, 10).map((e) => e.token ?? e.name ?? e.id),
    },
      `Received ${events.length} events` +
      (topUps ? `, bought ${topUps} top-up(s) mid-stream` : "") +
      (terminated ? `, stream terminated: ${terminated.cause}` : "") + ".");
  }
}

class CloseSessionTool extends PinoutBaseTool {
  method = "pinout_close_session";
  name = "pinout_close_session";
  description =
    "Close a Pinout session. The seller writes a HIP-991 settlement anchor " +
    "(paying the buyer via the topic's custom fee) and only then refunds unused " +
    "credits. Returns both transaction ids and a signed receipt.";
  parameters = z.object({
    sessionId: z.string(),
    cause: z.string().optional(),
  });

  async coreAction(p, context) {
    const c = clientFor(context);
    const r = await c.close(p.sessionId, p.cause);
    return out({
      consumedTinybar: r.consumedAmount,
      refundTinybar: r.refundAmount,
      cause: r.cause,
      settlementAnchor: r.settlementTxUrl,
      paidToBuyerByCustomFee: r.settlementPaidToBuyerTinybar,
      refundTx: r.refundTxUrl,
      burnCheckpoints: r.burnCheckpoints,
      receipt: r.receipt,
    },
      `Closed. Consumed ${r.consumedAmount} tinybar, refunded ${r.refundAmount}. ` +
      `Settlement anchor on-chain; seller paid the buyer ` +
      `${r.settlementPaidToBuyerTinybar} tinybar via the HIP-991 topic fee.`);
  }
}

class VerifySessionTool extends PinoutBaseTool {
  method = "pinout_verify_session";
  name = "pinout_verify_session";
  description =
    "Independently recompute the bill for a Pinout session from the free public " +
    "Hedera mirror node and compare it against the events this agent actually " +
    "received. Detects seller over-billing. Trusts nothing but the mirror node.";
  parameters = z.object({ sessionId: z.string() });

  async coreAction(p) {
    const report = await verifySession(p.sessionId, received.get(p.sessionId) ?? null);
    const msg = report.verdict === "PASSED"
      ? `Bill verified independently from the mirror node: ${report.ledgerBurned} events, all ${report.checkpoints} checkpoints match.`
      : report.verdict === "FAILED"
        ? `BILL REJECTED — ${report.failures.join("; ")}`
        : `Inconclusive: ${report.note ?? "no client record to compare against"}`;
    return out(report, msg);
  }
}

class SpendReportTool extends PinoutBaseTool {
  method = "pinout_spend_report";
  name = "pinout_spend_report";
  description = "How much this agent has spent on Pinout and its remaining budget.";
  parameters = z.object({});

  async coreAction(_p, context) {
    const c = clientFor(context);
    return out({
      spentTinybar: c.spent,
      budgetTinybar: c.budget,
      remainingTinybar: c.budget - c.spent,
      maxPerCallTinybar: c.maxPerCall,
      account: c.accountId,
      hashscan: hashscan.account(c.accountId),
    }, `Spent ${c.spent} of ${c.budget} tinybar; ${c.budget - c.spent} remaining.`);
  }
}

export const pinoutPlugin = {
  name: "pinout",
  version: "0.1.0",
  description:
    "Prepaid metered streaming over x402 on Hedera. Pay-gated agent tools with " +
    "an HCS consumption ledger the agent can verify from the mirror node.",
  tools: () => [
    new OpenSessionTool(),
    new StreamTool(),
    new CloseSessionTool(),
    new VerifySessionTool(),
    new SpendReportTool(),
  ],
};

export {
  OpenSessionTool, StreamTool, CloseSessionTool, VerifySessionTool, SpendReportTool,
};
export default pinoutPlugin;
