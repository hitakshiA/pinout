// Exercise every club route over HTTP, the way a browser will.
//
// Nothing here imports the server's internals. It talks to a running process
// through the same API the frontend gets, because a route that only works when
// called in-process is a route that does not work.
//
//   node club/server.mjs &
//   node club/test-routes.mjs
const BASE = process.env.CLUB_URL ?? "http://localhost:4022";

let pass = 0, fail = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    pass++; results.push(`PASS  ${name}`);
  } catch (e) {
    fail++; results.push(`FAIL  ${name}\n        ${e.message}`);
  }
}
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: expected ${want}, got ${got}`);
};

const api = (path, { method = "GET", cap, body } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cap ? { Authorization: `Workspace ${cap}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const main = async () => {
  let wsId, cap, chatId, assetId;

  await check("GET / describes the service", async () => {
    const r = await api("/");
    eq(r.status, 200, "status");
    const b = await r.json();
    if (!b.routes?.chats) throw new Error("no chat routes advertised");
    if (!b.custody?.custodial) throw new Error("custody disclosure missing");
  });

  await check("POST /workspace mints a capability", async () => {
    const r = await api("/workspace", { method: "POST", body: { title: "route test" } });
    eq(r.status, 201, "status");
    const b = await r.json();
    wsId = b.workspace.id; cap = b.capability;
    if (!wsId || !cap) throw new Error("missing id or capability");
    if (JSON.stringify(b.workspace).includes("capHash")) throw new Error("capHash leaked");
  });

  await check("GET /workspace/:id without a capability is 404, not 403", async () => {
    const r = await api(`/workspace/${wsId}`);
    // 403 would confirm the id exists to someone who should not know that
    eq(r.status, 404, "status");
  });

  await check("GET /workspace/:id with a WRONG capability is 404", async () => {
    const r = await api(`/workspace/${wsId}`, { cap: "not-the-capability" });
    eq(r.status, 404, "status");
  });

  await check("GET /workspace/:id with the capability works", async () => {
    const r = await api(`/workspace/${wsId}`, { cap });
    eq(r.status, 200, "status");
    const b = await r.json();
    eq(b.id, wsId, "id");
  });

  await check("POST /workspace/:id/chats creates a chat", async () => {
    const r = await api(`/workspace/${wsId}/chats`, {
      method: "POST", cap, body: { title: "first chat" },
    });
    eq(r.status, 201, "status");
    const b = await r.json();
    chatId = b.id;
    eq(b.contextLimit, 200000, "context limit");
  });

  await check("GET /workspace/:id/chats lists it", async () => {
    const r = await api(`/workspace/${wsId}/chats`, { cap });
    const b = await r.json();
    eq(b.chats.length, 1, "chat count");
    eq(b.chats[0].id, chatId, "chat id");
    eq(b.activeChatId, null, "no run yet");
  });

  await check("POST chat files attaches an input", async () => {
    const r = await api(`/workspace/${wsId}/chats/${chatId}/files`, {
      method: "POST", cap,
      body: { name: "hello.csv", contentBase64: Buffer.from("a,b\n1,2\n").toString("base64") },
    });
    eq(r.status, 201, "status");
    const b = await r.json();
    assetId = b.id;
    eq(b.bytes, 8, "bytes");
    eq(b.contentType, "text/csv", "type");
    if (!b.sha256) throw new Error("no sha256");
  });

  await check("GET chat shows the log, assets and artifacts", async () => {
    const r = await api(`/workspace/${wsId}/chats/${chatId}`, { cap });
    const b = await r.json();
    eq(b.assets.length, 1, "assets");
    eq(b.artifacts.length, 0, "artifacts");
    eq(b.assets[0].name, "hello.csv", "asset name");
  });

  await check("files are scoped to their chat", async () => {
    const r2 = await api(`/workspace/${wsId}/chats`, {
      method: "POST", cap, body: { title: "second chat" },
    });
    const other = (await r2.json()).id;
    const r = await api(`/workspace/${wsId}/chats/${other}`, { cap });
    const b = await r.json();
    // the second chat must not see the first chat's upload
    eq(b.assets.length, 0, "other chat's assets");
    await api(`/workspace/${wsId}/chats/${other}`, { method: "DELETE", cap });
  });

  await check("GET a file downloads the bytes with its hash", async () => {
    const r = await api(`/workspace/${wsId}/files/${assetId}`, { cap });
    eq(r.status, 200, "status");
    eq(r.headers.get("x-sha256")?.length, 64, "sha256 header");
    const text = await r.text();
    eq(text, "a,b\n1,2\n", "content");
  });

  await check("a file cannot be read with another workspace's capability", async () => {
    const other = await (await api("/workspace", { method: "POST", body: {} })).json();
    const r = await api(`/workspace/${other.workspace.id}/files/${assetId}`,
      { cap: other.capability });
    eq(r.status, 404, "status");
  });

  await check("run rejects a missing task", async () => {
    const r = await api(`/workspace/${wsId}/chats/${chatId}/run`, {
      method: "POST", cap, body: { ceilingTinybar: 1000000 },
    });
    eq(r.status, 400, "status");
  });

  await check("run rejects a missing ceiling", async () => {
    const r = await api(`/workspace/${wsId}/chats/${chatId}/run`, {
      method: "POST", cap, body: { task: "do a thing" },
    });
    eq(r.status, 400, "status");
  });

  await check("run rejects a ceiling above what this build will custody", async () => {
    const r = await api(`/workspace/${wsId}/chats/${chatId}/run`, {
      method: "POST", cap, body: { task: "x", ceilingTinybar: 99_000_000_000 },
    });
    eq(r.status, 400, "status");
  });

  await check("decide with no run in progress is a conflict", async () => {
    const r = await api(`/workspace/${wsId}/decide`, {
      method: "POST", cap, body: { verdict: "approve" },
    });
    eq(r.status, 409, "status");
  });

  await check("decide rejects an unknown verdict", async () => {
    const r = await api(`/workspace/${wsId}/decide`, {
      method: "POST", cap, body: { verdict: "maybe" },
    });
    eq(r.status, 400, "status");
  });

  await check("revise without feedback is refused", async () => {
    const r = await api(`/workspace/${wsId}/decide`, {
      method: "POST", cap, body: { verdict: "revise" },
    });
    eq(r.status, 400, "status");
  });

  await check("withdraw before a wallet exists is a conflict", async () => {
    const r = await api(`/workspace/${wsId}/withdraw`, { method: "POST", cap, body: {} });
    eq(r.status, 409, "status");
  });

  await check("fund rejects a malformed account id", async () => {
    const r = await api(`/workspace/${wsId}/fund`, {
      method: "POST", cap, body: { funderAccountId: "nonsense", tinybar: 100000000 },
    });
    eq(r.status, 400, "status");
  });

  await check("SSE events stream opens and reports idle", async () => {
    const r = await fetch(`${BASE}/workspace/${wsId}/events?cap=${encodeURIComponent(cap)}`);
    eq(r.status, 200, "status");
    if (!/text\/event-stream/.test(r.headers.get("content-type") ?? "")) {
      throw new Error("not an event stream");
    }
    const reader = r.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    if (!chunk.includes("idle")) throw new Error(`expected idle frame, got ${chunk.slice(0, 80)}`);
    await reader.cancel();
  });

  await check("DELETE a chat removes it", async () => {
    const r = await api(`/workspace/${wsId}/chats/${chatId}`, { method: "DELETE", cap });
    eq(r.status, 200, "status");
    const list = await (await api(`/workspace/${wsId}/chats`, { cap })).json();
    eq(list.chats.length, 0, "chats left");
  });

  await check("GET /health reports without a capability", async () => {
    const r = await api("/health");
    eq(r.status, 200, "status");
    const b = await r.json();
    if (typeof b.workspaces !== "number") throw new Error("no workspace count");
  });

  await check("close a workspace with no wallet succeeds", async () => {
    const r = await api(`/workspace/${wsId}/close`, { method: "POST", cap });
    eq(r.status, 200, "status");
  });

  console.log(results.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error("harness blew up:", e); process.exit(2); });
