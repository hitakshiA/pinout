// Reusable verification core, shared by scripts/verify.mjs (CLI) and the
// MCP `verify_session` tool. Trusts only the public mirror node plus the
// buyer's own record of received event ids.
import { createHash } from "node:crypto";
import { env, mirror } from "./config.mjs";

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

/** A shared topic carries foreign messages; skip unparseable, keep ours. */
function ours(messages, sessionId, kind) {
  const out = [];
  for (const m of messages) {
    let body;
    try { body = JSON.parse(b64(m.message)); } catch { continue; }
    if (body?.session === sessionId && body?.t === kind) out.push({ raw: m, body });
  }
  return out;
}

/**
 * @param sessionId
 * @param receivedEventIds  the buyer's own log, or null if unavailable
 * @returns {{verdict: "PASSED"|"FAILED"|"INCONCLUSIVE", checks, failures, ...}}
 */
export async function verifySession(sessionId, receivedEventIds = null) {
  const topicMeta = await mirror(`/api/v1/topics/${env.TOPIC_ID}`);
  const fee = topicMeta.custom_fees?.fixed_fees?.[0];

  const burn = ours(await allMessages(env.BURN_TOPIC_ID), sessionId, "burn");
  const settle = ours(await allMessages(env.TOPIC_ID), sessionId, "settle");

  const failures = [];
  const checks = [];
  const pass = (n, m) => checks.push({ check: n, ok: true, detail: m });
  const fail = (n, m) => { failures.push(m); checks.push({ check: n, ok: false, detail: m }); };

  if (!burn.length) {
    return { verdict: "INCONCLUSIVE", reason: "no checkpoints for this session", checks, failures };
  }

  // 1. contiguity
  let cursor = 0, ledgerBurned = 0;
  for (const { body } of burn) {
    if (body.from !== cursor) fail("contiguity", `gap: expected from=${cursor}, got ${body.from}`);
    cursor = body.to;
    ledgerBurned = body.burned;
  }
  if (!failures.length) pass("contiguity", `contiguous [0, ${cursor}) across ${burn.length} checkpoints`);

  // 2. tier binding
  let anchor = null;
  if (settle.length !== 1) {
    fail("tier-binding", `expected 1 settlement anchor, found ${settle.length}`);
  } else {
    anchor = settle[0];
    const head = burn[burn.length - 1].raw;
    if (String(anchor.body.burnFinalSeq) !== String(head.sequence_number)) {
      fail("tier-binding", `anchor commits to seq ${anchor.body.burnFinalSeq}, head is ${head.sequence_number}`);
    } else if (anchor.body.burnFinalRunningHash !== head.running_hash) {
      fail("tier-binding", "anchor running_hash does not match burn ledger head");
    } else {
      pass("tier-binding", `anchor commits to seq ${head.sequence_number} + consensus running_hash`);
    }
    // 3. arithmetic
    const owed = anchor.body.burned * anchor.body.priceTinybar;
    if (owed !== anchor.body.owedTinybar) {
      fail("arithmetic", `owed ${anchor.body.owedTinybar} != burned*price ${owed}`);
    } else {
      pass("arithmetic", `${anchor.body.burned} x ${anchor.body.priceTinybar} = ${owed} tinybar`);
    }
  }

  // 4 + 5. against the buyer's own record
  let comparedToClient = false;
  if (Array.isArray(receivedEventIds)) {
    comparedToClient = true;
    const got = receivedEventIds.length;
    if (ledgerBurned > got) {
      fail("over-billing",
        `LEDGER OVER-BILLS: claims ${ledgerBurned}, client received ${got} ` +
        `(+${ledgerBurned - got} phantom events)`);
    } else if (ledgerBurned < got) {
      fail("under-report", `ledger claims ${ledgerBurned}, client received ${got}`);
    } else {
      pass("burn-count", `ledger burn count ${ledgerBurned} matches received events`);
    }

    let idx = 0, bad = 0;
    for (const { body } of burn) {
      const slice = receivedEventIds.slice(idx, body.to);
      idx = body.to;
      if (createHash("sha256").update(slice.join("\n")).digest("hex") !== body.commit) bad++;
    }
    if (bad) fail("commitments", `${bad}/${burn.length} checkpoint commitments do not match`);
    else pass("commitments", `all ${burn.length} commitments match the client's event ids`);
  }

  const verdict = failures.length ? "FAILED" : comparedToClient ? "PASSED" : "INCONCLUSIVE";
  return {
    verdict,
    // Self-consistency alone never establishes honesty: a seller that fabricates
    // events and checkpoints them faithfully passes checks 1-3.
    note: comparedToClient
      ? undefined
      : "ledger is self-consistent but was NOT compared to any client record; over-billing cannot be ruled out",
    sessionId,
    checkpoints: burn.length,
    ledgerBurned,
    feeTerms: fee && {
      amountTinybar: fee.amount,
      collector: fee.collector_account_id,
      asset: fee.denominating_token_id ?? "HBAR",
      feeScheduleKey: topicMeta.fee_schedule_key ? "present" : "absent",
      exemptions: topicMeta.fee_exempt_key_list ?? [],
    },
    settlement: anchor?.body,
    checks,
    failures,
  };
}
