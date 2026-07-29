// Workspaces without accounts.
//
// There is no sign-up, no email, no user row. A workspace is a random id plus a
// 256-bit capability the browser generates and keeps. The server stores only a
// SHA-256 of that capability, so a database dump does not let anyone resume
// somebody's workspace.
//
// The consequences are real and the UI has to say them out loud:
//   * Lose the capability and the workspace is unreachable. There is no reset.
//   * It does not follow you to another browser or device.
//   * Clearing site data ends it.
//
// The wallet is deliberately NOT the identity. It is connected only when a
// funding transfer needs signing, so browsing and reading cost no key access.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.mjs";

const DIR = join(ROOT, ".club");
const FILE = join(DIR, "workspaces.json");

const sha = (s) => createHash("sha256").update(s).digest();

/** in-memory index, persisted on every mutation */
const spaces = new Map();

function load() {
  if (!existsSync(FILE)) return;
  try {
    for (const w of JSON.parse(readFileSync(FILE, "utf8"))) spaces.set(w.id, w);
  } catch { /* a corrupt index must not stop the server booting */ }
}
function persist() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify([...spaces.values()], null, 2));
}
load();

/**
 * Mint a workspace. The capability is returned exactly once and never stored
 * in the clear; if the caller loses it, the workspace is gone.
 */
export function createWorkspace({ title = "New task" } = {}) {
  const capability = randomBytes(32).toString("base64url");
  const w = {
    id: randomUUID(),
    capHash: sha(capability).toString("base64"),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    wallet: null,        // set on first funding
    funder: null,        // the account the balance returns to
    messages: [],
    files: [],
    runs: [],
    state: "idle",
  };
  spaces.set(w.id, w);
  persist();
  return { workspace: publicView(w), capability };
}

/** Constant-time check so a wrong capability leaks nothing through timing. */
export function authorise(id, capability) {
  const w = spaces.get(id);
  if (!w || !capability) return null;
  let given;
  try { given = sha(capability); } catch { return null; }
  const held = Buffer.from(w.capHash, "base64");
  if (given.length !== held.length) return null;
  return timingSafeEqual(given, held) ? w : null;
}

export function get(id) { return spaces.get(id) ?? null; }

export function update(id, patch) {
  const w = spaces.get(id);
  if (!w) return null;
  Object.assign(w, patch, { updatedAt: Date.now() });
  persist();
  return w;
}

export function appendMessage(id, msg) {
  const w = spaces.get(id);
  if (!w) return null;
  w.messages.push({ ...msg, at: Date.now() });
  w.updatedAt = Date.now();
  // keep the transcript bounded; a runaway loop must not grow the file forever
  if (w.messages.length > 400) w.messages.splice(0, w.messages.length - 400);
  persist();
  return w;
}

/** Never leak the capability hash or the wallet key to a client. */
export function publicView(w) {
  return {
    id: w.id,
    title: w.title,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    state: w.state,
    funder: w.funder,
    walletAccount: w.wallet?.accountId ?? null,
    messages: w.messages,
    files: w.files.map((f) => ({ id: f.id, name: f.name, bytes: f.bytes })),
    runs: w.runs,
  };
}

/**
 * Workspaces are ephemeral by design. Anything untouched for a day is closed,
 * which also forces any custodial balance back to its funder rather than
 * leaving it sitting in an account nobody is watching.
 */
export const IDLE_MS = Number(process.env.CLUB_IDLE_MS ?? 24 * 60 * 60 * 1000);

export function expired() {
  const now = Date.now();
  return [...spaces.values()].filter(
    (w) => w.state !== "closed" && now - w.updatedAt > IDLE_MS
  );
}

export function all() { return [...spaces.values()]; }
