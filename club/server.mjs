// pinout.club — the hosted agent workspace.
//
// No login and no user table. A workspace is a random id plus a capability the
// browser holds; the server keeps only its hash. The wallet is connected solely
// to sign a funding transfer, never as an identity.
//
// Run:  node club/server.mjs
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { env } from "../src/config.mjs";
import * as ws from "./workspace.mjs";
import * as rt from "./runtime.mjs";
import { CUSTODY_DISCLOSURE, balanceOf } from "./wallet.mjs";

const app = new Hono();
app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization"] }));

/** Every workspace route proves the capability; nothing else identifies a caller. */
function claim(c) {
  const id = c.req.param("id");
  const h = c.req.header("Authorization") ?? "";
  const cap = h.startsWith("Workspace ") ? h.slice(10) : c.req.query("cap");
  const w = ws.authorise(id, cap);
  // 404 rather than 403: an unauthorised caller should not learn the id exists
  if (!w) return { err: c.json({ error: "no such workspace" }, 404) };
  return { w };
}

app.get("/", (c) => c.json({
  service: "pinout.club",
  model: "no login, no accounts. a workspace is an id plus a capability you keep.",
  custody: CUSTODY_DISCLOSURE,
  compute: env.PINOUT_URL ?? "http://localhost:4021",
  routes: {
    create: "POST /workspace",
    read: "GET /workspace/:id",
    run: "POST /workspace/:id/run",
    fund: "POST /workspace/:id/fund",
    events: "GET /workspace/:id/events  (SSE)",
    close: "POST /workspace/:id/close",
  },
}));

/** Mint a workspace. The capability is shown once and never stored in clear. */
app.post("/workspace", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { workspace, capability } = ws.createWorkspace({ title: body?.title });
  return c.json({
    workspace, capability,
    keepThis: "This capability is the only way back into this workspace. " +
              "It is not recoverable and does not follow you to another browser.",
  }, 201);
});

app.get("/workspace/:id", (c) => {
  const a = claim(c); if (a.err) return a.err;
  const run = rt.runOf(a.w.id);
  return c.json({
    ...ws.publicView(a.w),
    run: run ? { state: run.state, fundingRequest: run.fundingRequest, log: run.log.slice(-60) } : null,
  });
});

/** Hand the agent a task and a ceiling it cannot cross. */
app.post("/workspace/:id/run", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const body = await c.req.json().catch(() => ({}));
  const task = String(body?.task ?? "").trim();
  const budgetTinybar = Number(body?.budgetTinybar ?? 0);

  if (!task) return c.json({ error: "give the agent a task" }, 400);
  if (!Number.isFinite(budgetTinybar) || budgetTinybar <= 0) {
    return c.json({ error: "set a spending ceiling in tinybar" }, 400);
  }
  if (budgetTinybar > CUSTODY_DISCLOSURE.maxTinybar) {
    return c.json({
      error: "ceiling above what this build will custody",
      maxTinybar: CUSTODY_DISCLOSURE.maxTinybar,
    }, 400);
  }
  if (rt.runOf(a.w.id)) return c.json({ error: "this workspace already has a run in progress" }, 409);

  ws.appendMessage(a.w.id, { role: "user", text: task });
  try {
    const run = await rt.startRun(a.w.id, { task, budgetTinybar });
    return c.json({ started: true, state: run.state });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

/**
 * The human signed a transfer. Confirm it on chain and release the parked run.
 * The amount is never taken on trust from the browser.
 */
app.post("/workspace/:id/fund", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const body = await c.req.json().catch(() => ({}));
  const funderAccountId = String(body?.funderAccountId ?? "").trim();
  const expectTinybar = Number(body?.tinybar ?? 0);

  if (!/^\d+\.\d+\.\d+$/.test(funderAccountId)) {
    return c.json({ error: "funderAccountId must look like 0.0.12345" }, 400);
  }
  if (a.w.funder && a.w.funder !== funderAccountId) {
    return c.json({
      error: "this workspace is already bound to another account",
      boundTo: a.w.funder,
      why: "the balance can only ever be returned to the account that opened it",
    }, 409);
  }
  try {
    const out = await rt.applyFunding(a.w.id, { funderAccountId, expectTinybar });
    return c.json(out);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

/** Live run output. Replays what already happened so a reload loses nothing. */
app.get("/workspace/:id/events", (c) => {
  const a = claim(c); if (a.err) return a.err;
  return streamSSE(c, async (stream) => {
    const run = rt.runOf(a.w.id);
    if (!run) {
      await stream.writeSSE({ event: "idle", data: JSON.stringify({ state: a.w.state }) });
      return;
    }
    for (const ev of run.log) {
      await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
    }
    await new Promise((resolve) => {
      const onEvent = (ev) => {
        stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) }).catch(() => {});
        if (ev.type === "state" && ["done", "failed", "closed"].includes(ev.state)) resolve();
      };
      run.on("event", onEvent);
      stream.onAbort(() => { run.off("event", onEvent); resolve(); });
    });
  });
});

/** Close: stop the run, sweep the balance back to the funder, delete the account. */
app.post("/workspace/:id/close", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  try {
    const swept = await rt.closeWorkspace(a.w.id);
    return c.json({ closed: true, swept });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

app.get("/health", async (c) => c.json({
  ok: true,
  workspaces: ws.all().filter((w) => w.state !== "closed").length,
  compute: env.PINOUT_URL ?? "http://localhost:4021",
}));

export function start(port = Number(process.env.CLUB_PORT ?? 4022)) {
  // A workspace left open is a custodial balance nobody is watching, so idle
  // ones are closed and swept on a timer rather than left to sit.
  setInterval(async () => {
    for (const w of ws.expired()) {
      try {
        await rt.closeWorkspace(w.id);
        console.log(`swept idle workspace ${w.id.slice(0, 8)}`);
      } catch (e) { console.error(`sweep failed for ${w.id.slice(0, 8)}:`, e.message); }
    }
  }, 10 * 60 * 1000).unref();

  serve({ fetch: app.fetch, port });
  console.log(`pinout.club     : http://localhost:${port}`);
  console.log(`compute         : ${env.PINOUT_URL ?? "http://localhost:4021"}`);
  console.log(`custody         : per-workspace testnet account, swept back on close`);
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) start();

export { app };
