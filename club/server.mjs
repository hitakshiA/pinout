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
import * as assets from "./assets.mjs";
import * as threads from "./threads.mjs";
import { CUSTODY_DISCLOSURE, balanceOf, withdraw } from "./wallet.mjs";

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
    decide: "POST /workspace/:id/decide  (approve | deny | revise)",
    withdraw: "POST /workspace/:id/withdraw  (any time, even mid job)",
    chats: "POST|GET /workspace/:id/chats",
    chat: "GET /workspace/:id/chats/:chatId  (log, assets, artifacts, run)",
    chatRun: "POST /workspace/:id/chats/:chatId/run",
    chatFiles: "POST /workspace/:id/chats/:chatId/files",
    attach: "POST /workspace/:id/files",
    listFiles: "GET /workspace/:id/files",
    download: "GET /workspace/:id/files/:assetId",
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
    run: run ? {
      state: run.state,
      awaitingApproval: run.pendingApproval,
      ceilingTinybar: run.ceilingTinybar,
      approvals: run.approvals,
      log: run.log.slice(-80),
    } : null,
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
    const run = await rt.startRun(a.w.id, { task, ceilingTinybar: budgetTinybar });
    return c.json({ started: true, state: run.state });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

/**
 * The human's verdict on what the agent asked to spend.
 *
 * Three answers, not two. "Change the plan" is the interesting one: an agent
 * that picks a B300 for a job a T4 would do should be corrected, not denied and
 * left to guess. Both non-approvals reject the same tool call; only the message
 * the model receives differs.
 */
app.post("/workspace/:id/decide", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const body = await c.req.json().catch(() => ({}));
  const verdict = String(body?.verdict ?? "").toLowerCase();
  const feedback = body?.feedback ? String(body.feedback) : null;

  if (!["approve", "deny", "revise"].includes(verdict)) {
    return c.json({ error: "verdict must be approve, deny or revise" }, 400);
  }
  if (verdict === "revise" && !feedback) {
    return c.json({ error: "revise needs feedback saying what to change" }, 400);
  }
  try {
    return c.json(await rt.decide(a.w.id, { verdict, feedback }));
  } catch (e) {
    return c.json({ error: e.message }, 409);
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
    // Wait for a run rather than hanging up on a client that got here first.
    //
    // A browser subscribes and THEN posts the task, because doing it the other
    // way round races the opening events out of existence. This used to answer
    // "idle" and close, so every correctly written frontend saw an empty
    // stream and a job it could not watch.
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    let run = rt.runOf(a.w.id);
    if (!run) {
      await stream.writeSSE({ event: "idle", data: JSON.stringify({ state: a.w.state, waiting: true }) });
      run = await rt.waitForRun(a.w.id, { signal: ac.signal });
      if (!run) return;
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

/**
 * Chats.
 *
 * A workspace owns the wallet; a chat owns a conversation, its files and its
 * results. That split is deliberate. Opening a Hedera account costs roughly
 * 0.81 HBAR in fees, so giving every chat its own account would charge someone
 * a dollar to say hello. Chats share the wallet and are isolated in every other
 * respect: separate memory, separate inputs, separate artifacts.
 */
app.post("/workspace/:id/chats", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const body = await c.req.json().catch(() => ({}));
  const t = threads.createThread(a.w.id, { title: body?.title ?? "New chat" });
  return c.json(threads.publicView(t), 201);
});

app.get("/workspace/:id/chats", (c) => {
  const a = claim(c); if (a.err) return a.err;
  const run = rt.runOf(a.w.id);
  return c.json({
    chats: threads.forWorkspace(a.w.id).map((t) => ({
      id: t.id, title: t.title, updatedAt: t.updatedAt,
      turns: t.turns.length, artifacts: assets.artifactsOf(a.w.id, t.id).length,
      running: run?.threadId === t.id,
    })),
    // one run at a time per workspace: several agents spending one wallet
    // concurrently would race on the balance
    activeChatId: run?.threadId ?? null,
  });
});

/** Everything the UI needs to render one chat: log, files, results, run state. */
app.get("/workspace/:id/chats/:chatId", (c) => {
  const a = claim(c); if (a.err) return a.err;
  const t = threads.get(c.req.param("chatId"));
  if (!t || t.workspaceId !== a.w.id) return c.json({ error: "no such chat" }, 404);
  const run = rt.runOf(a.w.id);
  const strip = (x) => ({
    id: x.id, name: x.name, bytes: x.bytes, contentType: x.contentType,
    sha256: x.sha256, description: x.description ?? null,
  });
  return c.json({
    ...threads.publicView(t),
    assets: assets.forWorkspace(a.w.id, t.id).map(strip),
    artifacts: assets.artifactsOf(a.w.id, t.id).map(strip),
    run: run?.threadId === t.id ? {
      state: run.state, awaitingApproval: run.pendingApproval,
      ceilingTinybar: run.ceilingTinybar, log: run.log.slice(-120),
    } : null,
  });
});

app.delete("/workspace/:id/chats/:chatId", (c) => {
  const a = claim(c); if (a.err) return a.err;
  const t = threads.get(c.req.param("chatId"));
  if (!t || t.workspaceId !== a.w.id) return c.json({ error: "no such chat" }, 404);
  if (rt.runOf(a.w.id)?.threadId === t.id) {
    return c.json({ error: "this chat has a run in progress; stop it first" }, 409);
  }
  threads.remove(t.id);
  return c.json({ deleted: true });
});

/** Give the agent in this chat a task and a ceiling it cannot cross. */
app.post("/workspace/:id/chats/:chatId/run", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const t = threads.get(c.req.param("chatId"));
  if (!t || t.workspaceId !== a.w.id) return c.json({ error: "no such chat" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const task = String(body?.task ?? "").trim();
  const ceilingTinybar = Number(body?.ceilingTinybar ?? body?.budgetTinybar ?? 0);
  if (!task) return c.json({ error: "give the agent a task" }, 400);
  if (!(ceilingTinybar > 0)) return c.json({ error: "set a spending ceiling in tinybar" }, 400);
  if (rt.runOf(a.w.id)) return c.json({ error: "this workspace already has a run in progress" }, 409);

  threads.addTurn(t.id, { role: "user", text: task });
  if (t.title === "New chat") threads.rename(t.id, task.slice(0, 60));
  try {
    const run = await rt.startRun(a.w.id, { task, ceilingTinybar, threadId: t.id });
    // mirror the agent's output into the chat log so a reload shows the history
    run.on("event", (ev) => {
      if (ev.type === "answer") threads.addTurn(t.id, { role: "assistant", text: ev.text });
      if (ev.type === "tool") threads.addTurn(t.id, { role: "tool", text: ev.name, tool: ev });
    });
    return c.json({ started: true, state: run.state, chatId: t.id });
  } catch (e) { return c.json({ error: e.message }, 400); }
});

/** Attach a file to one chat. */
app.post("/workspace/:id/chats/:chatId/files", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const t = threads.get(c.req.param("chatId"));
  if (!t || t.workspaceId !== a.w.id) return c.json({ error: "no such chat" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  if (!name || typeof body?.contentBase64 !== "string") {
    return c.json({ error: "give a name and contentBase64" }, 400);
  }
  try {
    const asset = assets.put(a.w.id, {
      name, bytes: Buffer.from(body.contentBase64, "base64"), threadId: t.id,
    });
    threads.attachAsset(t.id, asset.id);
    return c.json({
      id: asset.id, name: asset.name, bytes: asset.bytes,
      contentType: asset.contentType, sha256: asset.sha256,
      needsChunking: asset.needsChunking,
    }, 201);
  } catch (e) { return c.json({ error: e.message }, 400); }
});

/**
 * Attach a file to the workspace. The agent never sees these bytes; it sees a
 * name and a size, and moves them onto a rented machine by name.
 */
app.post("/workspace/:id/files", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  const b64 = body?.contentBase64;
  if (!name || typeof b64 !== "string") {
    return c.json({ error: "give a name and contentBase64" }, 400);
  }
  try {
    const asset = assets.put(a.w.id, { name, bytes: Buffer.from(b64, "base64") });
    return c.json({
      id: asset.id, name: asset.name, bytes: asset.bytes,
      contentType: asset.contentType, sha256: asset.sha256,
      needsChunking: asset.needsChunking,
    }, 201);
  } catch (e) { return c.json({ error: e.message }, 400); }
});

/** What the human gave, and what the agent produced. */
app.get("/workspace/:id/files", (c) => {
  const a = claim(c); if (a.err) return a.err;
  const strip = (x) => ({
    id: x.id, name: x.name, bytes: x.bytes, contentType: x.contentType,
    sha256: x.sha256, description: x.description ?? null,
  });
  return c.json({
    inputs: assets.forWorkspace(a.w.id).map(strip),
    artifacts: assets.artifactsOf(a.w.id).map(strip),
  });
});

/** Download a result. Streams bytes, not base64 in a JSON envelope. */
app.get("/workspace/:id/files/:assetId", (c) => {
  const a = claim(c); if (a.err) return a.err;
  const asset = assets.get(c.req.param("assetId"));
  // scoped to the workspace: a capability for one must not read another's files
  if (!asset || asset.workspaceId !== a.w.id) return c.json({ error: "no such file" }, 404);
  const buf = assets.read(asset.id);
  return new Response(buf, {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(buf.length),
      "Content-Disposition": `attachment; filename="${asset.name.replace(/"/g, "")}"`,
      "X-Sha256": asset.sha256,
    },
  });
});

/**
 * Pull HBAR back out of the agent's wallet, at any time, including mid job.
 *
 * This is what makes funding the wallet a reasonable thing to ask for. The
 * human is not handing over money until the agent is finished with it; they
 * are lending it and can call it back. An agent that finds itself short simply
 * asks again, which it already knows how to do.
 */
app.post("/workspace/:id/withdraw", async (c) => {
  const a = claim(c); if (a.err) return a.err;
  const w = ws.get(a.w.id);
  if (!w?.wallet) return c.json({ error: "this workspace has no wallet" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const tinybar = body?.tinybar ? Number(body.tinybar) : null;
  if (tinybar != null && !(tinybar > 0)) {
    return c.json({ error: "tinybar must be positive, or omit it to withdraw everything" }, 400);
  }
  try {
    const out = await withdraw({ ...w.wallet, tinybar });
    rt.runOf(a.w.id)?.say("withdrawn", out);
    return c.json(out);
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
