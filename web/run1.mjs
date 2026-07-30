import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
p.on("pageerror", (e) => console.log("PAGEERR", String(e).slice(0,140)));
await p.goto("http://localhost:3111/app", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3500);
await p.click(".ws-newchat"); await p.waitForTimeout(1200);

// use the example, the way a visitor would
await p.click(".ws-idea"); await p.waitForTimeout(7000);
console.log("example picked, prompt:", (await p.inputValue(".ws-composer textarea")).slice(0,60)+"...");
await p.click(".ws-send");
console.log("sent");

let asks = 0; const seen = new Set();
for (let i = 0; i < 500; i++) {
  await p.waitForTimeout(3000);
  const s = await p.evaluate(() => ({
    tools: [...document.querySelectorAll(".ws-tools")].map(e=>e.textContent).slice(-1)[0] ?? null,
    ask: !!document.querySelector(".ws-ask"),
    askText: document.querySelector(".ws-ask")?.textContent?.slice(0,140) ?? null,
    bal: document.querySelector(".ws-balance")?.textContent ?? null,
    working: document.querySelector(".ws-working")?.textContent ?? null,
    arts: document.querySelectorAll(".ws-artifact").length,
    short: !!document.querySelector(".ws-shortfall"),
    agent: [...document.querySelectorAll(".ws-agent")].slice(-1)[0]?.textContent?.slice(0,120) ?? null,
  }));
  if (s.tools && !seen.has(s.tools)) { seen.add(s.tools); console.log("  ·", s.tools.slice(0,130)); }

  if (s.ask) {
    asks++; console.log(`ASK #${asks}:`, (s.askText||"").replace(/\s+/g," ").slice(0,110));
    if (asks === 1) await p.screenshot({ path: "/tmp/r1-ask.png" });
    // fund generously through the panel, then approve
    const modes = await p.$$(".ws-panel-body .ws-tab");
    if (modes[1]) await modes[1].click();
    await p.waitForTimeout(400);
    const f = await p.$(".ws-panel-body .ws-field"); if (f) await f.fill("6");
    const send = await p.$(".ws-panel-body .ws-btn-primary");
    if (send) { await send.click(); console.log("  funded 6 HBAR"); }
    await p.waitForTimeout(13000);
    const ok = await p.$(".ws-ask .ws-btn-primary");
    if (ok) { await ok.click(); console.log("  APPROVED"); }
    await p.waitForTimeout(3000);
  }
  if (s.arts && !seen.has("ART")) {
    seen.add("ART"); console.log("ARTIFACT:", s.arts);
    await p.screenshot({ path: "/tmp/r1-artifact.png" });
    await p.click(".ws-artifact"); await p.waitForTimeout(4000);
    await p.screenshot({ path: "/tmp/r1-preview.png" });
    console.log("preview open:", await p.evaluate(()=>!!document.querySelector(".ws-preview")));
  }
  if (i % 15 === 0) console.log(`  [${i*3}s] bal ${s.bal} ${s.working??""}`);
  if (seen.has("ART") && !s.working) { await p.waitForTimeout(6000); break; }
}
await p.screenshot({ path: "/tmp/r1-final.png", fullPage: true });
console.log("agent said:", (await p.evaluate(()=>[...document.querySelectorAll(".ws-agent")].slice(-1)[0]?.textContent))?.slice(0,400));
await b.close();
