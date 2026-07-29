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
import { inspectHederaTransaction, extractTransactionFromPayload, hederaAccountIdsEqual } from "@x402/hedera";
import { createHash } from "node:crypto";
import {
  env, NETWORK, HBAR_ASSET, FACILITATORS, resolveFeePayer, requireConfig, hashscan,
} from "./config.mjs";
import {
  Session, CAUSE, flushCheckpoint, settleSession, settleExpired, flushPendingAnchors, pendingAnchor, makeClient,
} from "./session.mjs";
import { getProvider, PROVIDERS } from "../providers/index.mjs";
import { RATES } from "../providers/compute.mjs";
import { admit, admitAsync, sellerSolvency, maxSecondsFor, recordSpend, spendReport, reapOrphans, LIMITS, ANCHOR_COST_TINYBAR } from "../compute/guards.mjs";
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
  const transfers = inspected.hbarTransfers ?? [];

  // payer = the account with the negative HBAR entry
  const payer = transfers.filter((t) => BigInt(t.amount) < 0n).map((t) => t.accountId)[0] ?? null;

  // amountPaid = what actually moves to payTo in the signed transaction.
  //
  // THIS IS THE ONLY NUMBER A SESSION MAY BE CREDITED WITH. Three separate
  // theft bugs came from crediting a looked-up price while a route charged a
  // different one (flat 402 + lane-value credit + on-chain refund of the gap).
  // Deriving the credit from the settled transfer makes that class impossible:
  // you cannot be credited money you did not send.
  const amountPaid = transfers
    .filter((t) => hederaAccountIdsEqual(t.accountId, env.SELLER_ACCOUNT_ID) && BigInt(t.amount) > 0n)
    .reduce((a, t) => a + Number(t.amount), 0);

  return {
    payer,
    amountPaid,
    key: createHash("sha256").update(txB64).digest("hex").slice(0, 32),
    inspected,
  };
}

/**
 * Credit a session from the on-chain payment, never from a price table.
 * Refuses if the settled amount does not match what this route quoted.
 */
function creditFromPayment(s, pay, quotedTinybar, label) {
  if (!pay.amountPaid || pay.amountPaid <= 0) {
    return { err: { status: 402, error: "no value transferred to payTo in the signed payment" } };
  }
  if (pay.amountPaid !== quotedTinybar) {
    console.error(`PRICE MISMATCH ${label}: settled ${pay.amountPaid} != quoted ${quotedTinybar}`);
    return { err: { status: 400,
      error: "settled amount does not match the quoted price",
      settledTinybar: pay.amountPaid, quotedTinybar } };
  }
  return { res: s.credit(pay.key, pay.amountPaid) };
}

/**
 * Price a session for a lane. Compute seconds cost what the lane costs — a flat
 * rate across lanes either loses money on GPU or overcharges on CPU. Lane is
 * fixed at session open so the 402 can be priced honestly and the signed offer
 * commits to it.
 */
/**
 * Session-shaped tunings. A compute session buys ~120 seconds while a token
 * session buys thousands of events, so a fixed threshold of 400 marks every
 * compute session "low" from second zero, and a 250-unit checkpoint interval
 * means a 120s job never checkpoints until it closes.
 */
export function tuningFor(unit, credits) {
  if (unit === "second") {
    return {
      // top up with ~25% left, floor of 10s so there is time to settle a payment
      topUpThreshold: Math.max(10, Math.floor(credits * 0.25)),
      // ~4 checkpoints across a session, floor of 15s to keep HCS cost sane
      checkpointEvery: Math.max(15, Math.floor(credits / 4)),
    };
  }
  return { topUpThreshold: CONFIG.topUpThreshold, checkpointEvery: CONFIG.checkpointEvery };
}

export function lanePricing(lane) {
  if (!lane || lane === "llm" || lane === "mirror") {
    return { lane: lane ?? "llm", unit: "token",
             pricePerUnit: CONFIG.pricePerEvent, sessionTinybar: CONFIG.sessionTinybar,
             topUpTinybar: CONFIG.topUpTinybar };
  }
  if (lane === "local") {
    // Rate is configurable so the exhaustion/refill path can be exercised in
    // seconds rather than by burning a 300-second balance.
    const per = Number(env.LOCAL_PRICE_PER_SEC ?? 1000);
    return { lane, unit: "second", pricePerUnit: per,
             sessionTinybar: per * Number(env.LOCAL_SESSION_SECONDS ?? 300),
             topUpTinybar: per * Number(env.LOCAL_TOPUP_SECONDS ?? 150) };
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
  // Top-up must ALSO be priced per lane. A flat-priced top-up that credits at
  // lane value is the same theft as the mint route had: pay 200,000, be
  // credited up to 24,660,000, refund the difference.
  ...Object.fromEntries(Object.keys(LANES).map((l) => [`POST /topup/${l}/:id`, {
    accepts: [{
      scheme: "exact", network: NETWORK, payTo: env.SELLER_ACCOUNT_ID,
      price: { amount: String(lanePricing(l).topUpTinybar), asset: HBAR_ASSET },
      maxTimeoutSeconds: 180,
    }],
    description: `Top up a ${l} session (${lanePricing(l).topUpTinybar} tinybar)`,
    serviceName: "Pinout Compute", mimeType: "application/json", extensions: BAZAAR_EXT,
  }])),
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
  // A compute session must top up on its own priced lane route. Refused
  // here, BEFORE the flat-priced 402 is issued, so no money is taken.
  if (c.req.path.endsWith("/topup") && a.s.unit === "second") {
    return c.json({
      error: "this session tops up on its lane route",
      use: `POST /topup/${a.s.lane}/${a.s.id}`,
    }, 400);
  }
  await next();
});

// Admission control runs BEFORE the payment gate. Refusing after taking money
// would be worse than refusing at all.
app.use("/session", async (c, next) => {
  if (c.req.method !== "POST") return next();
  // Refuse BEFORE the payment gate. Taking money and then rejecting is worse
  // than rejecting outright.
  if (c.req.query("lane")) {
    return c.json({
      error: "compute lanes are not sold on this route",
      detail: "POST /compute/<lane> prices each lane inside the 402 you sign",
      lanes: Object.keys(LANES),
    }, 400);
  }
  const active = [...sessions.values()].filter((x) => x.state !== "CLOSED");
  const refusal = await admitAsync({ lane: null, activeSessions: active.length, activeGpu: 0 });
  if (refusal) return c.json(refusal, refusal.status);
  await next();
});

app.use("/compute/:lane", async (c, next) => {
  const lane = c.req.param("lane");
  if (!LANES[lane]) return c.json({ error: `unknown lane ${lane}`, lanes: Object.keys(LANES) }, 404);
  const active = [...sessions.values()].filter((s) => s.state !== "CLOSED");
  const refusal = await admitAsync({
    lane,
    activeSessions: active.length,
    activeGpu: active.filter((s) => RATES.lanes[s.lane]?.gpu).length,
  });
  if (refusal) return c.json(refusal, refusal.status);
  await next();
});

// Everything that can make a top-up impossible is checked BEFORE the payment
// gate. Otherwise the server issues a 402 for a session that is already closed,
// the buyer signs a real transaction, and only then gets a 409 — asking someone
// to sign a payment that cannot possibly succeed. Same rule as admission
// control on /compute/:lane: never quote a price for work we will not do.
app.use("/topup/:lane/:id", async (c, next) => {
  const lane = c.req.param("lane");
  if (!LANES[lane]) return c.json({ error: `unknown lane ${lane}`, lanes: Object.keys(LANES) }, 404);
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : c.req.query("token");
  if (!s.authorise(token)) return c.json({ error: "unauthorized" }, 401);
  if (s.lane !== lane) return c.json({ error: `session is lane ${s.lane}, not ${lane}` }, 400);
  if (s.state === "CLOSED" || s.state === "SETTLING") {
    return c.json({ error: `session is ${s.state}; cannot top up`,
                    detail: "no payment was requested — open a new session" }, 409);
  }
  await next();
});

app.use("*", paymentMiddleware(routes, resourceServer));

// Discovery: the bazaar extension declares the shape, this endpoint makes it
// enumerable so an agent can find these resources without being told the URLs.
app.get("/bazaar", (c) => c.json(bazaarCatalog()));

// Machine-readable lane catalogue. An agent must be able to find the compute
// capability from HTTP alone — a black-box consumer previously could not.
app.get("/health", async (c) => {
  const active = [...sessions.values()].filter((x) => x.state !== "CLOSED");
  return c.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    activeSessions: active.length,
    activeGpuSessions: active.filter((x) => RATES.lanes[x.lane]?.gpu).length,
    limits: LIMITS,
    providerSpend: spendReport(),
    pendingAnchors: pendingAnchor.length,
    sellerSolvency: await sellerSolvency([...sessions.values()].filter((x) => x.state !== "CLOSED").length),
    feePayer: FEE_PAYER,
    facilitator: CONFIG.facilitator,
  });
});

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

  const seconds = Math.floor(pricing.sessionTinybar / pricing.pricePerUnit);
  const tune = tuningFor("second", seconds);
  const s = new Session({
    payer: pay.payer, pricePerEvent: pricing.pricePerUnit,
    checkpointEvery: tune.checkpointEvery, topUpThreshold: tune.topUpThreshold,
    maxDurationMs: CONFIG.maxDurationMs,
  });
  s.lane = lane; s.unit = "second";
  const cr = creditFromPayment(s, pay, pricing.sessionTinybar, `/compute/${lane}`);
  if (cr.err) return c.json(cr.err, cr.err.status);
  const res = cr.res;
  sessions.set(s.id, s);
  saveSession(s);

  return c.json({
    sessionId: s.id, sessionSecret: s.secret,
    lane, provider: pricing.provider ?? "builtin", unit: "second",
    credits: res.credited, secondsPurchased: res.credited,
    pricePerSecondTinybar: pricing.pricePerUnit,
    topUpAtSecondsRemaining: tune.topUpThreshold,
    checkpointEverySeconds: tune.checkpointEvery,
    maxSessionDurationSeconds: Math.floor(s.maxDurationMs / 1000),
    howToRun: `GET /session/${s.id}/stream?provider=compute&n=<maxSeconds>&code=<base64 python>  with Authorization: Bearer <sessionSecret>`,
  });
});

app.post("/session", async (c) => {
  const pay = paymentContext(c);
  if (!pay) return c.json({ error: "no verified payment" }, 402);

  // /session is a FLAT-priced route. It must NEVER credit at lane value.
  //
  // Accepting ?lane= here priced the 402 at CONFIG.sessionTinybar (400,000) but
  // credited lanePricing(lane).sessionTinybar (up to 17,640,000 for cpu-4), and
  // the unused balance was refunded on-chain — so a buyer extracted many times
  // what they paid. Compute lanes are sold ONLY through /compute/:lane, where
  // the price is committed inside the 402 the buyer signs.
  if (c.req.query("lane")) {
    return c.json({
      error: "compute lanes are not sold on this route",
      detail: "POST /compute/<lane> prices each lane in the 402 you sign",
      lanes: Object.keys(LANES),
    }, 400);
  }
  const pricing = lanePricing(null);   // token-billed only, always flat-priced

  const s = new Session({
    payer: pay.payer,
    pricePerEvent: pricing.pricePerUnit,
    checkpointEvery: CONFIG.checkpointEvery,
    topUpThreshold: CONFIG.topUpThreshold,
    maxDurationMs: CONFIG.maxDurationMs,
  });
  s.lane = pricing.lane;
  s.unit = pricing.unit;
  // Fraud-simulation switch for the verifier demo. NEVER reachable publicly:
  // it corrupts the ledger (money still follows s.burned, so it is
  // self-sabotage rather than theft, but a public backdoor regardless).
  if (c.req.query("cheat") && String(env.ALLOW_CHEAT ?? "false") === "true") {
    s.cheat = Number(c.req.query("cheat"));
  }
  const cr = creditFromPayment(s, pay, CONFIG.sessionTinybar, "/session");
  if (cr.err) return c.json(cr.err, cr.err.status);
  const res = cr.res;
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

app.post("/topup/:lane/:id", async (c) => {
  const lane = c.req.param("lane");
  if (!LANES[lane]) return c.json({ error: `unknown lane ${lane}` }, 404);
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : c.req.query("token");
  if (!s.authorise(token)) return c.json({ error: "unauthorized" }, 401);
  if (s.lane !== lane) {
    return c.json({ error: `session is lane ${s.lane}, not ${lane}` }, 400);
  }
  if (s.state === "CLOSED" || s.state === "SETTLING") {
    return c.json({ error: `session is ${s.state}; cannot top up` }, 409);
  }
  const pay = paymentContext(c);
  if (!pay) return c.json({ error: "no verified payment" }, 402);

  const pricing = lanePricing(lane);
  const cr = creditFromPayment(s, pay, pricing.topUpTinybar, `/topup/${lane}`);
  if (cr.err) return c.json(cr.err, cr.err.status);
  const res = cr.res;
  s.touch(); saveSession(s);
  return c.json({ sessionId: s.id, lane, credited: res.credited,
                  duplicate: res.duplicate, credits: s.credits });
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

  const cr = creditFromPayment(s, pay, CONFIG.topUpTinybar, "/session/:id/topup");
  if (cr.err) return c.json(cr.err, cr.err.status);
  const res = cr.res;
  saveSession(s);
  return c.json({
    sessionId: s.id,
    credited: res.credited,
    duplicate: res.duplicate,   // idempotency is observable
    credits: s.credits,
  });
});

/**
 * Stage code out-of-band. A large base64 payload in a query string exceeds the
 * request-line limit and the connection is reset before any guard can run —
 * so oversized submissions must have a body-shaped path with a real 413.
 */
app.post("/session/:id/code", async (c) => {
  const a = authorised(c); if (a.err) return a.err;
  const body = await c.req.json().catch(() => null);
  const code = body?.code;
  if (typeof code !== "string") return c.json({ error: "expected {code: string}" }, 400);
  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes > LIMITS.maxCodeBytes) {
    return c.json({ error: "code too large", bytes, maxBytes: LIMITS.maxCodeBytes }, 413);
  }
  a.s.stagedCode = code;
  return c.json({ staged: true, bytes,
    next: `GET /session/${a.s.id}/stream?provider=compute&n=<maxSeconds>` });
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
  // Validate before doing anything. Number("abc") is NaN and Number("-5") is
  // negative; both previously produced a 200 that streamed nothing, so a client
  // with a bad parameter got silence instead of an error.
  const rawN = c.req.query("n");
  let n = rawN === undefined ? 500 : Number(rawN);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return c.json({ error: "n must be a non-negative integer", got: rawN }, 400);
  }
  // Hard ceiling regardless of credits held. A buyer with a large balance must
  // not be able to pin a GPU for an hour.
  if (s.unit === "second") {
    const cap = maxSecondsFor(s.lane);
    if (n > cap) n = cap;
  }
  let provider;
  try {
    provider = getProvider(c.req.query("provider") ?? env.PROVIDER ?? "llm");
  } catch (e) {
    // An unknown provider is the caller's mistake, not a server fault.
    return c.json({ error: e.message, providers: Object.keys(PROVIDERS) }, 400);
  }

  return streamSSE(c, async (stream) => {
    let sent = 0;
    // Prefer code staged via POST; fall back to the inline query param.
    const inline = c.req.query("code");
    if (inline && inline.length > LIMITS.maxCodeBytes) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({
        error: "code too large", maxBytes: LIMITS.maxCodeBytes,
        hint: `POST /session/${s.id}/code with {"code": "..."} then stream without the code param`,
      }) });
      return;
    }
    const jobCode = s.stagedCode
      ?? (inline ? Buffer.from(inline, "base64").toString("utf8") : undefined);
    try {
    for await (const ev of provider.stream({
      n, prompt: c.req.query("prompt"),
      // Lane comes from the SESSION, never the request — otherwise a caller
      // could pay cpu-small prices and run on a GPU.
      lane: s.lane, code: jobCode, sessionId: s.id,
      // Live credit balance so the provider can pause instead of dying.
      onBalance: () => s.credits,
    })) {
      if (ev.exhausted) {
        await stream.writeSSE({ event: "SessionTerminate", data: JSON.stringify({
          type: "SessionTerminate", session: s.id, cause: CAUSE.BALANCE_EXHAUSTED,
          note: ev.note, creditsRemaining: s.credits }) });
        break;
      }
      // A session closed mid-stream (buyer gave up, or closed while paused)
      // must release the machine NOW. Letting the loop sit out the rest of the
      // grace window bills the SELLER for up to 90s of idle machine on every
      // abandoned session.
      // Terminal states ONLY. The session is legitimately PAUSED while awaiting
      // a top-up and OPENING/ACTIVE the rest of the time — there is no "OPEN"
      // state, so testing for one here terminated every stream on its first event.
      if (s.state === "CLOSED" || s.state === "SETTLING") {
        await stream.writeSSE({ event: "SessionTerminate", data: JSON.stringify({
          type: "SessionTerminate", session: s.id, cause: CAUSE.CLIENT_DISCONNECT,
          note: "session closed — machine released" }) });
        break;
      }
      if (ev.provisionFailed) {
        // Never charge for a machine that was never provisioned.
        await stream.writeSSE({ event: "SessionTerminate", data: JSON.stringify({
          type: "SessionTerminate", session: s.id, cause: CAUSE.PROVIDER_ERROR,
          error: ev.error, note: ev.note, creditsRemaining: s.credits }) });
        break;
      }
      if (ev.waiting) {
        // Keeps the SSE channel alive while credits are zero. Never billed.
        await stream.writeSSE({ event: "SessionWaiting",
          data: JSON.stringify({ ...ev, credits: s.credits, sessionId: s.id }) });
        continue;
      }
      if (ev.paused || ev.resumed) {
        await stream.writeSSE({ event: ev.paused ? "SessionPaused" : "SessionResumed",
          data: JSON.stringify({ ...ev, credits: s.credits, sessionId: s.id, balance: s.credits }) });
        continue;   // not billed
      }
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
    } catch (e) {
      // A provider fault used to end the SSE with no frame at all, which is
      // indistinguishable from a dropped network connection — the buyer cannot
      // tell "your job crashed" from "your wifi blinked", and retries blindly.
      // The session stays OPEN so nothing already paid for is lost: close it to
      // be refunded, or stream again.
      console.error(`stream error on ${s.id}:`, e);
      try {
        await stream.writeSSE({ event: "SessionTerminate", data: JSON.stringify({
          type: "SessionTerminate", session: s.id, cause: CAUSE.PROVIDER_ERROR,
          error: e.message, creditsRemaining: s.credits,
          note: "the session is still open and your remaining credits are intact — " +
                "stream again, or close to be refunded",
        }) });
      } catch { /* socket already gone */ }
    } finally {
      s._streaming = false;
    }
  });
});

app.post("/session/:id/close", async (c) => {
  const a = authorised(c); if (a.err) return a.err;
  const s = a.s;
  // ?settlement=priority buys an immediate dedicated anchor — which costs the
  // seller ~0.7345 HBAR. Unauthenticated and unconditional, that is a free
  // drain: an attacker opens a session, burns nothing, closes with priority,
  // is fully refunded, and forces 0.7345 HBAR of seller spend per call.
  //
  // So priority is only honoured when the session's own revenue covers the
  // anchor. Otherwise it silently falls back to batched — the buyer still gets
  // an immediate refund, just a shared anchor.
  const wantsPriority = c.req.query("settlement") === "priority";
  const revenue = s.burned * s.pricePerEvent;
  s.settlementTier = wantsPriority && revenue >= ANCHOR_COST_TINYBAR ? "priority" : "batched";
  s.priorityDenied = wantsPriority && s.settlementTier !== "priority";
  const out = await settleSession(ctx, s, c.req.query("cause") ?? CAUSE.CLIENT_DISCONNECT);
  // Signed receipt: binds the settled payment to the consumption actually
  // recorded on the burn ledger and to the settlement anchor.
  const receipt = signReceipt({
    resourceUrl: new URL(c.req.url).toString(),
    sessionId: s.id, payer: s.payer, amount: s.paidTinybar,
    settlementTxId: s.fundingTxIds[0], unitsConsumed: s.burned, unit: "token",
    burnTopic: env.BURN_TOPIC_ID, burnFinalSeq: out.settlement?.body?.burnFinalSeq ?? null,
    settlementTopic: env.TOPIC_ID, settlementTxOnTopic: out.settlement?.txId ?? null,
  });
  if (s.unit === "second") {
    try { recordSpend(lanePricing(s.lane).provider, s.burned, s.lane); } catch { /* non-fatal */ }
  }
  saveSession(s);
  return c.json({
    receipt,
    receiptSigner: { kid: keyId(), publicKey: sellerPublicKeyHex() },
    sessionId: s.id,
    ...out.terminate,
    anchored: out.anchored,
    anchorPending: out.anchorPending ?? false,
    ...(s.priorityDenied ? { priorityDenied: {
      reason: "session revenue does not cover a dedicated anchor",
      revenueTinybar: s.burned * s.pricePerEvent,
      anchorCostTinybar: ANCHOR_COST_TINYBAR,
      settledAs: "batched",
    } } : {}),
    settlementTier: out.settlementTier,
    anchorError: out.anchorError ?? undefined,
    settlementTx: out.settlement?.txId ?? null,
    settlementTxUrl: out.settlement ? hashscan.tx(out.settlement.txId) : null,
    settlementFeeTinybar: out.settlement?.paidToBuyer,
    settlementFeeCollector: "fixed at topic creation; read it from the topic on the mirror node",
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
      checkpointEvery: r.checkpointEvery ?? CONFIG.checkpointEvery,
      topUpThreshold: r.topUpThreshold ?? CONFIG.topUpThreshold,
      maxDurationMs: CONFIG.maxDurationMs,
    });
    s.id = r.id; s.state = r.state; s.credits = r.credits; s.burned = r.burned;
    s.paidTinybar = r.paidTinybar; s.fundingTxIds = r.fundingTxIds ?? [];
    s.lane = r.lane; s.unit = r.unit;
    // Restore the ORIGINAL bearer hash, or the buyer cannot reach the session
    // it paid for. The plaintext secret was never stored and is not needed —
    // authorise() compares hashes.
    if (r.secretHash) s.secretHash = Buffer.from(r.secretHash, "base64");
    s.seenTxIds = new Set(r.seenTxIds ?? r.fundingTxIds ?? []);
    s.lastCheckpointAt = r.lastCheckpointAt ?? 0;
    sessions.set(s.id, s);
    restored++;
  }
  if (restored) console.log(`restored        : ${restored} open session(s) from disk`);

  // Kill any sandbox we left behind. An orphan bills per second in silence and
  // is the most expensive class of bug in this system.
  try {
    const reaped = await reapOrphans();
    if (reaped.daytona || reaped.modal) {
      console.log(`orphans reaped  : ${reaped.daytona} daytona, ${reaped.modal} modal`);
    }
  } catch (e) { console.error("orphan reap failed:", e.message); }

  // Reap abandoned sessions. Without this a buyer that pays and walks away
  // loses its money permanently — the service keeps funds for undelivered
  // service. Batched so cleanup cannot be turned into a drain on the seller.
  // Flush queued anchors on an interval so one write covers many sessions.
  const anchorSweep = setInterval(async () => {
    try {
      const out = await flushPendingAnchors(ctx);
      if (out) console.log(`anchor batch    : ${out.count} session(s) in ONE anchor ${out.anchor.txId}`);
    } catch (e) { console.error("anchor batch failed (will retry):", e.message); }
  }, Number(env.ANCHOR_SWEEP_MS ?? 120_000));
  anchorSweep.unref?.();

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
