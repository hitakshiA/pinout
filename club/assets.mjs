// Files the human gives a workspace.
//
// The agent never receives file contents in its context. A 200 MB video and a
// 2 KB CSV both arrive as one line of metadata, and the agent moves them onto a
// rented machine by name. That is the only thing that scales: the context
// window is the most expensive storage in the system and the worst place to put
// a file that a machine could read directly.
//
// Content is addressed by sha256, so uploading the same file twice costs one
// copy on disk and the agent can prove the bytes it staged are the bytes it was
// given.
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync,
} from "node:fs";
import { join, extname } from "node:path";
import { ROOT } from "../src/config.mjs";

const DIR = join(ROOT, ".club");
const BLOBS = join(DIR, "blobs");
const INDEX = join(DIR, "assets.json");

/** Anything bigger than this is refused: it is a testnet build, not a CDN. */
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;
/** The compute API caps a single upload here, so bigger files must be chunked. */
export const MACHINE_UPLOAD_CAP = 32 * 1024 * 1024;

const assets = new Map();

function load() {
  if (!existsSync(INDEX)) return;
  try { for (const a of JSON.parse(readFileSync(INDEX, "utf8"))) assets.set(a.id, a); }
  catch { /* a corrupt index must not stop the server booting */ }
}
function persist() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(INDEX, JSON.stringify([...assets.values()], null, 2));
}
load();

const TYPES = {
  ".csv": "text/csv", ".json": "application/json", ".txt": "text/plain",
  ".md": "text/markdown", ".py": "text/x-python", ".parquet": "application/parquet",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".zip": "application/zip", ".npy": "application/npy",
  ".pt": "application/octet-stream", ".safetensors": "application/octet-stream",
};

/**
 * Store bytes against a workspace. Returns metadata only, never content.
 */
export function put(workspaceId, { name, bytes, threadId = null }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > MAX_ASSET_BYTES) {
    throw new Error(`file is ${buf.length} bytes, over the ${MAX_ASSET_BYTES} limit`);
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");

  mkdirSync(BLOBS, { recursive: true });
  const blob = join(BLOBS, sha256);
  // content addressed: the same bytes uploaded twice are stored once
  if (!existsSync(blob)) writeFileSync(blob, buf);

  const existing = [...assets.values()].find(
    (a) => a.workspaceId === workspaceId && a.threadId === threadId &&
           a.sha256 === sha256 && a.name === name
  );
  if (existing) return existing;

  const asset = {
    id: randomUUID(),
    workspaceId,
    // Files belong to a chat, not to the account. Two chats in one workspace
    // are two separate pieces of work and must not see each other's inputs or
    // each other's results.
    threadId,
    name,
    bytes: buf.length,
    sha256,
    contentType: TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
    // a file over the machine upload cap has to be split, and the agent needs
    // to know that before it plans rather than at the moment the upload fails
    needsChunking: buf.length > MACHINE_UPLOAD_CAP,
    createdAt: Date.now(),
  };
  assets.set(asset.id, asset);
  persist();
  return asset;
}

/**
 * A file the agent produced and is handing back. Stored the same way as an
 * input, marked so the UI can show "you gave me these / here is what I made".
 * Provenance is kept because a result nobody can trace back to a paid session
 * is just a file.
 */
export function deliver(workspaceId, { name, bytes, description, fromPath, sessionId, threadId = null }) {
  const asset = put(workspaceId, { name, bytes, threadId });
  asset.kind = "artifact";
  asset.description = description ?? null;
  asset.fromPath = fromPath ?? null;
  asset.sessionId = sessionId ?? null;
  asset.deliveredAt = Date.now();
  persist();
  return asset;
}

const scope = (a, wid, tid) =>
  a.workspaceId === wid && (tid === undefined || a.threadId === tid);

/** Inputs the human attached. Pass a threadId to scope to one chat. */
export const forWorkspace = (wid, tid) =>
  [...assets.values()].filter((a) => scope(a, wid, tid) && a.kind !== "artifact");

/** Files the agent produced. Pass a threadId to scope to one chat. */
export const artifactsOf = (wid, tid) =>
  [...assets.values()].filter((a) => scope(a, wid, tid) && a.kind === "artifact");

export const get = (id) => assets.get(id) ?? null;

export function byName(workspaceId, name, threadId) {
  return [...assets.values()].find(
    (a) => scope(a, workspaceId, threadId) && a.name === name
  ) ?? null;
}

/** Read the bytes back. Server-side only; this never goes into a prompt. */
export function read(id) {
  const a = assets.get(id);
  if (!a) throw new Error("no such asset");
  const blob = join(BLOBS, a.sha256);
  if (!existsSync(blob)) throw new Error(`blob missing for ${a.name}`);
  return readFileSync(blob);
}

/** A short, honest peek for the agent to plan against, for text-ish files. */
export function preview(id, maxChars = 800) {
  const a = assets.get(id);
  if (!a) throw new Error("no such asset");
  const textish = /^(text\/|application\/(json|npy)$)/.test(a.contentType);
  if (!textish) {
    return { previewable: false, why: `${a.contentType} is not text, read it on a machine instead` };
  }
  const buf = read(id);
  const head = buf.subarray(0, maxChars).toString("utf8");
  return {
    previewable: true,
    head,
    truncated: buf.length > maxChars,
    totalBytes: a.bytes,
  };
}
