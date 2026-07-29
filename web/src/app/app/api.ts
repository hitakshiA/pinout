"use client";

/**
 * The club API, and the capability that gets you back into your own workspace.
 *
 * There is no sign-in. A workspace is a random id plus a 256-bit capability the
 * browser keeps; the server holds only its hash. That means losing this
 * localStorage entry loses the workspace, with no reset and no recovery, which
 * the UI has to say out loud rather than discover for someone later.
 */

export const CLUB =
  process.env.NEXT_PUBLIC_CLUB_URL ?? "http://localhost:4022";

const KEY = "pinout.workspace";

export type Held = { id: string; cap: string };

export function held(): Held | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Held) : null;
  } catch {
    return null;
  }
}

export function hold(h: Held) {
  localStorage.setItem(KEY, JSON.stringify(h));
}

export function release() {
  localStorage.removeItem(KEY);
}

async function call<T>(path: string, init: RequestInit & { cap?: string } = {}): Promise<T> {
  const { cap, ...rest } = init;
  const res = await fetch(`${CLUB}${path}`, {
    ...rest,
    headers: {
      ...(cap ? { Authorization: `Workspace ${cap}` } : {}),
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status}`);
  return body as T;
}

const post = <T,>(p: string, cap: string, body?: unknown) =>
  call<T>(p, { method: "POST", cap, body: body ? JSON.stringify(body) : undefined });

export const api = {
  createWorkspace: (title?: string) =>
    call<{ workspace: { id: string }; capability: string }>("/workspace", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  chats: (id: string, cap: string) =>
    call<{ chats: ChatSummary[]; activeChatId: string | null }>(
      `/workspace/${id}/chats`, { cap }),

  newChat: (id: string, cap: string, title?: string) =>
    post<Chat>(`/workspace/${id}/chats`, cap, { title }),

  chat: (id: string, cap: string, chatId: string) =>
    call<Chat>(`/workspace/${id}/chats/${chatId}`, { cap }),

  deleteChat: (id: string, cap: string, chatId: string) =>
    call<{ deleted: boolean }>(`/workspace/${id}/chats/${chatId}`, { method: "DELETE", cap }),

  run: (id: string, cap: string, chatId: string, task: string, ceilingTinybar: number) =>
    post<{ started: boolean }>(`/workspace/${id}/chats/${chatId}/run`, cap, {
      task, ceilingTinybar,
    }),

  attach: (id: string, cap: string, chatId: string, name: string, contentBase64: string) =>
    post<Asset>(`/workspace/${id}/chats/${chatId}/files`, cap, { name, contentBase64 }),

  wallet: (id: string, cap: string, chatId: string) =>
    call<Wallet>(`/workspace/${id}/chats/${chatId}/wallet`, { cap }),

  fundDirect: (id: string, cap: string, chatId: string, tinybar: number) =>
    post<{ accountId: string; tinybar: number; hashscan?: string }>(
      `/workspace/${id}/chats/${chatId}/fund-direct`, cap, { tinybar }),

  fundSigned: (id: string, cap: string, funderAccountId: string, tinybar: number) =>
    post<{ accountId?: string; pending?: boolean; hashscan?: string }>(
      `/workspace/${id}/fund`, cap, { funderAccountId, tinybar }),

  withdraw: (id: string, cap: string, chatId: string, tinybar?: number, to?: string) =>
    post<{ withdrawn: number; to: string; hashscan?: string }>(
      `/workspace/${id}/chats/${chatId}/withdraw`, cap, { tinybar, to }),

  decide: (id: string, cap: string, verdict: string, feedback?: string) =>
    post<unknown>(`/workspace/${id}/decide`, cap, { verdict, feedback }),

  closeChat: (id: string, cap: string, chatId: string) =>
    post<unknown>(`/workspace/${id}/chats/${chatId}/close`, cap),

  fileUrl: (id: string, cap: string, assetId: string) =>
    `${CLUB}/workspace/${id}/files/${assetId}?cap=${encodeURIComponent(cap)}`,

  eventsUrl: (id: string, cap: string) =>
    `${CLUB}/workspace/${id}/events?cap=${encodeURIComponent(cap)}`,
};

/* ---------- shapes ---------- */

export type ChatSummary = {
  id: string; title: string; updatedAt: number;
  turns: number; artifacts: number; running: boolean;
};

export type Asset = {
  id: string; name: string; bytes: number; contentType: string;
  sha256: string; description?: string | null;
};

export type Turn = {
  id: string; at: number; role: string; text?: string;
  tool?: { name: string } | null;
};

export type Chat = {
  id: string; title: string; createdAt: number; updatedAt: number;
  turns: Turn[]; compactions: number;
  tokensEstimate: number; contextLimit: number;
  assets: Asset[]; artifacts: Asset[];
  wallet: { accountId: string; funder: string | null } | null;
  ledger: LedgerEntry[];
  run: RunState | null;
};

export type LedgerEntry = {
  at: number; kind: string; tinybar?: number; hbar?: number;
  from?: string; to?: string; txId?: string; hashscan?: string | null;
  accountId?: string;
};

export type Wallet = {
  accountId: string | null; funder: string | null;
  tinybar: number | null; hbar: number | null; hashscan: string | null;
  ledger: LedgerEntry[];
  custody: { summary: string; whileOpen: string; onClose: string; maxTinybar: number };
};

export type RunState = {
  state: string;
  awaitingApproval: { callId: string; ask: Record<string, unknown> } | null;
  ceilingTinybar: number;
  log: RunEvent[];
};

export type RunEvent = {
  type: string; at: number;
  [k: string]: unknown;
};

/** tinybar is the unit that is correct; HBAR is the unit people read. */
export const hbar = (t?: number | null, dp = 4) =>
  t == null ? "—" : `${(t / 1e8).toFixed(dp)} ℏ`;
