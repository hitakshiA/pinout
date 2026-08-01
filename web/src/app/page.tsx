"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import LiveLedger from "@/components/LiveLedger";
import RentFlow from "@/components/RentFlow";
import Footer from "@/components/Footer";
import Mark from "@/components/Mark";

const AGENTS = [
  { name: "OpenAI Codex", src: "/agents/openai.png", invert: true },
  { name: "Claude Code",  src: "/agents/claude.svg" },
  { name: "OpenClaw",     src: "/agents/openclaw.svg" },
  { name: "Hermes",       src: "/agents/hermes.png" },
  { name: "Gemini CLI",   src: "/agents/gemini.png" },
  { name: "Grok",         src: "/agents/grok.png" },
  { name: "Antigravity",  src: "/agents/antigravity.png" },
  { name: "OpenCode",     src: "/agents/opencode.png" },
];

const GROUPS = [
  { label: ">80GB VRAM", rows: [
    { lane: "gpu-b300", name: "B300 SXM6", vram: "287 GB", ram: "192 GiB", cpu: "16", tb: "6,209,000", hr: "223.52" },
    { lane: "gpu-b200", name: "B200",      vram: "191 GB", ram: "128 GiB", cpu: "16", tb: "5,149,000", hr: "185.36" },
    { lane: "gpu-h200", name: "H200",      vram: "150 GB", ram: "96 GiB",  cpu: "12", tb: "3,796,000", hr: "136.66" },
    { lane: "gpu-a100-80", name: "A100 SXM4", vram: "85 GB", ram: "64 GiB", cpu: "8", tb: "2,296,000", hr: "82.66" },
  ]},
  { label: "24 - 48GB VRAM", rows: [
    { lane: "gpu-l40s", name: "L40S", vram: "48 GB", ram: "32 GiB", cpu: "8", tb: "1,712,000", hr: "61.63" },
    { lane: "gpu-a10",  name: "A10",  vram: "24 GB", ram: "16 GiB", cpu: "4", tb: "912,000",   hr: "32.83" },
    { lane: "gpu-l4",   name: "L4",   vram: "24 GB", ram: "16 GiB", cpu: "4", tb: "778,000",   hr: "28.01" },
    { lane: "gpu-t4",   name: "T4",   vram: "16 GB", ram: "8 GiB",  cpu: "2", tb: "474,000",   hr: "17.06" },
  ]},
  { label: "CPU ONLY", rows: [
    { lane: "cpu-4", name: "cpu-4", vram: "", ram: "8 GiB", cpu: "4", tb: "147,000", hr: "5.29" },
    { lane: "cpu-2", name: "cpu-2", vram: "", ram: "4 GiB", cpu: "2", tb: "74,000",  hr: "2.66" },
    { lane: "cpu-1", name: "cpu-1", vram: "", ram: "1 GiB", cpu: "1", tb: "30,000",  hr: "1.08" },
  ]},
];

/**
 * What gets put on the clipboard when someone picks their agent.
 *
 * It is deliberately not a copy of llms.txt — that file is the reference, this
 * is the instruction. It tells the agent where to read, what to build, and the
 * two things that go wrong when an agent is handed a wallet: asking the human
 * for a private key, and leaving a machine running.
 */
const promptFor = (agent: string) => `Read https://pinout.club/llms.txt first, then \
https://pinout.club/llms-full.txt. They describe Pinout Compute: CPU and GPU machines \
rented by the second, paid over x402 on Hedera testnet, with unused seconds refunded on \
chain. There is no account and no API key — the payment is the authentication.

I want you to set yourself up to rent compute on my behalf, and then use it for the work I \
give you.

Set-up, in this order:

1. Read both files above before writing anything. Read the live lane list at \
https://compute.pinout.club/lanes so you are using real prices, not remembered ones.
2. Create your own Hedera **testnet** account with an **ECDSA (secp256k1)** key — ED25519 \
will not sign x402 here. Generate it with a script; do not ask me for a key and do not \
paste one into this chat.
3. Write the credentials to \`.env\` as HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY, and make \
sure \`.env\` is gitignored. Never print the private key — not in chat, not in a log, not \
in a commit, not in a comment. If you ever need to show me something, show the account id.
4. Tell me your account id and ask me to fund it from the Hedera testnet faucet at \
https://portal.hedera.com/faucet. 20–50 testnet HBAR is plenty. Wait until you can see the \
balance before spending.
5. Set a per-call cap and a total budget in your client, and enforce both *before* signing \
any 402. Tell me what you set them to.

Then, whenever I give you a job that needs compute:

- Pick the lane from the live list by what the job actually needs — VRAM first, then price. \
A gpu-b300 costs 207x a cpu-1 per second. Most jobs that are not model training want a \
cpu-* lane or a gpu-t4.
- Estimate seconds × tinybar/s before you rent, and tell me the estimate.
- Prefer the one-shot form when the job is a single known script; renting and then thinking \
bills you for the thinking.
- One purchase buys about 120 seconds. A longer job is a normal sequence of top-ups on the \
same session, not a bigger first payment.
- Download the artifacts BEFORE you release. The filesystem is destroyed on release.
- ALWAYS release the machine when you are done. The meter runs until you do. This is the \
single most expensive mistake.
- If a top-up would take you past the budget, stop and ask me rather than spending through it.
- When you deliver a video, encode H.264 — cv2.VideoWriter's default mp4v fourcc produces a \
file no browser will play.

Afterwards, show me what it cost and how to check it: the session id, the total spent, the \
refund, and the HashScan link. The bill is recomputable from Hedera's public mirror node, \
so I should never have to take your word for it.

Start by reading the two files, then tell me your plan and what you are about to spend.`;

export default function Page() {
  const [copied, setCopied] = useState<string | null>(null);
  const [showAnn, setShowAnn] = useState(true);
  const [unit, setUnit] = useState<"sec" | "hr">("sec");

  async function copyPrompt(agent: string) {
    const text = promptFor(agent);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard is blocked outside a secure context and in some embedded
      // browsers; a hidden textarea still works there
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(agent);
    window.setTimeout(() => setCopied((c) => (c === agent ? null : c)), 4200);
  }

  return (
    <>
      {showAnn && (
        <div className="ann">
          <span>Pinout Compute is live on Hedera testnet. <a href="#lanes">See the machines and prices</a></span>
          <button className="ann-x" onClick={() => setShowAnn(false)} aria-label="Dismiss">&#10005;</button>
        </div>
      )}

      <nav className="nav">
        <div className="wrap navin">
          <div className="brand"><Mark size={24} /> Pinout</div>
          <div className="navlinks">
            <a href="#how">How it works</a>
            <a href="#lanes">Machines</a>
            <a href="#hedera">Hedera</a>
            <a href="#verify">Verify</a>
            
          </div>
        </div>
      </nav>

      <div className="hero">
        <img className="starfield" src="/art/starfield.svg" alt="" aria-hidden="true" />
        <div className="wrap">
          <h1>Compute your agent <em>buys for itself.</em></h1>
          <p className="sub">
            Your agent picks the machine, signs one x402 payment, holds it for as long as the job
            needs, and hands back what it did not use. Settled on Hedera, so the bill it pays is one
            anybody can recheck.
          </p>
          <div className="install">
            <span className="install-lab">Install on your agent</span>
            <div className="install-row">
              {AGENTS.map((a, i) => (
                <button type="button" className="ag" key={a.name}
                        style={{ animationDelay: `${i * 70}ms` }}
                        onClick={() => copyPrompt(a.name)}
                        title={`Copy the set-up prompt for ${a.name}`}
                        aria-label={`Copy the Pinout set-up prompt for ${a.name}`}>
                  <img src={a.src} alt="" className={a.invert ? "ag-inv" : undefined} />
                  <span className="ag-name" aria-hidden="true">{a.name}</span>
                </button>
              ))}
            </div>
            <div className="ag-copied" role="status" aria-live="polite">
              {copied
                ? <>Prompt copied — paste it into <b>{copied}</b></>
                : <span className="ag-hint">Pick your agent to copy a set-up prompt</span>}
            </div>
            <span className="or"><i /><span>or</span><i /></span>
            <a className="btn btn-p btn-xl btn-try" href="/app">Try Now (Hosted Agent)</a>
          </div>
        </div>

        <div className="wrap">
          <div className="fcards">
            <div className="fcard">
              <div className="fart">
                <img className="glow" src="/art/glow.avif" alt="" aria-hidden="true" />
                <img className="ill" src="/art/bolt.webp" alt="" />
              </div>
              <h2>It pays for 41 seconds</h2>
              <p>Not the hour most hosts bill for them. The meter counts seconds and stops the
                 moment the job does.</p>
            </div>
            <div className="fcard">
              <div className="fart">
                <img className="glow" src="/art/glow.avif" alt="" aria-hidden="true" />
                <img className="ill" src="/art/globe.webp" alt="" />
              </div>
              <h2>Runs dry, keeps the work</h2>
              <p>When credits hit zero the machine is held, not destroyed. The agent tops up and
                 the job continues from where it stopped.</p>
            </div>
            <div className="fcard">
              <div className="fart">
                <img className="glow" src="/art/glow.avif" alt="" aria-hidden="true" />
                <img className="ill" src="/art/billing.webp" alt="" />
              </div>
              <h2>It gets the change</h2>
              <p>Unused seconds return to the wallet the moment a session closes. No expiry,
                 no leftover balance to write off.</p>
            </div>
          </div>
        </div>
      </div>

      <section style={{ paddingTop: 64, paddingBottom: 44 }}>
        <div className="wrap">
          <p className="wallcap">Built on the rails that make this possible.</p>
          <div className="wall">
            <Image src="/brand/hedera.webp" alt="Hedera" width={107} height={30}
                   style={{ height: 30, width: "auto" }} />
            <Image className="logo-x402" src="/brand/x402.svg" alt="x402" width={80} height={31}
                   style={{ height: 24, width: "auto" }} />
            <span className="chip">Hedera Consensus Service</span>
            <span className="chip">HIP-991</span>
            <span className="chip">Mirror node verified</span>
          </div>
        </div>
      </section>

      <section style={{ background: "var(--bg-2)", borderTop: "1px solid var(--line)",
                        borderBottom: "1px solid var(--line)" }}>
        <div className="wrap twocol">
          <h2>Why compute needs its own kind of payment</h2>
          <div>
            <p className="lead" style={{ marginTop: 0 }}>
              x402 settles one request at a price you already know. Compute does not work like
              that. Nobody can say how many seconds a job needs until it has run, which leaves you
              guessing up front or signing thousands of tiny payments as you go.
            </p>
            <p className="lead">
              Pinout sits in the middle. You buy a pool of credits once, a meter draws them down
              while the work happens, and whatever survives is refunded when the session closes.
            </p>
          </div>
        </div>
      </section>

      <section id="how">
        <div className="wrap">
          <div className="eyebrow">One job, start to finish</div>
          <h2>Watch an agent rent a graphics card</h2>
          <p className="lead">
            You hand over a job and a spending limit. It works out what hardware that needs, pays
            for it over x402, and gives you back whatever it did not use. This is a real session
            from the deployed service, replayed.
          </p>
          <RentFlow />
        </div>
      </section>

      <section id="lanes">
        <div className="wrap pricing">
          <div>
            <span className="badge">Machine pricing</span>
            <h2 style={{ marginTop: 22 }}>Machines powerful enough for any task</h2>
            <p className="lead">
              Your agent reads this catalogue and picks what the job needs. Prices are all-in:
              accelerator, vCPU and memory, billed per second held. No minimums, no egress fees,
              no reservation.
            </p>
            <div className="row" style={{ justifyContent: "flex-start", marginTop: 28 }}>
              <a className="btn btn-p" href="#lanes">See the machines</a>
              <a className="btn btn-g" href="https://github.com/hitakshiA/pinout">Read the source</a>
            </div>
          </div>

          <div>
            <div className="toggles">
              <div className="tg">
                <button data-on={unit === "sec"} onClick={() => setUnit("sec")}>Per second</button>
                <button data-on={unit === "hr"} onClick={() => setUnit("hr")}>Per hour</button>
              </div>
            </div>

            {GROUPS.map((grp) => (
              <div key={grp.label}>
                <div className="vramrule"><span>{grp.label}</span></div>
                {grp.rows.map((r) => (
                  <div className="prow" key={r.lane}>
                    <div className="pname">{r.name}</div>
                    <div className="pchips">
                      {r.vram && <span className="pchip">{r.vram} VRAM</span>}
                      <span className="pchip">{r.ram} RAM</span>
                      <span className="pchip">{r.cpu} vCPUs</span>
                    </div>
                    <div className="pprice">
                      {unit === "sec"
                        ? `${r.tb} tinybar/s`
                        : `${'\u210F'}${r.hr}/hr`}
                    </div>
                    <a className="pgo" href="#lanes" aria-label={`Rent ${r.name}`}>&#8594;</a>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <span className="badge">Use cases</span>
          <h2 style={{ marginTop: 22 }}>What agents run here</h2>
          <div className="ucs">
            <div className="uc">
              <img src="/art/uc-inference.avif" alt="" />
              <div><h3>Inference</h3><p>Serve a model for the seconds a request needs, with no idle
                hour attached.</p></div>
            </div>
            <div className="uc">
              <img src="/art/uc-training.avif" alt="" />
              <div><h3>Training</h3><p>Long runs that top up mid job rather than dying when a
                budget lapses.</p></div>
            </div>
            <div className="uc">
              <img src="/art/uc-agents.avif" alt="" />
              <div><h3>Autonomy</h3><p>An agent with a wallet buying its own hardware, inside a
                ceiling you set.</p></div>
            </div>
            <div className="uc">
              <img src="/art/uc-media.avif" alt="" />
              <div><h3>Media</h3><p>Diffusion, matting and vision work, billed for the seconds it
                actually took.</p></div>
            </div>
          </div>
        </div>
      </section>

      <section id="hedera">
        <div className="wrap">
          <div className="eyebrow">Why Hedera</div>
          <h2>Why this runs on Hedera</h2>
          <p className="lead">
            Four platform properties make per-second settlement practical. No other network
            offers all four.
          </p>
          <div className="feats">
            <div className="feat">
              <h3><i />Your agent never holds gas</h3>
              <p>Hedera&apos;s facilitator signs as fee payer and submits on the agent&apos;s behalf.
                The agent&apos;s balance moves by the price and nothing else, so it carries no separate
                gas float to monitor or refill.</p>
            </div>
            <div className="feat">
              <h3><i />The network keeps the ledger</h3>
              <p>Consumption is checkpointed to a Consensus Service topic with a running hash
                maintained by consensus nodes. The party issuing the bill is not the party building
                the audit trail.</p>
            </div>
            <div className="feat">
              <h3><i />Settlement that costs to publish</h3>
              <p>Every settlement is anchored to a HIP-991 fee-charging topic at real,
                unrecoverable cost. Publishing final numbers is expensive by design, which makes
                inflating them expensive too.</p>
            </div>
            <div className="feat">
              <h3><i />Auditable by anyone, free</h3>
              <p>Every record sits on Hedera&apos;s public mirror node. No key, no signup, no
                rate-limit agreement. And no smart contract anywhere in the system, both tiers are
                Consensus Service.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="verify">
        <div className="wrap">
          <div className="eyebrow">Billing</div>
          <h2>See exactly what you paid for</h2>
          <p className="lead">
            Every session is itemised down to the second, with the charge and the refund recorded
            as they happen. Below is live activity, straight from Hedera.
          </p>
          <LiveLedger />
          <p className="lead" style={{ marginTop: 34 }}>
            Reconcile any invoice yourself with the open-source verifier, or hand a session id to
            your finance tooling and let it check the arithmetic.
          </p>
          <pre>
            <span className="cm"># rebuild the bill from public data, not from our word for it</span>{"\n"}
            $ npm run <span className="fn">verify</span> -- 3c145a57-d8d5-4c7e-a974-9f92426e075e{"\n\n"}
            {"  "}<span className="st">PASS</span>{"  contiguity      contiguous [0, 141) across 5 checkpoints\n"}
            {"  "}<span className="st">PASS</span>{"  tier-binding    anchor commits to seq 142 + running hash\n"}
            {"  "}<span className="st">PASS</span>{"  arithmetic      141 x 30000 = 4,230,000 tinybar\n"}
            {"  "}<span className="st">PASS</span>{"  burn-count      ledger count 141 matches events received\n"}
            {"  "}<span className="st">PASS</span>{"  commitments     all 5 checkpoint commitments match\n\n"}
            {"  "}<span className="st">VERIFICATION PASSED</span>{"  bill recomputed from the mirror node"}
          </pre>
        </div>
      </section>

      <section id="faq">
        <div className="wrap">
          <div className="eyebrow">Questions</div>
          <h2>Answers.</h2>
          <div style={{ marginTop: 34 }}>
            <details>
              <summary>What if an agent runs out mid-job?</summary>
              <p>The machine is held and the meter stops, so the wait costs nothing. The agent tops
                up and the job resumes from where it stopped. If no top-up arrives within the grace
                window the machine is released and the balance refunded.</p>
            </details>
            <details>
              <summary>Do I need HBAR for gas as well as for the work?</summary>
              <p>No. On Hedera the facilitator pays the network fee and submits for you, so your
                agent holds exactly what it plans to spend and nothing else.</p>
            </details>
            <details>
              <summary>Is there a contract to audit?</summary>
              <p>None. Metering and settlement both run on Hedera Consensus Service, so there is
                nothing to deploy, upgrade, or audit for reentrancy.</p>
            </details>
            <details>
              <summary>Is this production ready?</summary>
              <p>It runs on Hedera testnet today, against real CPU and GPU hardware. Mainnet is the
                next step. Current limits and economics are documented in the repository.</p>
            </details>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
