// Operational guards for a publicly reachable compute broker.
//
// The threat these exist for: testnet HBAR is free from a faucet, so the
// payment gate provides ZERO economic friction on testnet. Anyone can mint
// funds at no cost and run arbitrary code on our Modal and Daytona accounts,
// billed to a real card. Payment alone cannot be the only thing standing
// between a stranger and our GPU budget.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { env, ROOT } from "../src/config.mjs";
import { RATES } from "../providers/compute.mjs";

const LEDGER = join(ROOT, ".compute-spend.json");

/** Provider credit, in USD, that must not be exceeded. */
export const BUDGET = {
  modal: Number(env.MODAL_BUDGET_USD ?? 30),
  daytona: Number(env.DAYTONA_BUDGET_USD ?? 200),
};

/**
 * Fraction of GPU budget held back so there is always enough left to record a
 * demo. GPU does not replenish inside a build window; 10.8h of A100 is one
 * careless afternoon.
 */
export const RESERVE_FRACTION = Number(env.GPU_RESERVE_FRACTION ?? 0.25);

export const LIMITS = {
  maxConcurrentSessions: Number(env.MAX_CONCURRENT_SESSIONS ?? 8),
  maxConcurrentGpu: Number(env.MAX_CONCURRENT_GPU ?? 1),
  maxSecondsPerSessionCpu: Number(env.MAX_SECONDS_CPU ?? 900),
  maxSecondsPerSessionGpu: Number(env.MAX_SECONDS_GPU ?? 180),
  maxCodeBytes: Number(env.MAX_CODE_BYTES ?? 64 * 1024),
  allowGpu: String(env.ALLOW_GPU ?? "false") === "true",
};

function load() {
  if (!existsSync(LEDGER)) return { modal: 0, daytona: 0, sessions: 0 };
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); }
  catch { return { modal: 0, daytona: 0, sessions: 0 }; }
}
function save(s) { writeFileSync(LEDGER, JSON.stringify(s, null, 2)); }

/** Record real provider spend so the ceiling survives restarts. */
export function recordSpend(provider, seconds, lane) {
  if (!provider || provider === "builtin" || provider === "local") return load();
  const l = RATES.lanes[lane];
  const usd = (l?.providerCostPerSecUsd ?? 0) * seconds;
  const s = load();
  s[provider] = (s[provider] ?? 0) + usd;
  s.sessions = (s.sessions ?? 0) + 1;
  save(s);
  return s;
}

export function spendReport() {
  const s = load();
  const out = {};
  for (const p of Object.keys(BUDGET)) {
    const spent = s[p] ?? 0;
    const usable = BUDGET[p] * (p === "modal" ? 1 - RESERVE_FRACTION : 1);
    out[p] = {
      spentUsd: Number(spent.toFixed(6)),
      budgetUsd: BUDGET[p],
      usableUsd: Number(usable.toFixed(2)),
      remainingUsd: Number((usable - spent).toFixed(6)),
      reservedUsd: p === "modal" ? Number((BUDGET[p] * RESERVE_FRACTION).toFixed(2)) : 0,
    };
  }
  out.sessionsServed = s.sessions ?? 0;
  return out;
}

/**
 * The seller must be able to afford a settlement anchor for every session it
 * accepts, or closing strands the buyer's balance. Anchors cost ~0.7345 HBAR
 * each (measured), and testnet HBAR is free to an attacker — so open/close
 * cycles are a >2x amplified drain on real seller funds.
 */
export const ANCHOR_COST_TINYBAR = Number(env.ANCHOR_COST_TINYBAR ?? 75_000_000);

export async function sellerSolvency(activeSessions) {
  const { mirror } = await import("../src/config.mjs");
  try {
    const a = await mirror(`/api/v1/accounts/${env.SELLER_ACCOUNT_ID}`);
    const balance = Number(a.balance?.balance ?? 0);
    // every open session may need an anchor, plus headroom for one more
    const committed = (activeSessions + 1) * ANCHOR_COST_TINYBAR;
    return { balance, committed, solvent: balance >= committed,
             anchorsAffordable: Math.floor(balance / ANCHOR_COST_TINYBAR) };
  } catch {
    return { balance: null, solvent: true, anchorsAffordable: null }; // fail open on lookup error
  }
}

/**
 * Decide whether a session may be opened. Returns null to allow, or
 * { status, error } to refuse — checked BEFORE the 402 is issued, so we never
 * take money for work we will not do.
 */
export async function admitAsync(args) {
  const sync = admit(args);
  if (sync) return sync;
  const sol = await sellerSolvency(args.activeSessions ?? 0);
  if (!sol.solvent) {
    return { status: 503,
      error: "service cannot guarantee refunds right now",
      detail: `seller can afford ${sol.anchorsAffordable} settlement anchors but ` +
              `${(args.activeSessions ?? 0) + 1} sessions would be open. Refusing new ` +
              `sessions rather than risk stranding a prepaid balance.` };
  }
  return null;
}

export function admit({ lane, activeSessions, activeGpu, codeBytes }) {
  const spec = RATES.lanes[lane];
  const isGpu = Boolean(spec?.gpu);

  if (isGpu && !LIMITS.allowGpu) {
    return { status: 503, error: "gpu lanes are disabled on this deployment",
             hint: "set ALLOW_GPU=true to enable; cpu lanes are open" };
  }
  if (activeSessions >= LIMITS.maxConcurrentSessions) {
    return { status: 503, error: `at capacity (${LIMITS.maxConcurrentSessions} concurrent sessions)` };
  }
  if (isGpu && activeGpu >= LIMITS.maxConcurrentGpu) {
    return { status: 503, error: `gpu at capacity (${LIMITS.maxConcurrentGpu} concurrent)` };
  }
  if (codeBytes && codeBytes > LIMITS.maxCodeBytes) {
    return { status: 413, error: `code exceeds ${LIMITS.maxCodeBytes} bytes` };
  }
  if (spec?.provider) {
    const r = spendReport()[spec.provider];
    if (r && r.remainingUsd <= 0) {
      return { status: 503,
        error: `${spec.provider} budget exhausted`,
        detail: `spent $${r.spentUsd} of $${r.usableUsd} usable` +
                (r.reservedUsd ? ` ($${r.reservedUsd} held in reserve)` : "") };
    }
  }
  return null;
}

/** Hard ceiling on seconds a session may hold a machine, whatever it paid for. */
export function maxSecondsFor(lane) {
  const spec = RATES.lanes[lane];
  return spec?.gpu ? LIMITS.maxSecondsPerSessionGpu : LIMITS.maxSecondsPerSessionCpu;
}

/**
 * Kill anything we left behind. An orphaned sandbox bills per second in silence
 * and is the single most expensive kind of bug in this system.
 */
export async function reapOrphans() {
  const reaped = { daytona: 0, modal: 0, errors: [] };
  try {
    if (env.DAYTONA_API_KEY) {
      const r = await fetch(`${env.DAYTONA_API_URL ?? "https://app.daytona.io/api"}/sandbox`,
        { headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` } });
      if (r.ok) {
        const list = await r.json();
        for (const sb of (Array.isArray(list) ? list : list.items ?? [])) {
          const del = await fetch(`${env.DAYTONA_API_URL ?? "https://app.daytona.io/api"}/sandbox/${sb.id}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` } });
          if (del.ok) reaped.daytona++;
        }
      }
    }
  } catch (e) { reaped.errors.push(`daytona: ${e.message}`); }

  // Modal was never actually swept — this function reported "modal: 0" whether
  // or not anything was running, which reads as "checked and clean" when
  // nothing had been checked. An orphaned A100 bills ~$2.50/hour in silence and
  // is the most expensive failure mode in this system.
  try {
    if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) {
      const { ModalClient } = await import("modal");
      const modal = new ModalClient({
        tokenId: env.MODAL_TOKEN_ID, tokenSecret: env.MODAL_TOKEN_SECRET,
      });
      const app = await modal.apps.fromName("pinout-compute", { createIfMissing: true });
      for await (const sb of modal.sandboxes.list({ appId: app.appId })) {
        try { await sb.terminate(); reaped.modal++; } catch { /* already gone */ }
      }
    } else {
      reaped.errors.push("modal: no credentials, NOT swept");
    }
  } catch (e) { reaped.errors.push(`modal: ${e.message}`); }

  return reaped;
}
