// Run a demo job against a live club server over HTTP.
//
// Nothing here imports the server. It creates a workspace, opens a chat,
// uploads files, starts a run, follows the SSE stream, answers funding
// requests, downloads the artifacts and checks them. That is exactly what a
// browser will do, which is the only reason it is worth running.
//
//   node club/demo.mjs --demo 1
//   node club/demo.mjs --demo 2
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { env } from "../src/config.mjs";

const BASE = process.env.CLUB_URL ?? "http://localhost:4022";
const OUT = process.env.DEMO_OUT ?? "/tmp/pinout-demo";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  agent: (s) => `\x1b[38;5;141m${s}\x1b[0m`, you: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  money: (s) => `\x1b[38;5;220m${s}\x1b[0m`, bad: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  ok: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
};
const hbar = (t) => `${(Number(t) / 1e8).toFixed(4)} ℏ`;
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const DEMOS = {
  1: {
    name: "background removal on a GPU",
    files: ["/tmp/pinout-test/person.mp4"],
    ceiling: 900_000_000,
    task:
      "The file person.mp4 is a short video of a person. Remove the background, " +
      "put a gradient behind them, and draw an outline around them. Write the " +
      "result as an mp4 and deliver it back to me with deliver_file. Then tell " +
      "me what it cost and what was refunded.",
    // what the result has to satisfy to count as a success
    expect: { kind: "video", minBytes: 20_000, minFrames: 30 },
  },
  2: {
    name: "people counting, deliberately under-funded",
    files: ["/tmp/pinout-test/crowd.mp4"],
    ceiling: 900_000_000,
    // the first funding is capped low so the job MUST come back for more
    firstFundingCapTinybar: 150_000_000,
    task:
      "The file crowd.mp4 shows people walking. Count and track the people in " +
      "it. Write an annotated mp4 with boxes drawn on the people, deliver it " +
      "with deliver_file, and tell me the total number of distinct people you " +
      "counted, what it cost, and what was refunded.",
    expect: { kind: "video", minBytes: 20_000, minFrames: 30 },
  },
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

const jsonOr = async (r, what) => {
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${what}: ${r.status} ${b.error ?? ""}`);
  return b;
};

async function main() {
  const n = arg("demo", "1");
  const demo = DEMOS[n];
  if (!demo) throw new Error(`no demo ${n}`);
  mkdirSync(OUT, { recursive: true });

  console.log(C.b(`\ndemo ${n}: ${demo.name}\n`));

  const { workspace, capability: cap } =
    await jsonOr(await api("/workspace", { method: "POST", body: { title: demo.name } }),
      "create workspace");
  const wsId = workspace.id;
  console.log(C.dim(`workspace ${wsId.slice(0, 8)}`));

  const chat = await jsonOr(
    await api(`/workspace/${wsId}/chats`, { method: "POST", cap, body: { title: demo.name } }),
    "create chat");
  console.log(C.dim(`chat      ${chat.id.slice(0, 8)}`));

  for (const f of demo.files) {
    const buf = readFileSync(f);
    const a = await jsonOr(await api(`/workspace/${wsId}/chats/${chat.id}/files`, {
      method: "POST", cap,
      body: { name: basename(f), contentBase64: buf.toString("base64") },
    }), `upload ${f}`);
    console.log(C.dim(`attached  ${a.name}  ${a.bytes} bytes  ${a.contentType}`));
  }

  const funder = env.HEDERA_ACCOUNT_ID;
  let firstFundingDone = false;
  let fundedTotal = 0, topUps = 0;
  const state = { done: false, failed: false, answer: null, paused: null };

  // follow the run the way the browser does, over SSE
  const es = await fetch(`${BASE}/workspace/${wsId}/events?cap=${encodeURIComponent(cap)}`);
  const reader = es.body.getReader();
  const dec = new TextDecoder();

  const handle = async (ev) => {
    switch (ev.type) {
      case "tool":
        console.log(C.dim(`  ${ev.name} ${String(ev.args ?? "").slice(0, 110)}`));
        break;
      case "tool_failed":
        console.log(C.bad(`  ! ${ev.name} ${String(ev.result ?? "").slice(0, 160)}`));
        break;
      case "approval_needed": {
        console.log(`\n${C.agent("agent")} ${C.b("asks for")} ${C.money(hbar(ev.requestTinybar))}` +
          `  lane ${ev.lane}` +
          (ev.secondsCovered != null ? C.dim(`  (~${ev.secondsCovered}s)`) : ""));
        if (ev.plan) console.log(C.dim(`  plan: ${String(ev.plan).slice(0, 180)}`));

        // Demo 2 starves the first request on purpose so the top-up path runs.
        // Later requests are approved in full, which is the point being tested:
        // the agent must be able to recover, not merely to fail politely.
        let verdict = "approve", feedback = null;
        if (demo.firstFundingCapTinybar && !firstFundingDone &&
            ev.requestTinybar > demo.firstFundingCapTinybar) {
          verdict = "revise";
          feedback = `Start with ${demo.firstFundingCapTinybar} tinybar. Show me ` +
                     `progress and ask again for the rest.`;
          console.log(C.you(`you   revise: ${feedback}`));
        } else {
          console.log(C.you(`you   approve`));
        }
        await api(`/workspace/${wsId}/decide`, {
          method: "POST", cap, body: { verdict, feedback },
        });
        break;
      }
      case "funding_needed": {
        // stand in for the browser wallet signing a transfer
        const need = ev.needTinybar;
        const res = await jsonOr(await api(`/workspace/${wsId}/fund`, {
          method: "POST", cap, body: { funderAccountId: funder, tinybar: need },
        }), "fund").catch((e) => ({ error: e.message }));
        if (res.error) { console.log(C.bad(`  funding failed: ${res.error}`)); break; }
        if (res.opened) firstFundingDone = true; else topUps++;
        fundedTotal += res.tinybar ?? need;
        console.log(C.ok(`  funded ${hbar(res.tinybar ?? need)} -> ${res.accountId}`));
        break;
      }
      case "artifact":
        console.log(C.ok(`  artifact ${ev.name}  ${ev.bytes} bytes`));
        break;
      case "answer":
        state.answer = ev.text;
        break;
      case "state":
        if (ev.state === "done") state.done = true;
        if (ev.state === "failed") { state.failed = true; state.paused = ev.humanMessage ?? null; }
        break;
      case "error":
        if (ev.recoverable) console.log(C.money(`  PAUSED: ${ev.humanMessage}`));
        else console.log(C.bad(`  error: ${ev.message}`));
        break;
    }
  };

  const pump = (async () => {
    let buf = "";
    while (!state.done && !state.failed) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
      for (const f of frames) {
        const line = f.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try { await handle(JSON.parse(line.slice(5).trim())); } catch { /* keepalive */ }
      }
    }
  })();

  await jsonOr(await api(`/workspace/${wsId}/chats/${chat.id}/run`, {
    method: "POST", cap, body: { task: demo.task, ceilingTinybar: demo.ceiling },
  }), "start run");
  console.log(C.you(`\nyou   ${demo.task.slice(0, 120)}...\n`));

  await Promise.race([pump, new Promise((r) => setTimeout(r, 30 * 60_000))]);
  await reader.cancel().catch(() => {});

  // ---- what actually came back ----
  const files = await jsonOr(await api(`/workspace/${wsId}/chats/${chat.id}`, { cap }), "read chat");
  const arts = files.artifacts ?? [];
  console.log(`\n${C.b("artifacts")}: ${arts.length}`);

  const saved = [];
  for (const a of arts) {
    const r = await api(`/workspace/${wsId}/files/${a.id}`, { cap });
    const buf = Buffer.from(await r.arrayBuffer());
    const sha = createHash("sha256").update(buf).digest("hex");
    const path = join(OUT, `demo${n}-${a.name}`);
    writeFileSync(path, buf);
    const intact = sha === a.sha256;
    console.log(`  ${a.name}  ${buf.length} bytes  sha ${intact ? "ok" : C.bad("MISMATCH")}  -> ${path}`);
    saved.push({ ...a, path, bytes: buf.length, intact });
  }

  if (state.answer) console.log(`\n${C.agent("agent")} ${state.answer.slice(0, 1400)}\n`);

  const bal = await api(`/workspace/${wsId}/withdraw`, { method: "POST", cap, body: {} })
    .then((r) => r.json()).catch(() => null);
  if (bal?.withdrawn != null) console.log(C.money(`withdrew ${hbar(bal.withdrawn)} back to ${bal.to}`));
  await api(`/workspace/${wsId}/close`, { method: "POST", cap }).catch(() => {});

  const verdict = {
    demo: n, name: demo.name,
    finished: state.done && !state.failed,
    topUps, fundedTinybar: fundedTotal,
    artifacts: saved.map((s) => ({ name: s.name, bytes: s.bytes, path: s.path, intact: s.intact })),
  };
  writeFileSync(join(OUT, `demo${n}-verdict.json`), JSON.stringify(verdict, null, 2));
  console.log(C.b(`\nfinished=${verdict.finished}  artifacts=${saved.length}  topUps=${topUps}`));
  process.exit(verdict.finished && saved.length > 0 ? 0 : 1);
}

main().catch((e) => { console.error(C.bad(String(e.stack ?? e))); process.exit(2); });
