// Chats, and the memory that belongs to each one.
//
// A workspace owns the wallet. A chat owns a conversation and its own agent
// memory. That split matters: opening a Hedera account costs ~0.81 HBAR in
// fees, so giving every chat its own account would charge the user roughly a
// dollar just to say hello. Chats share the workspace wallet and each run
// declares its own ceiling.
//
// The interesting part here is compaction. A chat that rents machines
// accumulates enormous tool output (stdout, file listings, exec results) and
// will blow a context window long before the conversation feels long. But some
// of that history is expensive: it records what the user paid for. So
// compaction is not "drop the oldest" — it is a policy about what may be
// summarised, what must survive verbatim, and what is safe to discard.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.mjs";

const DIR = join(ROOT, ".club");
const FILE = join(DIR, "threads.json");

/** Compact when the estimated window passes this. */
export const CONTEXT_LIMIT = Number(process.env.CLUB_CONTEXT_LIMIT ?? 200_000);
/** Leave room for the reply and the tool schemas. */
const HEADROOM = 24_000;
/** Never compact below this many recent turns, however big they are. */
const KEEP_RECENT = 8;

const threads = new Map();

function load() {
  if (!existsSync(FILE)) return;
  try { for (const t of JSON.parse(readFileSync(FILE, "utf8"))) threads.set(t.id, t); }
  catch { /* a corrupt index must not stop the server booting */ }
}
function persist() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify([...threads.values()], null, 2));
}
load();

export function createThread(workspaceId, { title = "New chat" } = {}) {
  const t = {
    id: randomUUID(),
    workspaceId,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turns: [],       // the live window handed to the model
    archive: [],     // compaction summaries, oldest first
    pinned: [],      // never compacted: artifacts, spend, session ids
    assetIds: [],
    artifactIds: [],
    tokensEstimate: 0,
  };
  threads.set(t.id, t);
  persist();
  return t;
}

export const get = (id) => threads.get(id) ?? null;
export const forWorkspace = (wid) =>
  [...threads.values()].filter((t) => t.workspaceId === wid)
    .sort((a, b) => b.updatedAt - a.updatedAt);

/**
 * Rough token count. Deliberately an estimate: an exact tokeniser would mean
 * shipping one per model, and being wrong by 10% here only changes when we
 * compact, not whether the result is correct.
 */
export function estimate(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.6);
}

function turnTokens(turn) {
  return estimate(turn.text) + (turn.tool ? estimate(turn.tool.output) + 24 : 0);
}

/**
 * Some turns are load-bearing and must survive verbatim no matter how old.
 * Anything that records money moving, or points at something the user paid to
 * produce, is not summarisable: a summary of "you spent 0.0423 HBAR" is not
 * evidence, and the user may come back to it weeks later.
 */
export function isLoadBearing(turn) {
  if (turn.pinned) return true;
  if (turn.role === "user") return false;
  const t = turn.tool?.name ?? "";
  return [
    "rent_machine", "release_machine", "top_up", "open_session",
    "close_session", "verify_session", "download_file",
  ].includes(t);
}

export function addTurn(threadId, turn) {
  const t = threads.get(threadId);
  if (!t) return null;
  const entry = { id: randomUUID(), at: Date.now(), ...turn };
  entry.tokens = turnTokens(entry);
  t.turns.push(entry);
  t.tokensEstimate += entry.tokens;
  t.updatedAt = Date.now();
  if (isLoadBearing(entry)) t.pinned.push(entry.id);
  persist();
  return entry;
}

/**
 * Decide what to do when the window is too big.
 *
 * Returns the turns to summarise and the ones to keep, without calling a model.
 * The caller does the summarising, so this stays testable and never blocks a
 * run that is mid-flight and paying for a machine by the second.
 */
export function planCompaction(threadId) {
  const t = threads.get(threadId);
  if (!t) return null;
  if (t.tokensEstimate < CONTEXT_LIMIT - HEADROOM) return { needed: false };

  const keepFrom = Math.max(0, t.turns.length - KEEP_RECENT);
  const candidates = [];
  const keep = [];

  t.turns.forEach((turn, i) => {
    if (i >= keepFrom) { keep.push(turn); return; }
    if (t.pinned.includes(turn.id)) { keep.push(turn); return; }
    candidates.push(turn);
  });

  // Huge tool output is the usual culprit and the cheapest thing to lose: a
  // 200k-line stdout is worth one line of summary, but the fact the command
  // ran, and what it cost, is already pinned.
  const freed = candidates.reduce((n, c) => n + c.tokens, 0);
  return {
    needed: true,
    reason: `estimated ${t.tokensEstimate} tokens against a ${CONTEXT_LIMIT} limit`,
    summarise: candidates,
    keep,
    freesApprox: freed,
    keptPinned: keep.filter((k) => t.pinned.includes(k.id)).length,
  };
}

/** Apply a summary the caller produced, replacing the turns it covers. */
export function applyCompaction(threadId, { summary, replacedIds }) {
  const t = threads.get(threadId);
  if (!t) return null;
  const gone = new Set(replacedIds);
  t.turns = t.turns.filter((x) => !gone.has(x.id));
  t.archive.push({
    id: randomUUID(), at: Date.now(), summary,
    covered: replacedIds.length,
    tokens: estimate(summary),
  });
  t.tokensEstimate = t.turns.reduce((n, x) => n + x.tokens, 0)
    + t.archive.reduce((n, a) => n + a.tokens, 0);
  t.updatedAt = Date.now();
  persist();
  return t;
}

/** What actually goes to the model: archive summaries first, then live turns. */
export function buildContext(threadId) {
  const t = threads.get(threadId);
  if (!t) return [];
  const out = [];
  if (t.archive.length) {
    out.push({
      role: "system",
      content: "Earlier in this chat, summarised:\n\n" +
        t.archive.map((a) => a.summary).join("\n\n"),
    });
  }
  for (const turn of t.turns) {
    out.push({ role: turn.role, content: turn.text ?? "" });
  }
  return out;
}

export function attachAsset(threadId, assetId) {
  const t = threads.get(threadId);
  if (!t) return null;
  if (!t.assetIds.includes(assetId)) t.assetIds.push(assetId);
  t.updatedAt = Date.now(); persist(); return t;
}

export function attachArtifact(threadId, artifactId) {
  const t = threads.get(threadId);
  if (!t) return null;
  t.artifactIds.push(artifactId);
  t.updatedAt = Date.now(); persist(); return t;
}

export function publicView(t) {
  return {
    id: t.id, workspaceId: t.workspaceId, title: t.title,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    turns: t.turns.map(({ id, at, role, text, tool }) => ({ id, at, role, text, tool })),
    compactions: t.archive.length,
    tokensEstimate: t.tokensEstimate,
    contextLimit: CONTEXT_LIMIT,
    assetIds: t.assetIds, artifactIds: t.artifactIds,
  };
}
