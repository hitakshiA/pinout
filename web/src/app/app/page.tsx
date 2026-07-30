"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Mark from "@/components/Mark";
import {
  api, held, hold, hbar,
  type Chat, type ChatSummary, type RunEvent, type Wallet,
} from "./api";
import {
  AgentText, ArtifactCard, FundingAsk, ToolLine, Working, useStickToBottom,
  type ToolMark,
} from "./Transcript";
import { Panel } from "./Panel";
import { Preview } from "./Preview";
import { Examples, loadSample, type Example } from "./Examples";
import { PendingFiles, SentFiles, type Attached } from "./Attachments";
import { ACCEPT, checkFile } from "./files";
import type { Asset } from "./api";

/**
 * One agent workspace, no sign-in.
 *
 * The transcript is assembled from the event stream rather than polled, because
 * the interesting part of a metered agent is watching it decide: the reasoning,
 * the tools, the moment it asks for money. Turns are grouped so a burst of tool
 * calls collapses into one line under the sentence that caused it.
 */

type Block =
  | { k: "user"; id: string; text: string; files?: Attached[] }
  | { k: "agent"; id: string; text: string; tools: ToolMark[]; streaming?: boolean }
  | { k: "ask"; id: string; ev: RunEvent }
  | { k: "artifact"; id: string; name: string; bytes: number; kind: string }
  | { k: "decision"; id: string; verdict: string; amount: number; feedback: string | null }
  | { k: "note"; id: string; text: string; tone?: "warn" | "bad" };

export default function Workspace() {
  const [ws, setWs] = useState<{ id: string; cap: string } | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [working, setWorking] = useState<{ what: string; since: number } | null>(null);
  const [ask, setAsk] = useState<RunEvent | null>(null);
  const [busy, setBusy] = useState(false);
  // "the start request returned" is not "the job finished". A billed run is
  // live until a terminal state arrives, and the composer must stay shut until
  // then or a second submit lands a phantom turn the server will reject.
  const [running, setRunning] = useState(false);

  const [sideOpen, setSideOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  // below 1240 the rails float over the transcript rather than squeezing it
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1240px)");
    const on = () => { setFloating(mq.matches); if (mq.matches) setPanelOpen(false); };
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const [tab, setTab] = useState("Wallet");
  // an artifact opens a real preview, not a file list
  const [preview, setPreview] = useState<Asset | null>(null);
  // what the agent is blocked on, so the panel can say so plainly
  const [needs, setNeeds] = useState<number | null>(null);

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [local, setLocal] = useState<{ asset: Asset; url: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useStickToBottom(blocks.length + (working ? 1 : 0));

  /* ---------- workspace bootstrap: resume or mint ---------- */
  useEffect(() => {
    (async () => {
      const h = held();
      if (h) {
        try {
          const list = await api.chats(h.id, h.cap);
          setWs(h); setChats(list.chats);
          if (list.chats[0]) setChatId(list.chats[0].id);
          return;
        } catch {
          /* capability no longer opens anything; start clean */
        }
      }
      const made = await api.createWorkspace("Pinout workspace");
      const next = { id: made.workspace.id, cap: made.capability };
      hold(next); setWs(next);
      const c = await api.newChat(next.id, next.cap, "New task");
      setChats([{ id: c.id, title: c.title, updatedAt: Date.now(), turns: 0, artifacts: 0, running: false }]);
      setChatId(c.id);
    })().catch(() => {});
  }, []);

  const refreshChat = useCallback(async () => {
    if (!ws || !chatId) return;
    const [c, w] = await Promise.all([
      api.chat(ws.id, ws.cap, chatId),
      api.wallet(ws.id, ws.cap, chatId).catch(() => null),
    ]);
    setChat(c); setWallet(w);
  }, [ws, chatId]);

  /* The balance moves without telling anyone.
   *
   * It was refreshed only on discrete events, so the panel showed 3.0000 HBAR
   * while the agent had spent its way down to 0.4404 and was asking for more.
   * A number that stale about money is worse than no number: it makes the
   * agent look like it is stalling when it is waiting for funds it genuinely
   * needs. While a run is live the wallet is re-read on a timer. */
  useEffect(() => {
    if (!ws || !chatId || !running) return;
    const t = setInterval(() => {
      api.wallet(ws.id, ws.cap, chatId).then(setWallet).catch(() => {});
    }, 6000);
    return () => clearInterval(t);
  }, [ws, chatId, running]);

  /* The composer grew only on keystrokes, so a prompt dropped in by an example
     stayed one line tall and hid its own tail. Size follows the value. */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(190, el.scrollHeight)}px`;
  }, [draft]);

  /* ---------- load a chat, replaying what it already holds ---------- */
  useEffect(() => {
    if (!ws || !chatId) return;
    (async () => {
      const c = await api.chat(ws.id, ws.cap, chatId);
      setChat(c);
      setWallet(await api.wallet(ws.id, ws.cap, chatId).catch(() => null));
      const seed: Block[] = [];
      const placed = new Set<string>();
      for (const t of c.turns) {
        if (t.role === "user") {
          // An upload is recorded moments before the turn that carried it, so
          // a reload can put it back by finding the first user turn after it.
          const mine = (c.assets ?? []).filter(
            (a) => a.createdAt != null && a.createdAt <= t.at && !placed.has(a.id));
          mine.forEach((a) => placed.add(a.id));
          seed.push({
            k: "user", id: t.id, text: t.text ?? "",
            files: mine.map((a) => ({
              name: a.name, bytes: a.bytes,
              src: api.fileUrl(ws.id, ws.cap, a.id),
            })),
          });
        }
        else if (t.role === "assistant") seed.push({ k: "agent", id: t.id, text: t.text ?? "", tools: [] });
        else if (t.role === "tool" && t.text) {
          // a reload used to lose every tool line; the turns hold them
          const last = seed[seed.length - 1];
          const mark: ToolMark = { name: t.text, done: true, ok: true };
          if (last?.k === "agent") last.tools.push(mark);
          else seed.push({ k: "agent", id: t.id, text: "", tools: [mark] });
        }
      }
      for (const a of c.artifacts) {
        seed.push({ k: "artifact", id: a.id, name: a.name, bytes: a.bytes, kind: "Artifact" });
      }
      // A reload used to lose the spend request: it was read into state and
      // never rendered, so the run sat waiting with no Approve or Deny anywhere
      // on the page. The card is rebuilt from the run's own log, which holds
      // the full ask rather than just the arguments.
      const pending = c.run?.awaitingApproval;
      if (pending) {
        const fromLog = [...(c.run?.log ?? [])].reverse()
          .find((e) => e.type === "approval_needed") as RunEvent | undefined;
        const ev = fromLog ?? ({ type: "approval_needed", at: Date.now(),
                                 ...(pending.ask as object) } as RunEvent);
        seed.push({ k: "ask", id: `ask-${pending.callId}`, ev });
        setAsk(ev);
      } else setAsk(null);
      setBlocks(seed);
    })().catch(() => {});
  }, [ws, chatId]);

  /* ---------- the event stream ---------- */
  useEffect(() => {
    if (!ws) return;
    const ctrl = new AbortController();
    (async () => {
      const res = await fetch(api.eventsUrl(ws.id, ws.cap), { signal: ctrl.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const line = f.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try { handle(JSON.parse(line.slice(5).trim()) as RunEvent); } catch { /* keepalive */ }
        }
      }
    })().catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // the open chat, readable from inside the stream handler without
  // re-subscribing the stream every time the selection changes
  const openChat = useRef<string | null>(null);
  useEffect(() => { openChat.current = chatId; }, [chatId]);

  /** Fold one event into the transcript. */
  const handle = useCallback((ev: RunEvent) => {
    // Events are per workspace, chats are not. Without this, a run in one chat
    // writes its prose, its spend request and its artifacts into whichever
    // chat the user happens to be looking at.
    if (ev.threadId && openChat.current && ev.threadId !== openChat.current) return;
    if (ev.type === "ping") return;
    const id = `${ev.type}-${ev.at}-${Math.random().toString(36).slice(2, 7)}`;
    switch (ev.type) {
      case "text": {
        // stream into the open agent block, or start one
        setWorking(null);
        setBlocks((b) => {
          const last = b[b.length - 1];
          if (last?.k === "agent" && last.streaming) {
            const copy = [...b];
            copy[copy.length - 1] = { ...last, text: last.text + String(ev.delta ?? "") };
            return copy;
          }
          return [...b, { k: "agent", id, text: String(ev.delta ?? ""), tools: [], streaming: true }];
        });
        break;
      }
      case "tool": {
        // attach to the sentence it belongs to
        setWorking({ what: "Working", since: Date.now() });
        setBlocks((b) => {
          const copy = [...b];
          for (let i = copy.length - 1; i >= 0; i--) {
            const blk = copy[i];
            if (blk.k === "agent") {
              copy[i] = { ...blk, streaming: false,
                          tools: [...blk.tools, { name: String(ev.name ?? "") }] };
              return copy;
            }
          }
          return [...copy, { k: "agent", id, text: "", tools: [{ name: String(ev.name ?? "") }] }];
        });
        break;
      }
      case "tool_settled": {
        // Settle the oldest still-pending call, not one matched by name.
        //
        // The name is not on this event: it arrived as "?" every time, so
        // matching by name settled nothing and every tool line stayed in the
        // present tense for the life of the run. Results come back in the
        // order the calls were made, so position is the reliable key and the
        // name was never needed.
        setBlocks((b) => {
          const copy = [...b];
          for (let i = 0; i < copy.length; i++) {
            const blk = copy[i];
            if (blk.k !== "agent") continue;
            const at = blk.tools.findIndex((m) => !m.done);
            if (at === -1) continue;
            const tools = [...blk.tools];
            tools[at] = { ...tools[at], done: true, ok: ev.ok !== false };
            copy[i] = { ...blk, tools };
            return copy;
          }
          return copy;
        });
        break;
      }
      case "approval_needed":
        setWorking(null);
        setAsk(ev);
        setBlocks((b) => [...b, { k: "ask", id, ev }]);
        break;
      case "decision": {
        // Replace the card with what was decided. Deleting it outright threw
        // away the only record that money had been asked for and answered,
        // which is exactly the thing worth keeping.
        setAsk(null);
        const verdict = String(ev.verdict ?? "");
        const amt = Number((ev.ask as Record<string, unknown> | undefined)?.requestTinybar ?? 0);
        setBlocks((b) => [
          ...b.filter((x) => x.k !== "ask"),
          { k: "decision", id, verdict,
            amount: amt, feedback: ev.feedback ? String(ev.feedback) : null },
        ]);
        break;
      }
      case "funding_needed":
        setNeeds(Number(ev.needTinybar));
        setPanelOpen(true); setTab("Wallet");
        setWorking({ what: `Waiting for ${hbar(Number(ev.needTinybar))}`, since: Date.now() });
        break;
      case "funded":
        setNeeds(null);
        setWorking(null);
        setBlocks((b) => [...b, {
          k: "note", id,
          text: `Wallet funded with ${hbar(Number(ev.tinybar))}${ev.accountId ? ` · ${ev.accountId}` : ""}`,
        }]);
        refreshChat();
        break;
      case "artifact":
        setBlocks((b) => [...b, {
          k: "artifact", id, name: String(ev.name), bytes: Number(ev.bytes ?? 0), kind: "Artifact",
        }]);
        // twice: once now, once after the write has certainly landed, so the
        // card is clickable the instant it appears
        refreshChat();
        setTimeout(() => { refreshChat(); }, 1200);
        break;
      case "withdrawn":
        setBlocks((b) => [...b, {
          k: "note", id, text: `Withdrew ${hbar(Number(ev.withdrawn))} to ${String(ev.to)}`,
        }]);
        refreshChat();
        break;
      case "answer":
        setWorking(null);
        setBlocks((b) => {
          const last = b[b.length - 1];
          if (last?.k === "agent" && last.streaming) {
            const copy = [...b];
            copy[copy.length - 1] = { ...last, text: String(ev.text ?? last.text), streaming: false };
            return copy;
          }
          return [...b, { k: "agent", id, text: String(ev.text ?? ""), tools: [] }];
        });
        refreshChat();
        break;
      case "retrying":
        setBlocks((b) => [...b, {
          k: "note", id,
          text: `The model call failed (${String(ev.reason ?? "")}). Retrying, ` +
                `attempt ${ev.attempt} of ${ev.of}. Your machine is still held ` +
                `and the work so far is intact.`,
          tone: "warn",
        }]);
        break;
      case "error":
        setWorking(null);
        setBlocks((b) => [...b, {
          k: "note", id,
          text: (ev.humanMessage as string) ?? String(ev.message ?? "something went wrong"),
          tone: ev.recoverable ? "warn" : "bad",
        }]);
        break;
      case "state":
        if (["done", "failed", "closed"].includes(String(ev.state))) {
          setWorking(null); setRunning(false); refreshChat();
        }
        break;
    }
  }, [refreshChat]);

  /* ---------- actions ---------- */

  /**
   * Take files, but only ones the agent can actually open.
   *
   * Refusing here is much cheaper than refusing later: an unsupported file
   * that gets through is discovered on a rented machine, after the human has
   * paid to rent it, by an agent that can only report failure.
   */
  const addFiles = (picked: File[]) => {
    const ok: File[] = [];
    const bad: string[] = [];
    for (const f of picked) {
      const why = checkFile(f);
      if (why) bad.push(why); else ok.push(f);
    }
    if (ok.length) setPending((p) => [...p, ...ok]);
    // The complaint belongs next to the thing complained about. Put it in the
    // transcript and it competes with the agent's own output, and the chat
    // reload that replaces the block list can wipe it before it is read.
    setRejected(bad);
  };

  const dropFile = (i: number) => {
    setPending((p) => p.filter((_, n) => n !== i));
    setRejected([]);
    setLocal(null);
  };

  /**
   * Preview a file that has not been sent yet.
   *
   * It has no asset id and no hash, because nothing has uploaded it, so it is
   * shown from the browser's own copy. Checking you attached the right video
   * ought not to require paying an agent to look at it for you.
   */
  const openPending = (f: File, url: string) => {
    setPreview(null);
    setLocal({
      url,
      asset: {
        id: `local:${f.name}`, name: f.name, bytes: f.size,
        contentType: f.type || "application/octet-stream", sha256: "",
      },
    });
    setPanelOpen(false);
  };

  /**
   * Open a file by name, whether the agent made it or the human attached it.
   *
   * The block only carries a name, and the chat state it would be looked up in
   * can be a moment behind the event that announced it, so a miss re-reads
   * before giving up and showing the file list instead.
   */
  const openByName = async (name: string) => {
    const find = (c: Chat | null) =>
      c?.artifacts.find((x) => x.name === name) ?? c?.assets.find((x) => x.name === name);
    let a = find(chat);
    if (!a && ws && chatId) {
      const fresh = await api.chat(ws.id, ws.cap, chatId).catch(() => null);
      if (fresh) { setChat(fresh); a = find(fresh); }
    }
    if (a) { setLocal(null); setPreview(a); }
    else { setPanelOpen(true); setTab("Files"); }
  };

  const send = async () => {
    if (!ws || !chatId || (!draft.trim() && !pending.length) || busy || running) return;
    setBusy(true);
    try {
      const sent: Attached[] = [];
      for (const f of pending) {
        const b64 = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(",")[1]);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        const a = await api.attach(ws.id, ws.cap, chatId, f.name, b64);
        sent.push({
          name: f.name, bytes: f.size,
          src: a?.id ? api.fileUrl(ws.id, ws.cap, a.id) : null,
        });
      }
      // the panel used to wait for the whole run before showing the upload
      if (sent.length) refreshChat();
      const task = draft.trim();
      setBlocks((b) => [...b, { k: "user", id: `u${Date.now()}`, text: task, files: sent }]);
      setDraft(""); setPending([]); setRejected([]);
      setWorking({ what: "Thinking", since: Date.now() });
      setRunning(true);
      // a generous ceiling; the agent asks for what it needs inside it
      await api.run(ws.id, ws.cap, chatId, task, 900_000_000);
      refreshChat();
    } catch (e) {
      setBlocks((b) => [...b, { k: "note", id: `e${Date.now()}`, text: String(e), tone: "bad" }]);
    } finally { setBusy(false); }
  };

  /**
   * Stop a run that is spending money. Closing the chat settles its sessions
   * and sweeps the wallet, which is the honest meaning of "stop" here: the
   * machine stops billing and whatever is left comes back.
   */
  const stopRun = async () => {
    if (!ws || !chatId) return;
    setBusy(true);
    try {
      await api.closeChat(ws.id, ws.cap, chatId);
      setRunning(false); setWorking(null);
      setBlocks((b) => [...b, {
        k: "note", id: `s${Date.now()}`,
        text: "Stopped. The machine was released and the balance returned.",
      }]);
      await refreshChat();
    } catch (e) {
      setBlocks((b) => [...b, { k: "note", id: `s${Date.now()}`, text: String(e), tone: "bad" }]);
    } finally { setBusy(false); }
  };

  /**
   * Load an example into the composer: its file as an attachment, its prompt as
   * the draft. Nothing is uploaded yet, so it can be removed or edited first,
   * exactly like a file the person chose themselves.
   */
  const pickExample = async (e: Example) => {
    if (!ws || !chatId) return;
    setBusy(true);
    try {
      const f = await loadSample(e.file, e.mime);
      setPending([f]);
      setRejected([]);
      setDraft(e.prompt);
    } catch (err) {
      setRejected([`Could not load ${e.file}: ${String(err)}`]);
    } finally { setBusy(false); }
  };

  const decide = async (verdict: string, feedback?: string) => {
    if (!ws) return;
    setBusy(true);
    try { await api.decide(ws.id, ws.cap, verdict, feedback); setAsk(null); }
    finally { setBusy(false); }
  };

  const newChat = async () => {
    if (!ws) return;
    const c = await api.newChat(ws.id, ws.cap, "New task");
    setChats((s) => [{ id: c.id, title: c.title, updatedAt: Date.now(), turns: 0, artifacts: 0, running: false }, ...s]);
    setChatId(c.id); setBlocks([]);
  };

  const money = {
    fundDirect: async (t: number) => {
      if (!ws || !chatId) return;
      setBusy(true);
      try { await api.fundDirect(ws.id, ws.cap, chatId, t); await refreshChat(); }
      catch (e) { setBlocks((b) => [...b, { k: "note", id: `f${Date.now()}`, text: String(e), tone: "bad" }]); }
      finally { setBusy(false); }
    },
    fundSigned: async (from: string, t: number) => {
      if (!ws) return;
      setBusy(true);
      try { await api.fundSigned(ws.id, ws.cap, from, t); await refreshChat(); }
      catch (e) { setBlocks((b) => [...b, { k: "note", id: `f${Date.now()}`, text: String(e), tone: "bad" }]); }
      finally { setBusy(false); }
    },
    withdraw: async (t: number | undefined, to: string | undefined) => {
      if (!ws || !chatId) return;
      setBusy(true);
      try { await api.withdraw(ws.id, ws.cap, chatId, t, to); await refreshChat(); }
      catch (e) { setBlocks((b) => [...b, { k: "note", id: `w${Date.now()}`, text: String(e), tone: "bad" }]); }
      finally { setBusy(false); }
    },
  };

  const title = chats.find((c) => c.id === chatId)?.title ?? "New task";

  return (
    <>
      <aside className="ws-side" data-open={sideOpen}>
        <div className="ws-side-top">
          <div className="ws-brand"><Mark size={20} /> Pinout</div>
        </div>
        <button className="ws-newchat" onClick={newChat}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New task
        </button>
        <div className="ws-sec">Tasks</div>
        <div className="ws-list">
          {chats.map((c) => (
            <button key={c.id} className="ws-chat" data-active={c.id === chatId}
                    onClick={() => setChatId(c.id)}>
              <span className="ws-chat-title">{c.title}</span>
              {c.running && <span className="ws-chat-dot" />}
            </button>
          ))}
          {!chats.length && <div className="ws-empty">No tasks yet.</div>}
        </div>
        <div className="ws-side-foot">
          <span>No sign-in</span>
          <span title="This browser holds the only key to this workspace">🔑 local</span>
        </div>
      </aside>

      <div className="ws-main">
        <header className="ws-top">
          <button className="ws-icon-btn" onClick={() => setSideOpen((s) => !s)} aria-label="Toggle sidebar">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" />
            </svg>
          </button>
          <span className="ws-top-title">{title}</span>
          <span className="ws-top-spacer" />
          {wallet?.accountId && (
            <span className="ws-balance-sub" style={{ marginRight: 6 }}>
              {hbar(wallet.tinybar)}
            </span>
          )}
          <button className="ws-icon-btn" data-on={panelOpen} onClick={() => setPanelOpen((p) => !p)}
                  aria-label="Toggle panel">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" />
            </svg>
          </button>
        </header>

        <div className="ws-body">
          {/* the transcript and its composer are one column; the panel sits
              beside them, so the composer tracks the centre and never slides
              under the panel when it opens */}
          <div className="ws-centre">
          <div className="ws-scroll" ref={scrollRef}>
            <div className="ws-col">
              {!blocks.length && !working && (
                <Examples busy={busy} onPick={pickExample} />
              )}

              {blocks.map((b) => {
                if (b.k === "user") {
                  return (
                    <div className="ws-turn ws-in" key={b.id}>
                      {b.files?.length ? (
                        <SentFiles files={b.files} onOpen={(n) => openByName(n)} />
                      ) : null}
                      {b.text && <div className="ws-user">{b.text}</div>}
                    </div>
                  );
                }
                if (b.k === "agent") {
                  return (
                    <div className="ws-turn" key={b.id}>
                      {b.text && <AgentText text={b.text} streaming={b.streaming} />}
                      <ToolLine marks={b.tools} />
                    </div>
                  );
                }
                if (b.k === "ask") {
                  return (
                    <div className="ws-turn" key={b.id}>
                      <FundingAsk ev={b.ev} onDecide={decide} busy={busy} />
                    </div>
                  );
                }
                if (b.k === "decision") {
                  return (
                    <div className="ws-turn ws-in" key={b.id}>
                      <div className="ws-decision" data-v={b.verdict}>
                        <span>
                          You {b.verdict === "approve" ? "approved" :
                               b.verdict === "revise" ? "sent back" : "denied"}
                          {b.amount ? ` ${hbar(b.amount)}` : ""}
                        </span>
                        {b.feedback && <em>{b.feedback}</em>}
                      </div>
                    </div>
                  );
                }
                if (b.k === "artifact") {
                  return (
                    <div className="ws-turn" key={b.id}>
                      <ArtifactCard name={b.name} bytes={b.bytes} kind={b.kind}
                                    onOpen={async () => {
                                      // The chat may not have refreshed yet: an
                                      // artifact appears in the transcript the
                                      // moment it is delivered, and looking it
                                      // up in stale state silently did nothing
                                      // but flip to the file list.
                                      await openByName(b.name);
                                    }} />
                    </div>
                  );
                }
                return (
                  <div className="ws-turn ws-in" key={b.id}>
                    <div className="ws-tools" style={{
                      color: b.tone === "bad" ? "var(--ws-bad)"
                           : b.tone === "warn" ? "var(--ws-warn)" : undefined,
                    }}>{b.text}</div>
                  </div>
                );
              })}

              {working && <div className="ws-turn"><Working what={working.what} since={working.since} /></div>}
            </div>
          </div>

          <div className="ws-composer-wrap">
            <div className="ws-composer">
              <textarea
                ref={boxRef}
                rows={1} value={draft} placeholder="Give the agent a task…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                disabled={running}
              />
              {rejected.length > 0 && (
                <div className="ws-reject" role="alert">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" />
                  </svg>
                  <span>{rejected.join(" ")}</span>
                  <button className="ws-chip-x" onClick={() => setRejected([])}
                          aria-label="Dismiss">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2.4">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
              <PendingFiles files={pending} onRemove={dropFile}
                            onOpen={openPending} />
              <div className="ws-composer-row">
                <button className="ws-icon-btn" onClick={() => fileRef.current?.click()} aria-label="Attach">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <input ref={fileRef} type="file" multiple hidden accept={ACCEPT}
                       onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
                <span className="ws-top-spacer" />
                {running ? (
                  <button className="ws-send ws-stop" onClick={stopRun} aria-label="Stop">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2.5" />
                    </svg>
                  </button>
                ) : (
                  <button className="ws-send" onClick={send}
                          disabled={busy || (!draft.trim() && !pending.length)} aria-label="Send">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <div className="ws-disclaimer">
              The agent spends real HBAR on Hedera testnet. Unused funds are returned.
            </div>
          </div>
          </div>

          {floating && (panelOpen || !sideOpen) && panelOpen && (
            <div className="ws-scrim" onClick={() => setPanelOpen(false)} />
          )}
          {local && (
            <Preview asset={local.asset} url={local.url}
                     onClose={() => setLocal(null)} />
          )}
          {preview && ws && !local && (
            <Preview asset={preview} url={api.fileUrl(ws.id, ws.cap, preview.id)}
                     onClose={() => setPreview(null)} />
          )}
          {panelOpen && !preview && !local && (
            <Panel chat={chat} wallet={wallet} tab={tab} setTab={setTab}
                   urlFor={(aid) => (ws ? api.fileUrl(ws.id, ws.cap, aid) : "#")}
                   onFundDirect={money.fundDirect} onFundSigned={money.fundSigned}
                   onWithdraw={money.withdraw} busy={busy}
                   needs={needs} onOpen={(a) => setPreview(a)}
                   onClose={() => setPanelOpen(false)} />
          )}
        </div>

      </div>
    </>
  );
}
