import { chromium } from "playwright";
const SP = process.env.SP;
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
await p.goto("https://pinout.club/app", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4500);
await p.setInputFiles('input[type=file]', [`${SP}/f/real.pdf`]);
await p.waitForTimeout(800);
// deliberately names nothing
await p.locator("textarea").first().fill("What total does this report state?");
await p.locator(".ws-send").click();
console.log("sent, no filename in the prompt");

await p.locator("button", { hasText: "Approve" }).first().waitFor({ timeout: 150000 });
const card = await p.locator(".ws-ask, [class*=ask]").first().innerText().catch(() => "");
console.log("PLAN:", card.replace(/\n/g, " / ").slice(0, 420));
await p.locator("button", { hasText: "Approve" }).first().click();
await p.waitForTimeout(2000);
await p.locator(".ws-panel-tabs .ws-tab", { hasText: "Wallet" }).click().catch(() => {});
await p.waitForTimeout(600);
await p.locator(".ws-tab", { hasText: "Send directly" }).click();
await p.waitForTimeout(400);
await p.locator("button").filter({ hasText: /^Send .* to the agent$/ }).click();
console.log("funded");

let prev = "";
for (let i = 0; i < 70; i++) {
  await p.waitForTimeout(12000);
  const txt = await p.locator(".ws-centre").innerText().catch(() => "");
  if (txt !== prev) { console.log(`[${(i+1)*12}s]`, txt.split("\n").filter(Boolean).slice(-2).join(" / ").slice(0,200)); prev = txt; }
  if (/15,?424/.test(txt) && !/Working…/.test(txt)) { console.log("ANSWERED"); break; }
}
console.log("\n=== TAIL ===\n" + (await p.locator(".ws-centre").innerText()).slice(-1100));
await p.screenshot({ path: `${SP}/50-noname.png`, fullPage: true });
await b.close();
