// Pinout verifier CLI — recomputes the bill from the free public mirror node.
//
// Trusts only:
//   * the Hedera mirror node (public, unauthenticated, no key)
//   * the buyer's own record of event ids it actually received
//
// The checking logic lives in src/verifier.mjs and is shared with the MCP
// `verify_session` tool and the Agent Kit plugin. It used to be duplicated here,
// which meant the CLI and the agent tool could disagree about whether a bill was
// honest — two implementations of the one artifact whose whole job is to be
// trustworthy.
//
//   node scripts/verify.mjs <sessionId> [--events last-session.json]
//
// Exit codes:  0 verified   1 fraud detected   2 inconclusive / usage
//               3 consumption verified, batched anchor not yet on-chain
import { readFileSync, existsSync } from "node:fs";
import { verifySession } from "../src/verifier.mjs";
import { env, MIRROR, hashscan } from "../src/config.mjs";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("usage: node scripts/verify.mjs <sessionId> [--events file.json]");
  process.exit(2);
}
const evIdx = process.argv.indexOf("--events");
const evFile = evIdx > -1 ? process.argv[evIdx + 1] : "last-session.json";

/** The buyer's own log. Without it, over-billing cannot be ruled out. */
function clientRecord() {
  if (!existsSync(evFile)) {
    console.log(`  (no ${evFile} — ledger self-consistency only)`);
    return null;
  }
  try {
    const rec = JSON.parse(readFileSync(evFile, "utf8"));
    if (!Array.isArray(rec?.receivedEventIds)) throw new Error("no receivedEventIds[]");
    if (rec.sessionId !== sessionId) {
      console.log(`  (${evFile} is for session ${rec.sessionId}, not this one)`);
      return null;
    }
    return rec.receivedEventIds;
  } catch (e) {
    console.log(`  (${evFile} unreadable: ${e.message})`);
    return null;
  }
}

console.log(`verifying session ${sessionId}`);
console.log(`burn topic       ${env.BURN_TOPIC_ID}`);
console.log(`settlement topic ${env.TOPIC_ID}`);
console.log(`source           ${MIRROR}\n`);

const report = await verifySession(sessionId, clientRecord());

if (report.feeTerms) {
  console.log("settlement topic fee terms (read from the chain, not from the seller):");
  console.log(`  amount         ${report.feeTerms.amountTinybar} tinybar`);
  console.log(`  collector      ${report.feeTerms.collector}   <- fixed at topic creation, NOT the paying buyer`);
  console.log(`  asset          ${report.feeTerms.asset}`);
  console.log(`  feeScheduleKey ${report.feeTerms.feeScheduleKey}`);
  console.log(`  exemptions     ${JSON.stringify(report.feeTerms.exemptions)}\n`);
}

console.log(`${report.checkpoints} burn checkpoint(s), ${report.ledgerBurned} units claimed\n`);
for (const c of report.checks) {
  const tag = c.ok === null ? "WAIT" : c.ok ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${c.check}: ${c.detail}`);
}

console.log("\n" + "=".repeat(62));
const links = () => {
  console.log(`\nburn topic:   ${hashscan.topic(env.BURN_TOPIC_ID)}`);
  console.log(`settle topic: ${hashscan.topic(env.TOPIC_ID)}`);
};

if (report.verdict === "FAILED") {
  console.log(`VERIFICATION FAILED — ${report.failures.length} problem(s):`);
  report.failures.forEach((f) => console.log(`  - ${f}`));
  links();
  process.exit(1);
}
if (report.verdict === "PENDING_ANCHOR") {
  console.log("PENDING — consumption verified; the batched settlement anchor has not");
  console.log("landed yet. This is NOT a billing discrepancy. Re-run after the sweep.");
  if (report.note) console.log(`  ${report.note}`);
  links();
  process.exit(3);
}
if (report.verdict === "INCONCLUSIVE") {
  console.log("INCONCLUSIVE — the ledger is self-consistent, but it was NOT compared");
  console.log("against a client record, so over-billing CANNOT be ruled out.");
  if (report.note) console.log(`  ${report.note}`);
  console.log(`\nSupply the buyer's event log:  --events <file.json>`);
  links();
  process.exit(2);
}
console.log("VERIFICATION PASSED — bill independently recomputed from the mirror node.");
links();
