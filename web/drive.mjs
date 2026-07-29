import { chromium } from "playwright";

const TASK = process.argv[2] ?? "List the compute lanes you can rent and tell me the cheapest GPU and what it costs per second. Do not rent anything.";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));

await p.goto("http://localhost:3111/app", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);

await p.fill(".ws-composer textarea", TASK);
await p.click(".ws-send");
console.log("task sent");

// watch for the stages we care about
const seen = new Set();
for (let i = 0; i < 100; i++) {
  await p.waitForTimeout(3000);
  const state = await p.evaluate(() => ({
    tools: [...document.querySelectorAll(".ws-tools")].map((e) => e.textContent),
    agent: [...document.querySelectorAll(".ws-agent")].map((e) => e.textContent?.slice(0, 90)),
    ask: !!document.querySelector(".ws-ask"),
    working: document.querySelector(".ws-working")?.textContent ?? null,
    artifacts: document.querySelectorAll(".ws-artifact").length,
  }));
  for (const t of state.tools) if (t && !seen.has(t)) { seen.add(t); console.log("TOOLS:", t); }
  if (state.ask && !seen.has("ASK")) {
    seen.add("ASK");
    console.log("FUNDING ASK rendered");
    await p.screenshot({ path: "/tmp/ws-ask.png" });
  }
  if (state.agent.length && !seen.has("AGENT" + state.agent.length)) {
    seen.add("AGENT" + state.agent.length);
    console.log("AGENT:", state.agent[state.agent.length - 1]);
  }
  if (state.artifacts && !seen.has("ART")) { seen.add("ART"); console.log("ARTIFACT rendered"); }
  if (i % 5 === 0) await p.screenshot({ path: "/tmp/ws-live.png" });
  if (state.agent.length >= 1 && !state.working && !state.ask && i > 6) break;
}
await p.screenshot({ path: "/tmp/ws-final.png", fullPage: false });
console.log("done");
await b.close();
