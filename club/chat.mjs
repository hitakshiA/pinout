// Talk to a workspace agent from a terminal, the way the web UI will.
//
// This is the same surface the browser gets: create a workspace, attach files,
// give it a task and a ceiling, watch events, answer the funding request, and
// read the receipt at the end. Rendering it as a chat log here is deliberate.
// A funding request that reads badly in a terminal will read badly in a chat
// bubble, and it is much cheaper to find that out now.
//
//   node club/chat.mjs --task "..." --files a.csv,b.json --ceiling 300000000
//   node club/chat.mjs --scenario gpu-train --auto approve
import { createInterface } from "node:readline/promises";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { env } from "../src/config.mjs";
import * as ws from "./workspace.mjs";
import * as assets from "./assets.mjs";
import * as rt from "./runtime.mjs";
import { CUSTODY_DISCLOSURE, balanceOf, sendToWorkspace } from "./wallet.mjs";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  agent: (s) => `\x1b[38;5;141m${s}\x1b[0m`,
  human: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  money: (s) => `\x1b[38;5;220m${s}\x1b[0m`,
  bad: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  ok: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
};

const hbar = (t) => `${(Number(t) / 1e8).toFixed(4)} ℏ`;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Render one run event as a line of chat. */
function render(ev) {
  switch (ev.type) {
    case "task":
      console.log(`\n${C.human("you")}  ${ev.task}`);
      console.log(C.dim(`     ceiling ${hbar(ev.ceilingTinybar)}\n`));
      break;
    case "tool":
      console.log(C.dim(`  ${ev.name}  ${ev.args.slice(0, 150)}`));
      break;
    case "approval_needed": {
      const over = ev.overCeiling ? C.bad("  OVER YOUR CEILING") : "";
      console.log(`\n${C.agent("agent")} ${C.b("asks to spend")} ${C.money(hbar(ev.requestTinybar))}${over}`);
      console.log(`      lane      ${ev.lane}` +
        (ev.laneTinybarPerSecond ? C.dim(`  (${ev.laneTinybarPerSecond} tinybar/s)`) : ""));
      console.log(`      for       ${ev.estimatedSeconds}s` +
        (ev.secondsCovered != null ? C.dim(`, this buys ~${ev.secondsCovered}s`) : ""));
      if (ev.shortOfClaim) console.log(`      ${C.bad("mismatch")}  ${ev.shortOfClaim}`);
      if (ev.accountFloorApplied) {
        console.log(`      ${C.money("you send")}  ${hbar(ev.transferTinybar)} ` +
          C.dim("(Hedera's minimum to open an account; the rest comes back on close)"));
      }
      console.log(`      plan      ${ev.plan}`);
      console.log(`      because   ${ev.reasoning}\n`);
      break;
    }
    case "decision":
      console.log(`${C.human("you")}  ${C.b(ev.verdict)}${ev.feedback ? `: ${ev.feedback}` : ""}\n`);
      break;
    case "funding_needed":
      console.log(C.dim(`  waiting for ${hbar(ev.needTinybar)} to land on chain...`));
      break;
    case "funded":
      console.log(C.ok(`  funded ${ev.accountId} with ${hbar(ev.tinybar)}\n`));
      break;
    case "balance":
      if (ev.tinybar != null) console.log(C.dim(`  wallet now holds ${hbar(ev.tinybar)}`));
      break;
    case "answer":
      console.log(`\n${C.agent("agent")} ${ev.text}\n`);
      break;
    case "tool_failed":
      console.log(C.bad(`  ${ev.name} FAILED  ${ev.result.slice(0, 300)}`));
      break;
    case "tool_result":
      console.log(C.dim(`    -> ${ev.result.slice(0, 160)}`));
      break;
    case "error":
      if (ev.recoverable) {
        console.log(C.money(`\n  PAUSED  ${ev.humanMessage}`));
        console.log(C.dim(`          (${ev.message})`));
      } else {
        console.log(C.bad(`  error: ${ev.message}`));
      }
      break;
    case "withdrawn":
      console.log(C.money(`  withdrew ${hbar(ev.withdrawn)} back to ${ev.to}`));
      break;
    case "state":
      console.log(C.dim(`  [${ev.state}]`));
      break;
    default:
      console.log(C.dim(`  · ${ev.type} ${JSON.stringify(ev).slice(0, 200)}`));
  }
}

// A silent exit is the worst failure mode here: the agent is holding a rented
// machine that bills by the second, and a dropped promise looks exactly like a
// finished job. Say why the process is going down, always.
process.on("unhandledRejection", (e) => {
  console.log(C.bad(`\nUNHANDLED REJECTION: ${e?.stack ?? e}`));
});
process.on("uncaughtException", (e) => {
  console.log(C.bad(`\nUNCAUGHT: ${e?.stack ?? e}`));
});
process.on("beforeExit", (code) => {
  console.log(C.bad(`\nEVENT LOOP DRAINED (code ${code}) — nothing left to wait on. ` +
    `If a machine is still rented it is STILL BILLING.`));
});

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const auto = arg("auto");                 // approve | deny | revise:<text>
  const ceiling = Number(arg("ceiling", "500000000"));
  const task = arg("task");
  const files = (arg("files") ?? "").split(",").filter(Boolean);

  if (!task) {
    console.error("give me --task \"...\"");
    process.exit(1);
  }

  console.log(C.b("\npinout.club\n"));
  console.log(C.dim(CUSTODY_DISCLOSURE.summary));
  console.log(C.dim(`compute: ${env.PINOUT_URL ?? "http://localhost:4021"}\n`));

  const { workspace, capability } = ws.createWorkspace({ title: task.slice(0, 60) });
  console.log(C.dim(`workspace ${workspace.id.slice(0, 8)}  cap ${capability.slice(0, 10)}...`));

  for (const f of files) {
    if (!existsSync(f)) { console.log(C.bad(`missing file ${f}`)); continue; }
    const a = assets.put(workspace.id, { name: basename(f), bytes: readFileSync(f) });
    console.log(C.dim(`attached ${a.name}  ${a.bytes} bytes  ${a.contentType}`));
  }

  const run = await rt.startRun(workspace.id, { task, ceilingTinybar: ceiling });

  // The funder. In the browser this is the user's own wallet signing a
  // transfer; here the operator account stands in for it.
  const funder = env.HEDERA_ACCOUNT_ID;

  let settled = false;
  run.on("event", async (ev) => {
    render(ev);

    if (ev.type === "approval_needed") {
      let verdict = auto, feedback = null;
      if (auto?.startsWith("revise:")) { verdict = "revise"; feedback = auto.slice(7); }
      if (!auto) {
        const a = await rl.question(C.b("approve / deny / revise <what to change> > "));
        const [v, ...rest] = a.trim().split(/\s+/);
        verdict = v; feedback = rest.join(" ") || null;
      }
      try {
        await rt.decide(workspace.id, { verdict, feedback });
      } catch (e) { console.log(C.bad(`decide failed: ${e.message}`)); }
    }

    if (ev.type === "funding_needed") {
      // Stand in for the user signing a transfer in the browser.
      //
      // On the first funding the server opens the account, which moves the
      // money itself. On a top-up the account already exists, so somebody has
      // to actually send HBAR before the server can confirm anything. Missing
      // this is what killed the first top-up: the agent asked, nothing was
      // transferred, confirmFunding correctly found no new deposit, and the
      // run sat on a promise nobody would ever resolve.
      try {
        const w = ws.get(workspace.id);
        if (w?.wallet) {
          const sent = await sendToWorkspace({
            accountId: w.wallet.accountId, tinybar: ev.needTinybar, from: funder,
          });
          console.log(C.dim(`  sent ${hbar(sent.tinybar)}  ${sent.txId}`));
        }
        // the mirror node lags the transaction, so confirmation is retried
        let out = null;
        for (let i = 0; i < 12; i++) {
          out = await rt.applyFunding(workspace.id, {
            funderAccountId: funder, expectTinybar: ev.needTinybar,
          });
          if (!out.pending) break;
          await new Promise((r) => setTimeout(r, 2500));
        }
        if (out?.pending) console.log(C.bad("  transfer never showed on the mirror node"));
      } catch (e) { console.log(C.bad(`  funding failed: ${e.message}`)); }
    }

    if (ev.type === "state" && ["done", "failed"].includes(ev.state) && !settled) {
      settled = true;
      const w = ws.get(workspace.id);
      if (w?.wallet) {
        const before = await balanceOf(w.wallet.accountId).catch(() => null);
        console.log(C.dim(`\n  closing workspace, sweeping ${hbar(before ?? 0)} back to ${funder}`));
        const swept = await rt.closeWorkspace(workspace.id).catch((e) => ({ error: e.message }));
        if (swept?.closed) {
          console.log(C.ok(`  returned ${hbar(swept.returnedTinybar)} to ${swept.to}, account deleted`));
        } else {
          console.log(C.bad(`  sweep failed: ${swept?.error ?? "unknown"}`));
        }
      }
      rl.close();
      process.exit(ev.state === "done" ? 0 : 1);
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
