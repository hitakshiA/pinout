import { chromium } from "playwright";
const FILE = process.argv[2], TASK = process.argv[3], TAG = process.argv[4] ?? "d";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
p.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 160)));
await p.goto("http://localhost:3111/app", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);
await p.click(".ws-newchat"); await p.waitForTimeout(1200);

// fund the chat first, the way a person would before setting it going
await p.click(".ws-panel-tabs .ws-tab");
await p.waitForTimeout(300);
const modes = await p.$$(".ws-panel-body .ws-tab");
if (modes[1]) await modes[1].click();
await p.waitForTimeout(300);
await p.fill(".ws-panel-body .ws-field", "3");
const fund = await p.$(".ws-panel-body .ws-btn-primary");
if (fund) { await fund.click(); console.log("funding 3 HBAR..."); }
await p.waitForTimeout(14000);
console.log("balance:", await p.evaluate(() => document.querySelector(".ws-balance")?.textContent));

await p.setInputFiles(".ws-composer input[type=file]", FILE);
await p.waitForTimeout(500);
await p.fill(".ws-composer textarea", TASK);
await p.click(".ws-send");
console.log("task sent");

const seen = new Set();
for (let i = 0; i < 400; i++) {
  await p.waitForTimeout(3000);
  const s = await p.evaluate(() => ({
    tools: [...document.querySelectorAll(".ws-tools")].map((e) => e.textContent),
    ask: !!document.querySelector(".ws-ask"),
    working: document.querySelector(".ws-working")?.textContent ?? null,
    arts: document.querySelectorAll(".ws-artifact").length,
    bal: document.querySelector(".ws-balance")?.textContent ?? null,
    decision: [...document.querySelectorAll(".ws-decision")].map((e) => e.textContent),
    stop: !!document.querySelector(".ws-stop"),
    short: document.querySelector(".ws-shortfall")?.textContent ?? null,
  }));
  for (const t of s.tools) if (t && !seen.has(t)) { seen.add(t); console.log("  ·", t); }
  for (const d of s.decision) if (d && !seen.has("D" + d)) { seen.add("D" + d); console.log("  DECISION:", d); }
  if (s.ask && !seen.has("ASK")) {
    seen.add("ASK"); console.log("ASK shown");
    await p.screenshot({ path: `/tmp/${TAG}-ask.png` });
    const ok = await p.$(".ws-ask .ws-btn-primary");
    if (ok) { await ok.click(); console.log("  approved"); }
  }
  if (s.arts && !seen.has("ART")) {
    seen.add("ART"); console.log("ARTIFACT shown:", s.arts);
    await p.click(".ws-artifact");           // open the preview
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `/tmp/${TAG}-preview.png` });
    console.log("  preview open:", await p.evaluate(() => !!document.querySelector(".ws-preview")));
  }
  // top up when the agent is short, the way a person watching would
  if (s.short && !seen.has("SHORT" + s.short)) {
    seen.add("SHORT" + s.short);
    console.log("  SHORTFALL:", s.short.replace(/\s+/g, " ").slice(0, 110));
    const modes2 = await p.$$(".ws-panel-body .ws-tab");
    if (modes2[1]) await modes2[1].click();
    await p.waitForTimeout(300);
    await p.fill(".ws-panel-body .ws-field", "2");
    const top = await p.$(".ws-panel-body .ws-btn-primary");
    if (top) { await top.click(); console.log("  topped up 2 HBAR mid-job"); }
    await p.waitForTimeout(12000);
  }
  if (i % 12 === 0 && s.bal) console.log("  balance", s.bal, s.working ? `| ${s.working}` : "", s.stop ? "| stoppable" : "");
  if (seen.has("ART") && !s.working && !s.stop) break;
}
await p.screenshot({ path: `/tmp/${TAG}-final.png` });
console.log("done");
await b.close();
