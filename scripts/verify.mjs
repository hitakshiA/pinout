// Pinout verifier — recomputes the bill from the free public mirror node.
//
// Trusts nothing but:
//   * the Hedera mirror node (public, unauthenticated, no key)
//   * the client's own record of event ids it actually received
//
// Checks, in order of severity:
//   1. burn checkpoints form a gapless half-open range starting at 0
//   2. the settlement anchor's committed (seq, running_hash) matches the
//      burn ledger head -> tier 1 cannot be restated without invalidating tier 2
//   3. the anchor's arithmetic is internally consistent
//   4. the ledger's claimed burn count matches what the client received
//   5. per-checkpoint commitments match the client's event ids
//
//   node scripts/verify.mjs <sessionId> [--events last-session.json]
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { env, mirror, hashscan } from "../src/config.mjs";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("usage: node scripts/verify.mjs <sessionId> [--events file.json]");
  process.exit(2);
}
const evIdx = process.argv.indexOf("--events");
const evFile = evIdx > -1 ? process.argv[evIdx + 1] : "last-session.json";

const b64 = (s) => Buffer.from(s, "base64").toString("utf8");

async function allMessages(topicId) {
  const out = [];
  let next = `/api/v1/topics/${topicId}/messages?order=asc&limit=100`;
  while (next) {
    const page = await mirror(next);
    out.push(...(page.messages ?? []));
    next = page.links?.next ?? null;
  }
  return out;
}

console.log(`verifying session ${sessionId}`);
console.log(`burn topic       ${env.BURN_TOPIC_ID}`);
console.log(`settlement topic ${env.TOPIC_ID}`);
console.log(`source           ${process.env.MIRROR_NODE_URL ?? "public testnet mirror node"}\n`);

// ---- fee terms are public; confirm them rather than taking the seller's word
const topicMeta = await mirror(`/api/v1/topics/${env.TOPIC_ID}`);
const fee = topicMeta.custom_fees?.fixed_fees?.[0];
console.log("settlement topic fee terms (on-chain):");
console.log(`  amount        ${fee?.amount} tinybar`);
console.log(`  collector     ${fee?.collector_account_id}`);
console.log(`  token         ${fee?.denominating_token_id ?? "HBAR"}`);
console.log(`  feeScheduleKey ${topicMeta.fee_schedule_key ? "present" : "ABSENT (frozen)"}`);
console.log(`  exemptions    ${JSON.stringify(topicMeta.fee_exempt_key_list ?? [])}\n`);

/**
 * A shared topic will always carry messages that are not ours (benchmarks,
 * other tenants, junk). Skip anything unparseable rather than dying — but
 * never skip a message that IS ours and is malformed.
 */
function ours(messages, kind) {
  const out = [];
  for (const m of messages) {
    let body;
    try { body = JSON.parse(b64(m.message)); } catch { continue; }
    if (body?.session === sessionId && body?.t === kind) out.push({ raw: m, body });
  }
  return out;
}

const burnMsgs = ours(await allMessages(env.BURN_TOPIC_ID), "burn");
const settleMsgs = ours(await allMessages(env.TOPIC_ID), "settle");

const failures = [];
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failures.push(m); console.log(`  FAIL  ${m}`); };

console.log(`found ${burnMsgs.length} burn checkpoints, ${settleMsgs.length} settlement anchors\n`);
if (!burnMsgs.length) { console.error("no checkpoints for this session"); process.exit(2); }

// ---- 1. contiguity
console.log("1. burn checkpoint contiguity");
let cursor = 0, ledgerBurned = 0;
for (const { body } of burnMsgs) {
  if (body.from !== cursor) bad(`gap/overlap: expected from=${cursor}, got from=${body.from}`);
  cursor = body.to;
  ledgerBurned = body.burned;
}
if (!failures.length) ok(`contiguous [0, ${cursor}) across ${burnMsgs.length} checkpoints`);

// ---- 2. tier binding
console.log("\n2. settlement anchor binds the burn ledger");
if (settleMsgs.length !== 1) {
  bad(`expected exactly 1 settlement anchor, found ${settleMsgs.length}`);
} else {
  const a = settleMsgs[0];
  const head = burnMsgs[burnMsgs.length - 1].raw;
  if (String(a.body.burnFinalSeq) !== String(head.sequence_number)) {
    bad(`anchor commits to seq ${a.body.burnFinalSeq}, ledger head is ${head.sequence_number}`);
  } else if (a.body.burnFinalRunningHash !== head.running_hash) {
    bad("anchor running_hash does not match burn ledger head");
  } else {
    ok(`anchor commits to seq ${head.sequence_number} + consensus running_hash`);
  }
  // ---- 3. anchor arithmetic
  console.log("\n3. settlement arithmetic");
  const owed = a.body.burned * a.body.priceTinybar;
  if (owed !== a.body.owedTinybar) bad(`owed ${a.body.owedTinybar} != burned*price ${owed}`);
  else ok(`owed = ${a.body.burned} x ${a.body.priceTinybar} = ${owed} tinybar`);
  console.log(`        refund declared: ${a.body.refundTinybar} tinybar`);
  console.log(`        cause: ${a.body.cause}`);
}

// ---- 4/5. against what the client actually received
console.log("\n4. ledger claims vs. client's received events");
let comparedToClient = false;
if (!existsSync(evFile)) {
  console.log(`  SKIP  no ${evFile}`);
} else {
  let rec;
  try {
    rec = JSON.parse(readFileSync(evFile, "utf8"));
    if (!Array.isArray(rec?.receivedEventIds)) throw new Error("no receivedEventIds[]");
  } catch (e) {
    console.log(`  SKIP  ${evFile} unreadable: ${e.message}`);
    rec = { sessionId: null };
  }
  if (rec.sessionId !== sessionId) {
    console.log(`  SKIP  ${evFile} is for session ${rec.sessionId}, not this one`);
  } else {
    comparedToClient = true;
    const got = rec.receivedEventIds.length;
    if (ledgerBurned > got) {
      bad(`LEDGER OVER-BILLS: claims ${ledgerBurned} events, client received ${got} ` +
          `(+${ledgerBurned - got} phantom = ${(ledgerBurned - got) * 200} tinybar overcharge)`);
    } else if (ledgerBurned < got) {
      bad(`ledger under-reports: claims ${ledgerBurned}, client received ${got}`);
    } else {
      ok(`ledger burn count ${ledgerBurned} matches ${got} received events`);
    }

    console.log("\n5. per-checkpoint event commitments");
    let idx = 0, mismatches = 0;
    for (const { body } of burnMsgs) {
      const slice = rec.receivedEventIds.slice(idx, body.to);
      idx = body.to;
      const expect = createHash("sha256").update(slice.join("\n")).digest("hex");
      if (expect !== body.commit) mismatches++;
    }
    if (mismatches) bad(`${mismatches}/${burnMsgs.length} checkpoint commitments do not match`);
    else ok(`all ${burnMsgs.length} commitments match the client's event ids`);
  }
}

console.log("\n" + "=".repeat(60));
if (failures.length) {
  console.log(`VERIFICATION FAILED — ${failures.length} problem(s):`);
  failures.forEach((f) => console.log(`  - ${f}`));
  console.log(`\nburn topic:   ${hashscan.topic(env.BURN_TOPIC_ID)}`);
  console.log(`settle topic: ${hashscan.topic(env.TOPIC_ID)}`);
  process.exit(1);
}
// Self-consistency alone does NOT establish the seller was honest: a seller
// that fabricates events and checkpoints them faithfully passes checks 1-3.
// Only comparison against the client's own record catches that, so refusing
// to say "PASSED" without it is the difference between a real verifier and a
// rubber stamp.
if (!comparedToClient) {
  console.log("INCONCLUSIVE — ledger is self-consistent, but it was NOT compared");
  console.log("against any client record, so over-billing CANNOT be ruled out.");
  console.log(`Supply the buyer's event log:  --events <file.json>`);
  console.log(`\nburn topic:   ${hashscan.topic(env.BURN_TOPIC_ID)}`);
  console.log(`settle topic: ${hashscan.topic(env.TOPIC_ID)}`);
  process.exit(2);
}
console.log("VERIFICATION PASSED — bill independently recomputed from the mirror node.");
console.log(`\nburn topic:   ${hashscan.topic(env.BURN_TOPIC_ID)}`);
console.log(`settle topic: ${hashscan.topic(env.TOPIC_ID)}`);
