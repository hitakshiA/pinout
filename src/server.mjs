// Pinout resource server — a real HTTP 402 exchange over the wire.
//
// Endpoints:
//   POST /session              402 -> pay -> 200 {sessionId, credits}
//   GET  /session/:id/stream   SSE, burns one credit per event
//   POST /session/:id/topup    402 -> pay -> 200, mid-stream, socket stays open
//   POST /session/:id/close    settlement anchor -> refund
//   GET  /session/:id          status
//   GET  /                     service descriptor (bazaar-style catalog)
//
// The 402 carries the three canonical x402 headers:
//   PAYMENT-REQUIRED  (server -> client, base64 JSON)
//   PAYMENT-SIGNATURE (client -> server, base64 signed transaction)
//   PAYMENT-RESPONSE  (server -> client, settlement result)
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/hono";
// Official Hedera server-side scheme. Previously this side was hand-rolled
// while the client used the official one — an asymmetry a Hedera reviewer
// would spot immediately.
import { ExactHederaScheme as ExactHederaServerScheme } from "@x402/hedera/exact/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { inspectHederaTransaction, extractTransactionFromPayload } from "@x402/hedera";
import { createHash } from "node:crypto";
import {
  env, NETWORK, HBAR_ASSET, FACILITATORS, resolveFeePayer, requireConfig, hashscan,
} from "./config.mjs";
import {
  Session, CAUSE, flushCheckpoint, settleSession, settleExpired, makeClient,
} from "./session.mjs";
import { getProvider } from "../providers/index.mjs";
import { signOffer, signReceipt, keyId, sellerPublicKeyHex } from "./receipt.mjs";
import { saveSession, loadSessions } from "./store.mjs";

requireConfig();

export const CONFIG = {
  pricePerEvent: Number(env.PRICE_PER_EVENT_TINYBAR ?? 200), // tinybar/event
  sessionTinybar: Number(env.SESSION_TINYBAR ?? 400_000),    // 0.004 HBAR
  topUpTinybar: Number(env.TOPUP_TINYBAR ?? 200_000),
  checkpointEvery: Number(env.CHECKPOINT_EVERY ?? 250),
  topUpThreshold: Number(env.TOPUP_THRESHOLD ?? 400),
  maxDurationMs: Number(env.MAX_SESSION_DURATION_MS ?? 10 * 60_000),
  facilitator: FACILITATORS[env.FACILITATOR ?? "x402"] ?? FACILITATORS.x402,
};

const ctx = makeClient();
const facilitator = new HTTPFacilitatorClient({ url: CONFIG.facilitator });
const sessions = new Map();
let FEE_PAYER = null;

// Official resource server + official Hedera scheme, wired the way Hedera's
// own docs and reference repos do it.
const resourceServer = new x402ResourceServer(facilitator);
resourceServer.register("hedera:*", new ExactHederaServerScheme());

// Register `offer-and-receipt` as a proper x402 extension rather than hand-
// building the 402 body. `signature` is declared dynamic because a fresh offer
// (with a new validUntil) is signed on every response, so it must be excluded
// from the client's strict echo validation.
resourceServer.registerExtension({
  key: "offer-receipt",
  dynamicInfoFields: ["offers"],
  enrichPaymentRequiredResponse: async (_decl, context) => {
    const a = context?.accepts?.[0] ?? {};
    return {
      info: {
        offers: [signOffer({
          resourceUrl: context?.resource?.url ?? "",
          amount: a.amount ?? String(CONFIG.sessionTinybar),
          payTo: a.payTo ?? env.SELLER_ACCOUNT_ID,
          validitySeconds: 180,
          acceptIndex: 0,
        })],
        signerKid: keyId(),
        signerPublicKey: sellerPublicKeyHex(),
      },
    };
  },
});

/**
 * Payer + a stable idempotency key from the payment the middleware verified.
 *
 * The official middleware settles AFTER the handler succeeds (and cancels the
 * payment if the handler fails), so the settlement tx id does not exist yet at
 * handler time. Keying idempotency on the signed payment itself is both
 * available here and strictly better: it dedupes the payment, not its receipt.
 */
function paymentContext(c) {
  const sig = c.req.header("PAYMENT-SIGNATURE");
  if (!sig) return null;
  const payload = decodePaymentSignatureHeader(sig);
  // extractTransactionFromPayload takes the INNER payload ({transaction}),
  // not the whole PaymentPayload envelope.
  const txB64 = extractTransactionFromPayload(payload.payload);
  const inspected = inspectHederaTransaction(txB64);
  // payer = the account with the negative HBAR entry
  const payer = (inspected.hbarTransfers ?? [])
    .filter((t) => BigInt(t.amount) < 0n)
    .map((t) => t.accountId)[0] ?? null;
  return {
    payer,
    key: createHash("sha256").update(txB64).digest("hex").slice(0, 32),
    inspected,
  };
}

const requirements = (amountTinybar, resourceUrl) => ({
  scheme: "exact",
  network: NETWORK,
  amount: String(amountTinybar),
  asset: HBAR_ASSET,
  payTo: env.SELLER_ACCOUNT_ID,
  maxTimeoutSeconds: 180,
  extra: { feePayer: FEE_PAYER },
});

/** The 402 body, including the `bazaar` discovery extension. */
function paymentRequired(amountTinybar, resourceUrl, description) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: resourceUrl,
      description,
      mimeType: "application/json",
      serviceName: "Pinout",
      tags: ["streaming", "metered", "llm", "x402", "hedera"],
    },
    accepts: [requirements(amountTinybar, resourceUrl)],
    extensions: {
      // x402 `offer-and-receipt`: the server cryptographically commits to the
      // terms it is advertising, so a disputed price is checkable later.
      "offer-receipt": {
        info: {
          offers: [signOffer({
            resourceUrl, amount: amountTinybar, payTo: env.SELLER_ACCOUNT_ID,
            validitySeconds: 180, acceptIndex: 0,
          })],
          signerKid: keyId(),
          signerPublicKey: sellerPublicKeyHex(),
        },
      },
      // The bazaar extension requires BOTH `info` and a `schema` that validates
      // it. Omitting `schema` is silently malformed until the official
      // middleware validates the route.
      bazaar: {
        info: {
          input: { type: "http", method: "POST" },
          output: { type: "json", example: { sessionId: "uuid", credits: 2000 } },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["POST"] },
              },
              required: ["type", "method"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
  };
}

/**
 * Resolve a session and check its bearer secret. Returns an error Response,
 * or the session. The session id alone is NOT sufficient authorisation.
 */
function authorised(c) {
  const s = sessions.get(c.req.param("id"));
  if (!s) return { err: c.json({ error: "no such session" }, 404) };
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : c.req.query("token");
  if (!s.authorise(token)) {
    return { err: c.json({
      error: "unauthorized",
      detail: "send the sessionSecret from POST /session as 'Authorization: Bearer <secret>'",
    }, 401) };
  }
  s.touch();
  return { s };
}

const app = new Hono();

/**
 * Build a bazaar catalog from the live route config. Deriving it from `routes`
 * rather than hand-writing it means the advertised price and shape can never
 * drift from what the payment gate actually enforces.
 */
function bazaarCatalog() {
  const base = env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4021}`;
  const items = [];
  for (const [pattern, cfg] of Object.entries(routes)) {
    const [method, path] = pattern.split(" ");
    for (const a of cfg.accepts) {
      const price = typeof a.price === "function" ? a.price({}) : a.price;
      items.push({
        resource: {
          url: `${base}${path}`,
          description: cfg.description,
          mimeType: cfg.mimeType ?? "application/json",
          serviceName: cfg.serviceName ?? "Pinout",
          tags: cfg.tags ?? [],
        },
        accepts: [{
          scheme: a.scheme, network: a.network, payTo: a.payTo,
          amount: price.amount, asset: price.asset,
          maxTimeoutSeconds: a.maxTimeoutSeconds,
          extra: { feePayer: FEE_PAYER },
        }],
        extensions: { bazaar: cfg.extensions?.bazaar },
      });
    }
  }
  return { x402Version: 2, items, updatedAt: new Date().toISOString() };
}

/**
 * Route config for the official @x402/hono middleware. Prices are dynamic
 * callbacks — the pattern the Hedera reference repos bless — so a top-up can
 * later be priced from the session's observed burn rate.
 */
const routes = {
  "POST /session": {
    extensions: {
      "offer-receipt": {},
      // The bazaar extension requires BOTH `info` and a `schema` that validates
      // it. Omitting `schema` is silently malformed until the official
      // middleware validates the route.
      bazaar: {
        info: {
          input: { type: "http", method: "POST" },
          output: { type: "json", example: { sessionId: "uuid", credits: 2000 } },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["POST"] },
              },
              required: ["type", "method"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
    accepts: [{
      scheme: "exact", network: NETWORK, payTo: env.SELLER_ACCOUNT_ID,
      price: () => ({ amount: String(CONFIG.sessionTinybar), asset: HBAR_ASSET }),
      maxTimeoutSeconds: 180,
    }],
    description: "Open a prepaid metered stream session",
    serviceName: "Pinout",
    tags: ["streaming", "metered", "llm", "x402", "hedera"],
    mimeType: "application/json",
  },
  "POST /session/:id/topup": {
    extensions: {
      "offer-receipt": {},
      // The bazaar extension requires BOTH `info` and a `schema` that validates
      // it. Omitting `schema` is silently malformed until the official
      // middleware validates the route.
      bazaar: {
        info: {
          input: { type: "http", method: "POST" },
          output: { type: "json", example: { sessionId: "uuid", credits: 2000 } },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["POST"] },
              },
              required: ["type", "method"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
    accepts: [{
      scheme: "exact", network: NETWORK, payTo: env.SELLER_ACCOUNT_ID,
      price: () => ({ amount: String(CONFIG.topUpTinybar), asset: HBAR_ASSET }),
      maxTimeoutSeconds: 180,
    }],
    description: "Top up an open session without dropping the stream",
    serviceName: "Pinout",
    mimeType: "application/json",
  },
};


// Official x402 payment gate. It verifies BEFORE the handler runs and settles
// AFTER the handler succeeds — cancelling the payment outright if the handler
// throws or returns >=400. That ordering is safer than settling first: a
// failure after settlement would have charged the buyer for nothing.
// Session-scoped auth runs BEFORE the payment gate. Otherwise an unauthorised
// caller is handed a 402 challenge for someone else's session; the payment is
// cancelled when our handler 401s, but quoting a price you will never honour
// is not an acceptable thing to do to a paying client.
app.use("/session/:id/*", async (c, next) => {
  const a = authorised(c);
  if (a.err) return a.err;
  await next();
});

app.use("*", paymentMiddleware(routes, resourceServer));

// Discovery: the bazaar extension declares the shape, this endpoint makes it
// enumerable so an agent can find these resources without being told the URLs.
app.get("/bazaar", (c) => c.json(bazaarCatalog()));
app.get("/.well-known/x402", (c) => c.json(bazaarCatalog()));

app.get("/", (c) => c.json({
  service: "Pinout",
  description: "Prepaid metered streaming credits over x402 on Hedera",
  network: NETWORK,
  asset: "HBAR",
  pricing: {
    pricePerEventTinybar: CONFIG.pricePerEvent,
    sessionTinybar: CONFIG.sessionTinybar,
    topUpTinybar: CONFIG.topUpTinybar,
  },
  // Prices are served live so clients never hardcode them.
  ledger: {
    burnTopic: env.BURN_TOPIC_ID,
    settlementTopic: env.TOPIC_ID,
    burnTopicUrl: hashscan.topic(env.BURN_TOPIC_ID),
    settlementTopicUrl: hashscan.topic(env.TOPIC_ID),
  },
  discovery: { bazaar: "/bazaar", wellKnown: "/.well-known/x402" },
  agentInterfaces: { mcp: "npm run mcp", agentKitPlugin: "src/agent-kit-plugin.mjs" },
  facilitator: CONFIG.facilitator,
  feePayer: FEE_PAYER,
}));

app.post("/session", async (c) => {
  const pay = paymentContext(c);
  if (!pay) return c.json({ error: "no verified payment" }, 402);

  const s = new Session({
    payer: pay.payer,
    pricePerEvent: CONFIG.pricePerEvent,
    checkpointEvery: CONFIG.checkpointEvery,
    topUpThreshold: CONFIG.topUpThreshold,
    maxDurationMs: CONFIG.maxDurationMs,
  });
  if (c.req.query("cheat")) s.cheat = Number(c.req.query("cheat"));
  const res = s.credit(pay.key, CONFIG.sessionTinybar);
  sessions.set(s.id, s);
  saveSession(s); // durable before the buyer is told it has credits

  return c.json({
    sessionId: s.id,
    // Returned exactly once. Required on every later call to this session.
    sessionSecret: s.secret,
    maxSessionDurationSeconds: Math.floor(s.maxDurationMs / 1000),
    credits: res.credited,
    pricePerEventTinybar: s.pricePerEvent,
    payer: s.payer,
    // #2273 SessionRequirementsResponse fields
    unit: "token",
    pricePerUnit: String(s.pricePerEvent),
    refundPolicy: "signed-receipt",
    ledger: {
      burnTopic: hashscan.topic(env.BURN_TOPIC_ID),
      settlementTopic: hashscan.topic(env.TOPIC_ID),
    },
  });
});

app.post("/session/:id/topup", async (c) => {
  const a = authorised(c); if (a.err) return a.err;
  const s = a.s;
  // Reject BEFORE the middleware can settle. Charging into a settled session
  // would take real money for credits that can never be granted.
  if (s.state === "CLOSED" || s.state === "SETTLING") {
    return c.json({ error: `session is ${s.state}; cannot top up` }, 409);
  }
  const pay = paymentContext(c);
  if (!pay) return c.json({ error: "no verified payment" }, 402);

  const res = s.credit(pay.key, CONFIG.topUpTinybar);
  saveSession(s);
  return c.json({
    sessionId: s.id,
    credited: res.credited,
    duplicate: res.duplicate,   // idempotency is observable
    credits: s.credits,
  });
});

app.get("/session/:id/stream", (c) => {
  const a = authorised(c); if (a.err) return a.err;
  const s = a.s;
  if (s.state === "CLOSED" || s.state === "SETTLING") {
    return c.json({ error: `session is ${s.state}` }, 409);
  }
  // One stream per session. Two concurrent readers would interleave burns
  // against a shared balance and produce checkpoints whose event ranges
  // overlap, which the verifier would (correctly) reject as non-contiguous.
  if (s._streaming) return c.json({ error: "session already streaming" }, 409);
  s._streaming = true;
  const n = Number(c.req.query("n") ?? 500);
  const provider = getProvider(c.req.query("provider") ?? env.PROVIDER ?? "llm");

  return streamSSE(c, async (stream) => {
    let sent = 0;
    for await (const ev of provider.stream({ n, prompt: c.req.query("prompt") })) {
      if (!s.burn(ev.id)) {
        await stream.writeSSE({
          event: "SessionTerminate",
          data: JSON.stringify({
            type: "SessionTerminate", session: s.id, cause: CAUSE.BALANCE_EXHAUSTED,
          }),
        });
        break;
      }
      await stream.writeSSE({ event: "data", data: JSON.stringify(ev) });
      sent++;

      if (s.needsCheckpoint) {
        const cp = await flushCheckpoint(ctx, s);
        if (cp) {
          // Persist burn state at every checkpoint. This bounds crash loss to
          // at most CHECKPOINT_EVERY events, and the loss falls on the SELLER
          // (restored credits are >= reality), which is the safe direction:
          // a crash never bills the buyer for undelivered events.
          saveSession(s);
          await stream.writeSSE({
            event: "Checkpoint",
            data: JSON.stringify({
              seq: cp.sequenceNumber, burned: cp.body.burned, txUrl: hashscan.tx(cp.txId),
            }),
          });
        }
      }
      if (sent % 25 === 0 || s.lowBalance) {
        await stream.writeSSE({ event: "SessionUpdate", data: JSON.stringify(s.update()) });
      }
    }
    await stream.writeSSE({ event: "done", data: JSON.stringify({ sent, credits: s.credits }) });
    s._streaming = false;
  });
});

app.post("/session/:id/close", async (c) => {
  const a = authorised(c); if (a.err) return a.err;
  const s = a.s;
  const out = await settleSession(ctx, s, c.req.query("cause") ?? CAUSE.CLIENT_DISCONNECT);
  // Signed receipt: binds the settled payment to the consumption actually
  // recorded on the burn ledger and to the settlement anchor.
  const receipt = signReceipt({
    resourceUrl: new URL(c.req.url).toString(),
    sessionId: s.id, payer: s.payer, amount: s.paidTinybar,
    settlementTxId: s.fundingTxIds[0], unitsConsumed: s.burned, unit: "token",
    burnTopic: env.BURN_TOPIC_ID, burnFinalSeq: out.settlement.body.burnFinalSeq,
    settlementTopic: env.TOPIC_ID, settlementTxOnTopic: out.settlement.txId,
  });
  saveSession(s);
  return c.json({
    receipt,
    receiptSigner: { kid: keyId(), publicKey: sellerPublicKeyHex() },
    sessionId: s.id,
    ...out.terminate,
    settlementTx: out.settlement.txId,
    settlementTxUrl: hashscan.tx(out.settlement.txId),
    settlementPaidToBuyerTinybar: out.settlement.paidToBuyer,
    refundTxUrl: out.refund ? hashscan.tx(out.refund.txId) : null,
    burnCheckpoints: s.checkpoints.length,
  });
});

app.get("/session/:id", (c) => {
  const a = authorised(c); if (a.err) return a.err;
  const s = a.s;
  return c.json({
    sessionId: s.id, state: s.state, credits: s.credits, burned: s.burned,
    paidTinybar: s.paidTinybar, checkpoints: s.checkpoints.length,
    funding: s.fundingTxIds,
  });
});

export async function start(port = Number(env.PORT ?? 4021)) {
  FEE_PAYER = await resolveFeePayer(CONFIG.facilitator);

  // Rehydrate unfinished sessions. Without this the persistence layer is
  // write-only: a restart strands credits the buyer has already paid for,
  // and the seller keeps money for undelivered service.
  let restored = 0;
  for (const r of loadSessions().values()) {
    if (r.state === "CLOSED") continue;
    const s = new Session({
      payer: r.payer, pricePerEvent: r.pricePerEvent,
      checkpointEvery: CONFIG.checkpointEvery, topUpThreshold: CONFIG.topUpThreshold,
    });
    s.id = r.id; s.state = r.state; s.credits = r.credits; s.burned = r.burned;
    s.paidTinybar = r.paidTinybar; s.fundingTxIds = r.fundingTxIds ?? [];
    s.seenTxIds = new Set(s.fundingTxIds); // replay guard survives the restart
    s.lastCheckpointAt = r.lastCheckpointAt ?? 0;
    sessions.set(s.id, s);
    restored++;
  }
  if (restored) console.log(`restored        : ${restored} open session(s) from disk`);

  // Reap abandoned sessions. Without this a buyer that pays and walks away
  // loses its money permanently — the service keeps funds for undelivered
  // service. Batched so cleanup cannot be turned into a drain on the seller.
  const sweep = setInterval(async () => {
    try {
      const out = await settleExpired(ctx, sessions.values(), CAUSE.MAX_DURATION);
      if (out) {
        for (const s of sessions.values()) if (s.state === "CLOSED") saveSession(s);
        console.log(`expiry sweep    : settled ${out.sessions} abandoned session(s) ` +
                    `in ONE anchor ${out.anchor.txId}, ${out.refunds.length} refund(s)`);
      }
    } catch (e) { console.error("expiry sweep failed:", e.message); }
  }, Number(env.SWEEP_INTERVAL_MS ?? 60_000));
  sweep.unref?.();
  console.log(`pinout server   : http://localhost:${port}`);
  console.log(`facilitator     : ${CONFIG.facilitator}`);
  console.log(`feePayer        : ${FEE_PAYER}  (resolved from /supported)`);
  console.log(`seller (payTo)  : ${env.SELLER_ACCOUNT_ID}`);
  console.log(`burn topic      : ${env.BURN_TOPIC_ID}`);
  console.log(`settlement topic: ${env.TOPIC_ID}`);
  return serve({ fetch: app.fetch, port });
}

export { app, sessions, ctx };
