// A general conversational agent — talk to it the way you'd talk to Claude.
//
// Multi-turn with persisted state, a broad tool surface (shell, files, HTTP,
// Hedera, Pinout, metered compute) and OpenRouter's server-side tools for
// search/fetch. `callModel` owns the loop; this owns the session.
//
//   node agent/chat.mjs                          interactive
//   node agent/chat.mjs -p "one-shot task"       headless
//   node agent/chat.mjs --resume <id> -p "..."   continue a conversation
import { OpenRouter, serverTool } from "@openrouter/agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { env, ROOT } from "../src/config.mjs";
import { generalTools } from "./general-tools.mjs";
import { pinoutTools } from "./tools.mjs";
import { hederaTools } from "./hedera-tools.mjs";

const SESSIONS = join(ROOT, ".agent-sessions");

const SYSTEM = `You are a capable general-purpose agent with real tools and a real crypto wallet.

You can read and write files, run shell commands, make HTTP requests, query the
Hedera network, and rent real compute machines that you pay for yourself over
x402 micropayments.

How to work:
- Prefer doing over asking. If a tool can answer the question, use it.
- You pay for compute per SECOND you hold a machine. Do not hold one idle, and
  always release it when the work is done so unused time is refunded.
- When you spend money, say what you spent and check you were billed correctly.
- Be concise. State numbers precisely. If something failed, say so plainly
  rather than papering over it.
- Never claim you did something you did not actually do.`;

export function loadState(id) {
  const f = join(SESSIONS, `${id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}
export function saveState(id, messages) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(join(SESSIONS, `${id}.json`), JSON.stringify({ id, messages }, null, 2));
}

export function allTools({ withCompute = true } = {}) {
  const tools = [...generalTools(), ...hederaTools()];
  if (withCompute) tools.push(...pinoutTools());
  // Server-side tools: OpenRouter executes these, no client code required.
  tools.push(serverTool("openrouter:web_search"), serverTool("openrouter:web_fetch"),
             serverTool("openrouter:datetime"));
  return tools;
}

export class Chat {
  constructor({ id = randomUUID().slice(0, 8), model = env.AGENT_MODEL ?? "openai/gpt-5.6-luna-pro",
                tools = allTools(), system = SYSTEM, verbose = true } = {}) {
    if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");
    this.id = id;
    this.model = model;
    this.tools = tools;
    this.system = system;
    this.verbose = verbose;
    this.openrouter = new OpenRouter({ apiKey: env.OPENROUTER_API_KEY });
    this.messages = loadState(id)?.messages ?? [];
  }

  /** One turn. History carries across calls, so this is a conversation. */
  async send(text) {
    this.messages.push({ role: "user", content: text });

    const result = this.openrouter.callModel({
      model: this.model,
      instructions: this.system,
      input: this.messages,
      tools: this.tools,
    });

    if (this.verbose) {
      (async () => {
        try {
          for await (const c of result.getToolCallsStream()) {
            const a = JSON.stringify(c.arguments ?? c.input ?? {});
            console.log(`\x1b[2m  · ${c.name} ${a.length > 100 ? a.slice(0, 100) + "…" : a}\x1b[0m`);
          }
        } catch { /* closed */ }
      })();
    }

    const answer = await result.getText();
    const usage = await result.getResponse().then((r) => r?.usage).catch(() => null);
    this.messages.push({ role: "assistant", content: answer });
    saveState(this.id, this.messages);
    return { answer, usage };
  }
}

/* ------------------------------------------------------------------ cli ---- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
  const id = flag("--resume") ?? randomUUID().slice(0, 8);
  const model = flag("--model") ?? undefined;
  const oneShot = flag("-p") ?? flag("--prompt");

  const chat = new Chat({ id, ...(model ? { model } : {}) });

  if (oneShot) {
    const { answer, usage } = await chat.send(oneShot);
    console.log(`\n${answer}\n`);
    console.log(`\x1b[2msession ${chat.id} · ${chat.model} · $${(usage?.cost ?? 0).toFixed(5)}\x1b[0m`);
    process.exit(0);
  }

  console.log(`\x1b[1mpinout agent\x1b[0m  ${chat.model}`);
  console.log(`\x1b[2msession ${chat.id} · ${chat.tools.length} tools · /exit to quit, /resume prints the id\x1b[0m\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("\x1b[36m› \x1b[0m")).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/resume") { console.log(`  node agent/chat.mjs --resume ${chat.id}\n`); continue; }
    try {
      const { answer, usage } = await chat.send(line);
      console.log(`\n${answer}\n\x1b[2m  $${(usage?.cost ?? 0).toFixed(5)}\x1b[0m\n`);
    } catch (e) {
      console.log(`\x1b[31m  error: ${e.message}\x1b[0m\n`);
    }
  }
  rl.close();
  process.exit(0);
}
