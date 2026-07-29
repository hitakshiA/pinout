"use client";

import { useState } from "react";
import { hbar, type Asset, type Chat, type LedgerEntry, type Wallet } from "./api";

/**
 * The session panel.
 *
 * Cowork puts artifacts here. A metered agent needs a fourth thing Cowork has
 * no use for, which is money, so the wallet lives here too: the balance, the
 * bill, and a way to put HBAR in or take it out. Every line that moved value
 * links to HashScan, because "check it yourself" is only a real offer if the
 * link is right there.
 */

const KIND: Record<string, { label: string; out?: boolean }> = {
  wallet_opened: { label: "Wallet opened" },
  funded: { label: "Funded" },
  withdrawn: { label: "Withdrawn", out: true },
  swept: { label: "Returned on close", out: true },
  payment: { label: "Paid for compute", out: true },
  refund: { label: "Refunded" },
  anchor: { label: "Settlement anchor", out: true },
};

function Ledger({ rows }: { rows: LedgerEntry[] }) {
  if (!rows.length) {
    return <div className="ws-empty">Nothing has moved yet.<br />Every payment and refund will appear here with a link to HashScan.</div>;
  }
  return (
    <div>
      {[...rows].reverse().map((r, i) => {
        const k = KIND[r.kind] ?? { label: r.kind };
        return (
          <div className="ws-row" key={i}>
            <div>
              <div>{k.label}</div>
              <div className="ws-row-k" style={{ fontSize: 11.5, marginTop: 2 }}>
                {new Date(r.at).toLocaleTimeString()}
                {r.to ? ` → ${r.to}` : r.from ? ` ← ${r.from}` : ""}
              </div>
            </div>
            <div className="ws-row-v">
              <div className={k.out ? "ws-out-amt" : "ws-in-amt"}>
                {k.out ? "−" : "+"}{hbar(r.tinybar)}
              </div>
              {r.hashscan && (
                <a className="ws-link" href={r.hashscan} target="_blank" rel="noreferrer">
                  HashScan ↗
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Money({
  wallet, onFundDirect, onFundSigned, onWithdraw, busy, needs,
}: {
  wallet: Wallet | null;
  needs: number | null;
  onFundDirect: (tinybar: number) => void;
  onFundSigned: (from: string, tinybar: number) => void;
  onWithdraw: (tinybar: number | undefined, to: string | undefined) => void;
  busy: boolean;
}) {
  const [amount, setAmount] = useState("1.5");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<"wallet" | "direct">("wallet");

  const tinybar = Math.round(parseFloat(amount || "0") * 1e8);

  return (
    <div>
      <div className="ws-balance" data-low={needs != null && (wallet?.tinybar ?? 0) < needs}>
        {hbar(wallet?.tinybar)}
      </div>
      {needs != null && (wallet?.tinybar ?? 0) < needs && (
        <div className="ws-shortfall">
          The agent is waiting for {hbar(needs)} and cannot continue until the
          wallet covers it. Short by {hbar(needs - (wallet?.tinybar ?? 0))}.
        </div>
      )}
      <div className="ws-balance-sub">
        {wallet?.accountId ? (
          <>
            this chat&rsquo;s wallet ·{" "}
            <a className="ws-link" href={wallet.hashscan ?? "#"} target="_blank" rel="noreferrer">
              {wallet.accountId} ↗
            </a>
          </>
        ) : (
          "no wallet yet, it opens when you first fund it"
        )}
      </div>

      <div style={{ display: "flex", gap: 4, margin: "16px 0 4px" }}>
        <button className="ws-tab" data-active={mode === "wallet"} onClick={() => setMode("wallet")}>
          Connect wallet
        </button>
        <button className="ws-tab" data-active={mode === "direct"} onClick={() => setMode("direct")}>
          Send directly
        </button>
      </div>

      <label className="ws-label">Amount in HBAR</label>
      <input className="ws-field" value={amount} inputMode="decimal"
             onChange={(e) => setAmount(e.target.value)} />

      {mode === "wallet" ? (
        <>
          <label className="ws-label">Your Hedera account</label>
          <input className="ws-field" placeholder="0.0.12345" value={from}
                 onChange={(e) => setFrom(e.target.value)} />
          <div className="ws-balance-sub" style={{ marginTop: 8 }}>
            Sign the transfer in your wallet, then confirm here. The balance can only
            ever be returned to the account it came from.
          </div>
          <button className="ws-btn ws-btn-primary" style={{ marginTop: 11, width: "100%" }}
                  disabled={busy || !from.trim() || !(tinybar > 0)}
                  onClick={() => onFundSigned(from.trim(), tinybar)}>
            I have sent it, confirm
          </button>
        </>
      ) : (
        <>
          <div className="ws-balance-sub" style={{ marginTop: 8 }}>
            Funds the chat from the operator account so you can watch the whole flow
            without a wallet installed. Real HBAR, real payments, testnet.
          </div>
          <button className="ws-btn ws-btn-primary" style={{ marginTop: 11, width: "100%" }}
                  disabled={busy || !(tinybar > 0)}
                  onClick={() => onFundDirect(tinybar)}>
            Send {hbar(tinybar)} to the agent
          </button>
        </>
      )}

      {wallet?.accountId && (
        <>
          <div style={{ height: 1, background: "var(--ws-line)", margin: "20px 0 4px" }} />
          <label className="ws-label">Take money back</label>
          <input className="ws-field" placeholder={wallet.funder ?? "0.0.12345"} value={to}
                 onChange={(e) => setTo(e.target.value)} />
          <div className="ws-balance-sub" style={{ marginTop: 6 }}>
            Leave blank to return it to {wallet.funder ?? "the funding account"}. You can do
            this at any time, including while the agent is working.
          </div>
          <button className="ws-btn" style={{ marginTop: 10, width: "100%" }} disabled={busy}
                  onClick={() => onWithdraw(undefined, to.trim() || undefined)}>
            Withdraw everything
          </button>
        </>
      )}

      <div className="ws-sec" style={{ padding: "22px 0 4px" }}>Bill</div>
      <Ledger rows={wallet?.ledger ?? []} />

      {wallet?.custody && (
        <div className="ws-balance-sub" style={{ marginTop: 20, lineHeight: 1.6 }}>
          <b style={{ color: "var(--ws-warn)" }}>Custodial.</b> {wallet.custody.whileOpen}{" "}
          {wallet.custody.onClose}
        </div>
      )}
    </div>
  );
}

function Files({
  assets, artifacts, urlFor, onOpen,
}: { assets: Asset[]; artifacts: Asset[]; urlFor: (id: string) => string;
     onOpen: (a: Asset) => void }) {
  const row = (a: Asset, made: boolean) => (
    <div className="ws-row ws-rowclick" key={a.id} onClick={() => onOpen(a)}>
      <div style={{ minWidth: 0 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {a.name}
        </div>
        <div className="ws-row-k" style={{ fontSize: 11.5, marginTop: 2 }}>
          {a.bytes > 1e6 ? `${(a.bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(a.bytes / 1024)} KB`}
          {" · "}<span className="ws-mono">{a.sha256.slice(0, 10)}</span>
        </div>
      </div>
      <span className="ws-link">{made ? "Open" : "View"}</span>
    </div>
  );

  return (
    <div>
      <div className="ws-sec" style={{ padding: "0 0 4px" }}>You gave it</div>
      {assets.length ? assets.map((a) => row(a, false))
        : <div className="ws-empty">No files attached.</div>}

      <div className="ws-sec" style={{ padding: "20px 0 4px" }}>It made</div>
      {artifacts.length ? artifacts.map((a) => row(a, true))
        : <div className="ws-empty">Nothing delivered yet.</div>}
    </div>
  );
}

function Session({ chat }: { chat: Chat | null }) {
  if (!chat) return <div className="ws-empty">No chat open.</div>;
  const pct = Math.min(100, Math.round((chat.tokensEstimate / chat.contextLimit) * 100));
  return (
    <div>
      <div className="ws-row"><span className="ws-row-k">Chat</span>
        <span className="ws-row-v ws-mono">{chat.id.slice(0, 8)}</span></div>
      <div className="ws-row"><span className="ws-row-k">Turns</span>
        <span className="ws-row-v">{chat.turns.length}</span></div>
      <div className="ws-row"><span className="ws-row-k">Run</span>
        <span className="ws-row-v">{chat.run?.state ?? "idle"}</span></div>

      <div className="ws-sec" style={{ padding: "20px 0 4px" }}>Memory</div>
      <div className="ws-row">
        <span className="ws-row-k">Context used</span>
        <span className="ws-row-v">{pct}% of {(chat.contextLimit / 1000) | 0}k</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: "var(--ws-raise)", overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: pct > 85 ? "var(--ws-warn)" : "var(--ws-purple)",
          transition: "width .4s ease",
        }} />
      </div>
      <div className="ws-row" style={{ marginTop: 8 }}>
        <span className="ws-row-k">Compactions</span>
        <span className="ws-row-v">{chat.compactions}</span>
      </div>
      <div className="ws-balance-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>
        This chat has its own memory. When it fills, older turns are summarised, but
        anything that records money moving is kept verbatim.
      </div>
    </div>
  );
}

export function Panel({
  chat, wallet, tab, setTab, urlFor, onFundDirect, onFundSigned, onWithdraw, busy, onClose,
  onOpen, needs,
}: {
  onOpen: (a: Asset) => void;
  chat: Chat | null; wallet: Wallet | null;
  tab: string; setTab: (t: string) => void;
  urlFor: (id: string) => string;
  onFundDirect: (t: number) => void;
  onFundSigned: (from: string, t: number) => void;
  onWithdraw: (t: number | undefined, to: string | undefined) => void;
  busy: boolean; onClose: () => void; needs: number | null;
}) {
  return (
    <aside className="ws-panel">
      <div className="ws-panel-tabs">
        {["Wallet", "Files", "Session"].map((t) => (
          <button key={t} className="ws-tab" data-active={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <span className="ws-top-spacer" style={{ flex: 1 }} />
        <button className="ws-icon-btn" onClick={onClose} aria-label="Close panel">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="ws-panel-body">
        {tab === "Wallet" && (
          <Money wallet={wallet} onFundDirect={onFundDirect} onFundSigned={onFundSigned}
                 onWithdraw={onWithdraw} busy={busy} needs={needs} />
        )}
        {tab === "Files" && (
          <Files assets={chat?.assets ?? []} artifacts={chat?.artifacts ?? []}
                 urlFor={urlFor} onOpen={onOpen} />
        )}
        {tab === "Session" && <Session chat={chat} />}
      </div>
    </aside>
  );
}
