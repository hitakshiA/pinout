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
import { sendToWorkspace } from "./wallet.mjs";

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
  3: {
    name: "a four-step pipeline, CPU and GPU, building on its own output",
    files: ["/tmp/pinout-test/sensors.csv", "/tmp/pinout-test/crowd.mp4"],
    ceiling: 900_000_000,
    multi: true,
    // Four turns in ONE chat, so the wallet, the memory and the files persist
    // across them. Each step is meant to consume what the previous step made,
    // which is the thing single-shot demos never exercise.
    steps: [
      "Clean sensors.csv on the cheapest CPU lane that can do it: drop duplicates and " +
      "rows with a blank reading, lowercase the quality column and drop the bad ones, " +
      "and normalise every timestamp to unix seconds. Deliver the cleaned CSV and tell " +
      "me how many rows survived.",

      "Using the cleaned CSV you just delivered, not the original, compute per-sensor " +
      "summary statistics: count, mean, standard deviation and range of reading for " +
      "each sensor id. Deliver that as a CSV. A CPU lane is enough for this.",

      "Now the video. Count and track the people in crowd.mp4 on a GPU lane, draw boxes " +
      "with track ids, and deliver an annotated mp4. Release the GPU as soon as the " +
      "annotation is written.",

      "Write me a short plain-text report tying it together: how many sensor rows " +
      "survived cleaning, how many distinct sensors there were, and how many distinct " +
      "people you counted in the video. Use the files you already produced rather than " +
      "recomputing anything, and deliver the report as a .txt.",
    ],
    expect: { artifacts: 4 },
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

/**
 * Close the workspace if this process is killed.
 *
 * A demo client dying does not close the session it opened: the server keeps
 * holding the machine until the expiry sweep notices, and with one GPU slot
 * that means the next run is refused for the next five minutes. Every
 * interrupted run so far has cost the following one.
 */
function cleanupOn(wsId, cap) {
  let done = false;
  const bail = async () => {
    if (done) return; done = true;
    // Awaited properly. The first version called exit() in the same tick the
    // close was dispatched, so the request never left and the session stayed
    // open. Three GPU slots ended up held by runs that had already been killed.
    try {
      await api(`/workspace/${wsId}/close`, { method: "POST", cap });
      console.log(C.dim("\nclosed workspace on exit"));
    } catch { /* going down anyway */ }
    process.exit(130);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { bail(); });
  }
}

/**
 * Do not start a run that is going to be refused. A leaked session holds an
 * accelerator until the expiry sweep notices, and starting anyway burns the
 * funding approval on a rent that cannot succeed.
 */
async function waitForCapacity(lane = "gpu", tries = 40) {
  const compute = process.env.PINOUT_URL ?? "http://localhost:4031";
  for (let i = 0; i < tries; i++) {
    try {
      const h = await fetch(`${compute}/health`).then((r) => r.json());
      const free = lane === "gpu"
        ? h.activeGpuSessions < h.limits.maxConcurrentGpu
        : h.activeSessions < h.limits.maxConcurrentSessions;
      if (free && h.sellerSolvency?.solvent) return true;
      if (i === 0) {
        console.log(C.dim(`waiting for capacity: gpu ${h.activeGpuSessions}/` +
          `${h.limits.maxConcurrentGpu}, solvent ${h.sellerSolvency?.solvent}`));
      }
    } catch { /* server may be restarting */ }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return false;
}

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
  cleanupOn(wsId, cap);

  if (!await waitForCapacity("gpu")) {
    console.log(C.bad("no capacity after waiting; not starting a run that will be refused"));
    process.exit(3);
  }

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
  const state = { done: false, failed: false, answer: null, paused: null, allDone: false };

  // follow the run the way the browser does, over SSE
  // no body timeout: a quiet stream during long GPU work is normal, not a fault
  const es = await fetch(`${BASE}/workspace/${wsId}/events?cap=${encodeURIComponent(cap)}`,
    { signal: AbortSignal.timeout(3 * 60 * 60_000) });
  const reader = es.body.getReader();
  const dec = new TextDecoder();

  const handle = async (ev) => {
    switch (ev.type) {
      case "reasoning":
      case "text":
        // deltas: a real UI types these out; here they only prove they arrive
        process.stdout.write(ev.type === "reasoning" ? C.dim(ev.delta) : ev.delta);
        break;
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
        // Stand in for the browser wallet signing a transfer.
        //
        // Opening the account moves money as a side effect of creating it, so
        // the first funding works with nothing but a POST. A top-up has no
        // such side effect: the account exists, and somebody has to actually
        // send HBAR before /fund can confirm anything. Treating the resulting
        // {pending:true} as success printed "funded 0.5000" for a transfer
        // that had never happened, and the run then waited forever.
        const need = ev.needTinybar;
        try {
          const wsNow = await jsonOr(await api(`/workspace/${wsId}`, { cap }), "read workspace");
          if (wsNow.walletAccount) {
            const sent = await sendToWorkspace({
              accountId: wsNow.walletAccount, tinybar: need, from: funder,
            });
            console.log(C.dim(`  sent ${hbar(sent.tinybar)}  ${sent.txId}`));
          }
          // the mirror node lags the transaction it is being asked about
          let res = null;
          for (let i = 0; i < 15; i++) {
            res = await jsonOr(await api(`/workspace/${wsId}/fund`, {
              method: "POST", cap, body: { funderAccountId: funder, tinybar: need },
            }), "fund");
            if (!res.pending) break;
            await new Promise((r) => setTimeout(r, 2500));
          }
          if (res?.pending) { console.log(C.bad("  transfer never confirmed")); break; }
          if (res.opened) firstFundingDone = true; else topUps++;
          fundedTotal += res.tinybar ?? need;
          console.log(C.ok(`  funded ${hbar(res.tinybar ?? need)} -> ${res.accountId}`));
        } catch (e) { console.log(C.bad(`  funding failed: ${e.message}`)); }
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
        if (ev.state === "failed") {
          state.failed = true;
          state.paused = ev.humanMessage ?? null;
          state.partial = !!ev.partial;
          if (ev.partial) {
            console.log(C.money(`  run ended badly but ${ev.deliveredCount} artifact(s) survived`));
          }
        }
        break;
      case "error":
        if (ev.recoverable) console.log(C.money(`  PAUSED: ${ev.humanMessage}`));
        else console.log(C.bad(`  error: ${ev.message}`));
        break;
    }
  };

  // the pump must outlive any single step, or step two streams nothing
  const pump = (async () => {
    let buf = "";
    while (!state.allDone) {
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

  const steps = demo.multi ? demo.steps : [demo.task];

  /** One step. Resolves when the run reaches a terminal state. */
  const runStep = async (task, n) => {
    state.done = false; state.failed = false; state.answer = null;
    console.log(C.you(`\nyou   [${n}/${steps.length}] ${task.slice(0, 110)}...\n`));
    await jsonOr(await api(`/workspace/${wsId}/chats/${chat.id}/run`, {
      method: "POST", cap, body: { task, ceilingTinybar: demo.ceiling },
    }), "start run");
    const until = Date.now() + 28 * 60_000;
    while (!state.done && !state.failed && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    const arts = await jsonOr(await api(`/workspace/${wsId}/chats/${chat.id}`, { cap }), "read chat");
    console.log(C.b(`  step ${n} ${state.failed ? "failed" : "done"} · artifacts so far: ${(arts.artifacts ?? []).length}`));
    if (state.answer) console.log(C.dim(`  ${state.answer.slice(0, 260).replace(/\s+/g, " ")}`));
  };

  for (const [i, t] of steps.entries()) await runStep(t, i + 1);
  state.allDone = true;
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
    // two different questions: did the run close cleanly, and did the work
    // arrive. Collapsing them made a delivered, correct result read as a
    // failure because the machine was lost while tidying up afterwards.
    finished: state.done && !state.failed,
    delivered: saved.length > 0 && saved.every((x) => x.intact),
    partial: !!state.partial,
    topUps, fundedTinybar: fundedTotal,
    artifacts: saved.map((s) => ({ name: s.name, bytes: s.bytes, path: s.path, intact: s.intact })),
  };
  writeFileSync(join(OUT, `demo${n}-verdict.json`), JSON.stringify(verdict, null, 2));
  console.log(C.b(`\nfinished=${verdict.finished}  artifacts=${saved.length}  topUps=${topUps}`));
  process.exit(verdict.finished && saved.length > 0 ? 0 : 1);
}

main().catch((e) => { console.error(C.bad(String(e.stack ?? e))); process.exit(2); });
