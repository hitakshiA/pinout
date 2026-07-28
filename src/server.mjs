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
import { RATES } from "../providers/compute.mjs";
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

/**
 * Price a session for a lane. Compute seconds cost what the lane costs — a flat
 * rate across lanes either loses money on GPU or overcharges on CPU. Lane is
 * fixed at session open so the 402 can be priced honestly and the signed offer
 * commits to it.
 */
export function lanePricing(lane) {
  if (!lane || lane === "llm" || lane === "mirror") {
    return { lane: lane ?? "llm", unit: "token",
             pricePerUnit: CONFIG.pricePerEvent, sessionTinybar: CONFIG.sessionTinybar,
             topUpTinybar: CONFIG.topUpTinybar };
  }
  if (lane === "local") {
    return { lane, unit: "second", pricePerUnit: 1000, sessionTinybar: 300_000, topUpTinybar: 150_000 };
  }
  const l = RATES.lanes[lane];
  if (!l) throw new Error(`unknown lane ${lane}`);
  const pricePerUnit = l.creditTinybar;
  // Default budget = 120 seconds of that lane, rounded to a whole tinybar.
  return { lane, unit: "second", pricePerUnit, provider: l.provider,
           sessionTinybar: pricePerUnit * 120, topUpTinybar: pricePerUnit * 60 };
}

/**
 * Pull ?lane= out of whatever the transport hands the price callback.
 * HTTPRequestContext exposes `path`; depending on adapter it may or may not
 * carry the query string, so fall back to the adapter's raw request.
 */
export function laneFromContext(ctx) {
  const candidates = [
    ctx?.path,
    ctx?.adapter?.getUrl?.(),
    ctx?.adapter?.request?.url,
    ctx?.adapter?.url,
  ].filter((x) => typeof x === "string");
  for (const c of candidates) {
    const q = c.indexOf("?");
    if (q === -1) continue;
    const lane = new URLSearchParams(c.slice(q + 1)).get("lane");
    if (lane) return lane;
  }
  return null;
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

const BAZAAR_EXT = {
  "offer-receipt": {},
  bazaar: {
    info: {
      input: { type: "http", method: "POST" },
      output: { type: "json", example: { sessionId: "uuid", credits: 120 } },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: {
          type: { type: "string", const: "http" }, method: { type: "string", enum: ["POST"] },
        }, required: ["type", "method"], additionalProperties: false },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } },
                  required: ["type"] },
      },
      required: ["input"],
    },
  },
};

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
/**
 * One priced route per lane. The x402 middleware resolves a route's price at
 * registration, so a single endpoint cannot honestly quote different lanes —
 * and a lane must be priced in the 402 the buyer signs. Separate routes also
 * let the bazaar catalogue advertise each lane as its own payable resource.
 */
const LANES = { ...Object.fromEntries(Object.keys(RATES.lanes).map((l) => [l, true])), local: true };

function laneRoute(lane) {
  const p = lanePricing(lane);
  return {
    accepts: [{
      scheme: "exact", network: NETWORK, payTo: env.SELLER_ACCOUNT_ID,
      price: { amount: String(p.sessionTinybar), asset: HBAR_ASSET },
      maxTimeoutSeconds: 180,
    }],
    description: `Rent ${lane} by the second (${p.pricePerUnit} tinybar/s, ${p.sessionTinybar} tinybar buys ${Math.floor(p.sessionTinybar / p.pricePerUnit)}s)`,
    serviceName: "Pinout Compute",
    tags: ["compute", "metered", "x402", "hedera", lane],
    mimeType: "application/json",
    extensions: BAZAAR_EXT,
  };
}

const routes = {
  "POST /session": {
    accepts: [{
      scheme: "exact", network: NETWORK, payTo: env.SELLER_ACCOUNT_ID,
      price: { amount: String(CONFIG.sessionTinybar), asset: HBAR_ASSET },
      maxTimeoutSeconds: 180,
    }],
    description: "Open a prepaid metered stream session (token-billed lanes)",
    serviceName: "Pinout", tags: ["streaming", "metered", "llm", "x402", "hedera"],
    mimeType: "application/json", extensions: BAZAAR_EXT,
  },
  ...Object.fromEntries(Object.keys(LANES).map((l) => [`POST /compute/${l}`, laneRoute(l)])),
  "POST /session/:id/topup": {
    accepts: [{
      scheme: "exact", network: NETWORK, payTo: env.SELLER_ACCOUNT_ID,
      price: { amount: String(CONFIG.topUpTinybar), asset: HBAR_ASSET },
      maxTimeoutSeconds: 180,
    }],
    description: "Top up an open session without dropping the stream",
    serviceName: "Pinout", mimeType: "application/json", extensions: BAZAAR_EXT,
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

// Machine-readable lane catalogue. An agent must be able to find the compute
// capability from HTTP alone — a black-box consumer previously could not.
app.get("/lanes", (c) => c.json({
  unit: "second",
  note: "You are billed per second you HOLD the machine, from credits bought with POST /session?lane=<lane>. Unused seconds are refunded at close.",
  lanes: Object.entries(RATES.lanes).map(([lane, v]) => ({
    lane, provider: v.provider, tinybarPerSecond: v.creditTinybar,
    vcpu: v.vcpu, memGiB: v.memGiB, gpu: v.gpu ?? null,
    sessionTinybar: v.creditTinybar * 120,
  })).concat([{ lane: "local", provider: "builtin", tinybarPerSecond: 1000, sessionTinybar: 300000 }]),
}));
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
  discovery: { bazaar: "/bazaar", wellKnown: "/.well-known/x402", lanes: "/lanes" },
  compute: {
    description: "Rent a real machine and run your own code on it, billed per second held.",
    howTo: [
      "POST /session?lane=<lane>            pay the 402; you get credits and a sessionSecret",
      "GET  /session/:id/stream?provider=compute&code=<base64 python>&n=<max seconds>",
      "POST /session/:id/close              releases the machine and refunds unheld seconds",
      "all session calls need: Authorization: Bearer <sessionSecret>",
    ],
    lanes: Object.fromEntries(Object.entries(RATES.lanes).map(([k, v]) => [k, {
      provider: v.provider, tinybarPerSecond: v.creditTinybar,
      vcpu: v.vcpu, memGiB: v.memGiB, gpu: v.gpu ?? null,
    }])),
  },
  agentInterfaces: { mcp: "npm run mcp", agentKitPlugin: "src/agent-kit-plugin.mjs" },
  facilitator: CONFIG.facilitator,
  feePayer: FEE_PAYER,
}));

app.post("/compute/:lane", async (c) => {
  const lane = c.req.param("lane");
  if (!LANES[lane]) return c.json({ error: `unknown lane ${lane}`, lanes: Object.keys(LANES) }, 404);
  const pay = paymentContext(c);
  if (!pay) return c.json({ error: "no verified payment" }, 402);
  const pricing = lanePricing(lane);

  const s = new Session({
    payer: pay.payer, pricePerEvent: pricing.pricePerUnit,
    checkpointEvery: CONFIG.checkpointEvery, topUpThreshold: CONFIG.topUpThreshold,
    maxDurationMs: CONFIG.maxDurationMs,
  });
  s.lane = lane; s.unit = "second";
  const res = s.credit(pay.key, pricing.sessionTinybar);
  sessions.set(s.id, s);
  saveSession(s);

  return c.json({
    sessionId: s.id, sessionSecret: s.secret,
    lane, provider: pricing.provider ?? "builtin", unit: "second",
    credits: res.credited, secondsPurchased: res.credited,
    pricePerSecondTinybar: pricing.pricePerUnit,
    maxSessionDurationSeconds: Math.floor(s.maxDurationMs / 1000),
    howToRun: `GET /session/${s.id}/stream?provider=compute&n=<maxSeconds>&code=<base64 python>  with Authorization: Bearer <sessionSecret>`,
  });
});

app.post("/session", async (c) => {
  const pay = paymentContext(c);
  if (!pay) return c.json({ error: "no verified payment" }, 402);

  // The lane is fixed for the life of the session: it determined the price the
  // buyer just paid, so it cannot change afterwards.
  let pricing;
  try { pricing = lanePricing(c.req.query("lane")); }
  catch (e) { return c.json({ error: e.message }, 400); }

  const s = new Session({
    payer: pay.payer,
    pricePerEvent: pricing.pricePerUnit,
    checkpointEvery: CONFIG.checkpointEvery,
    topUpThreshold: CONFIG.topUpThreshold,
    maxDurationMs: CONFIG.maxDurationMs,
  });
  s.lane = pricing.lane;
  s.unit = pricing.unit;
  if (c.req.query("cheat")) s.cheat = Number(c.req.query("cheat"));
  const res = s.credit(pay.key, pricing.sessionTinybar);
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
    lane: s.lane,
    unit: s.unit,
    provider: pricing.provider ?? "builtin",
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

  const res = s.credit(pay.key, lanePricing(s.lane).topUpTinybar);
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
    const jobCode = c.req.query("code") ? Buffer.from(c.req.query("code"), "base64").toString("utf8") : undefined;
    for await (const ev of provider.stream({
      n, prompt: c.req.query("prompt"),
      // Lane comes from the SESSION, never the request — otherwise a caller
      // could pay cpu-small prices and run on a GPU.
      lane: s.lane, code: jobCode, sessionId: s.id,
    })) {
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
