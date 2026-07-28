// Pinout MCP server — exposes the metered session lifecycle as agent tools.
//
// This is the pattern hedera-agent-kit-js#1007 asks for and nobody has shipped:
// "x402 middleware wired to an MCP server — tool calls are blocked until a
// confirmed HBAR micropayment is received", plus #894's request for "an HCS
// audit-log example for accepted paid tool calls" and "a Mirror Node receipt
// verifier helper".
//
// No tool returns data before its payment has settled on-chain. The agent
// governs its own spend through the same pre-signature caps the client uses,
// so it cannot be induced to overspend by a mispriced 402.
//
//   node src/mcp.mjs            (stdio; point any MCP client at it)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PinoutClient, BudgetExceededError, UntrustedPaymentError } from "./client.mjs";
import { env, hashscan } from "./config.mjs";

const BASE = env.PINOUT_URL ?? "http://localhost:4021";
const client = new PinoutClient({
  base: BASE,
  maxPerCallTinybar: Number(env.MCP_MAX_PER_CALL_TINYBAR ?? 2_000_000),
  budgetTinybar: Number(env.MCP_BUDGET_TINYBAR ?? 20_000_000),
});

const open = new Map(); // sessionId -> received event ids

const TOOLS = [
  {
    name: "open_session",
    description:
      "Open a prepaid metered stream session. Pays a real x402 exact-scheme " +
      "micropayment in HBAR on Hedera testnet and returns a session id plus credits. " +
      "Returns the settlement transaction so the payment can be checked on HashScan.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stream",
    description:
      "Consume events from an open session, burning one credit per event. " +
      "Returns the events and the remaining balance. Automatically tops up " +
      "(another on-chain x402 payment) if the balance runs low mid-stream.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        n: { type: "number", description: "events to consume", default: 200 },
        provider: { type: "string", enum: ["llm", "mirror", "compute"], default: "llm" },
        code: { type: "string", description: "Python source to run when provider=compute" },
        autoTopUp: { type: "boolean", default: true },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "close_session",
    description:
      "Close a session. Writes the HIP-991 settlement anchor (the seller pays the " +
      "buyer via the topic's custom fee) and only then issues the refund of unused " +
      "credits. Returns both transaction ids.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, cause: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "verify_session",
    description:
      "Independently recompute the bill for a session from the free public Hedera " +
      "mirror node and compare it against the events this agent actually received. " +
      "Detects seller over-billing. Trusts nothing but the mirror node.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "spend_report",
    description: "How much this agent has spent so far, and its remaining budget.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const server = new Server(
  { name: "pinout", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    switch (name) {
      case "open_session": {
        const s = await client.openSession();
        open.set(s.sessionId, []);
        return ok({
          sessionId: s.sessionId,
          credits: s.credits,
          pricePerEventTinybar: s.pricePerEventTinybar,
          unit: s.unit,
          paymentSettledOnChain: s.paymentTx,
          hashscan: s.paymentTxUrl,
        });
      }
      case "stream": {
        const got = open.get(a.sessionId) ?? [];
        const events = [];
        let topUps = 0;
        const { terminated } = await client.stream(a.sessionId, {
          n: a.n ?? 200,
          provider: a.provider,
          code: a.code,
          onEvent: (e) => events.push(e),
          onLow: async () => {
            if (a.autoTopUp === false || topUps >= 2) return;
            await client.topUp(a.sessionId);
            topUps++;
          },
        });
        for (const e of events) got.push(e.id);
        open.set(a.sessionId, got);
        return ok({
          delivered: events.length,
          topUpsPurchased: topUps,
          terminated: terminated?.cause ?? null,
          sample: events.slice(0, 8).map((e) => e.token ?? e.name ?? e.id),
          totalReceivedThisSession: got.length,
        });
      }
      case "close_session": {
        const out = await client.close(a.sessionId, a.cause);
        return ok({
          consumedTinybar: out.consumedAmount,
          refundTinybar: out.refundAmount,
          cause: out.cause,
          settlementAnchor: out.settlementTxUrl,
          anchorFeeTinybar: out.settlementFeeTinybar,
          refundTx: out.refundTxUrl,
          burnCheckpoints: out.burnCheckpoints,
        });
      }
      case "verify_session": {
        const { verifySession } = await import("./verifier.mjs");
        const report = await verifySession(a.sessionId, open.get(a.sessionId) ?? null);
        return ok(report);
      }
      case "spend_report":
        return ok({
          spentTinybar: client.spent,
          budgetTinybar: client.budget,
          remainingTinybar: client.budget - client.spent,
          maxPerCallTinybar: client.maxPerCall,
          account: client.accountId,
          hashscan: hashscan.account(client.accountId),
        });
      default:
        return err(`unknown tool ${name}`);
    }
  } catch (e) {
    // Spend guards are surfaced as typed, actionable errors so an agent can
    // reason about them rather than retrying blindly into its own budget.
    if (e instanceof BudgetExceededError) return err(`BUDGET_EXCEEDED: ${e.message}`);
    if (e instanceof UntrustedPaymentError) return err(`UNTRUSTED_PAYMENT: ${e.message}`);
    return err(`${e.name}: ${e.message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`pinout MCP server ready (resource server: ${BASE})`);
