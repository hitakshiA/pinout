import { chromium } from "playwright";

const FILE = process.argv[2];
const TASK = process.argv[3];
const TAG  = process.argv[4] ?? "d";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 160)));
await p.goto("http://localhost:3111/app", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);

// fresh task so the wallet is this chat's own
await p.click(".ws-newchat");
await p.waitForTimeout(1200);

await p.setInputFiles(".ws-composer input[type=file]", FILE);
await p.waitForTimeout(600);
await p.fill(".ws-composer textarea", TASK);
await p.click(".ws-send");
console.log("sent, file attached:", FILE.split("/").pop());

const seen = new Set();
let approved = false;
for (let i = 0; i < 400; i++) {
  await p.waitForTimeout(3000);
  const s = await p.evaluate(() => ({
    tools: [...document.querySelectorAll(".ws-tools")].map((e) => e.textContent),
    ask: document.querySelector(".ws-ask") ? document.querySelector(".ws-ask").textContent.slice(0, 150) : null,
    working: document.querySelector(".ws-working")?.textContent ?? null,
    arts: document.querySelectorAll(".ws-artifact").length,
    bal: document.querySelector(".ws-balance")?.textContent ?? null,
    agent: [...document.querySelectorAll(".ws-agent")].length,
  }));
  for (const t of s.tools) if (t && !seen.has(t)) { seen.add(t); console.log("  ·", t); }

  if (s.ask && !approved) {
    console.log("ASK:", s.ask.replace(/\s+/g, " ").slice(0, 130));
    await p.screenshot({ path: `/tmp/${TAG}-ask.png` });
    // fund the chat directly first so the agent has money to spend
    await p.click(".ws-panel-tabs .ws-tab");           // Wallet tab
    await p.waitForTimeout(400);
    const btns = await p.$$(".ws-panel-body .ws-tab");
    if (btns[1]) await btns[1].click();                 // "Send directly"
    await p.waitForTimeout(400);
    await p.fill(".ws-panel-body .ws-field", "3");
    const send = await p.$(".ws-panel-body .ws-btn-primary");
    if (send) { await send.click(); console.log("  funded 3 HBAR directly"); }
    await p.waitForTimeout(9000);
    // now approve
    const ok = await p.$(".ws-ask .ws-btn-primary");
    if (ok) { await ok.click(); approved = true; console.log("APPROVED"); }
    await p.waitForTimeout(2000);
  }
  if (s.arts && !seen.has("ART")) {
    seen.add("ART"); console.log("ARTIFACT:", s.arts);
    await p.screenshot({ path: `/tmp/${TAG}-artifact.png` });
  }
  if (i % 10 === 0) {
    await p.screenshot({ path: `/tmp/${TAG}-live.png` });
    if (s.bal) console.log("  balance", s.bal, s.working ? `| ${s.working}` : "");
  }
  if (approved && s.arts > 0 && !s.working) break;
}
await p.screenshot({ path: `/tmp/${TAG}-final.png` });
console.log("done");
await b.close();
