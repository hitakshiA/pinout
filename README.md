<div align="center">

# Pinout Compute

**Rent a real machine by the second. Pay over [x402](https://x402.org) on [Hedera](https://hedera.com). Get refunded for every second you don't use.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![x402](https://img.shields.io/badge/x402-v2%20%C2%B7%20exact-6366f1)](https://docs.x402.org)
[![Hedera](https://img.shields.io/badge/Hedera-testnet-8259ef)](https://hashscan.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)

CPU and GPU machines, billed per second held. One payment buys seconds. Running out
pauses the machine instead of killing it, so a top up resumes the same process where it
stopped. Unused seconds are refunded on chain, and **anyone can recompute the bill from
the public ledger**.

</div>

```js
const m = await client.rent("gpu-t4");            // pays over x402, machine comes up
await m.upload("/work/train.csv", data);
await m.exec("import torch; ...");                 // state persists between calls
const model = await m.download("/work/model.pt");  // sha256 checked in transit
await m.release();                                 // unused seconds refunded on chain
```

---

## Table of contents

- [What you can rent](#what-you-can-rent)
- [Two shapes of work](#two-shapes-of-work)
- [Running out mid job](#running-out-mid-job)
- [Why this needs a new payment primitive](#why-this-needs-a-new-payment-primitive)
- [How the meter works](#how-the-meter-works)
- [The two tier ledger](#the-two-tier-ledger)
- [Verification](#verification)
- [Guards](#guards)
- [Quickstart](#quickstart)
- [API](#api)
- [For AI agents](#for-ai-agents)
- [Token streams, the other workload](#token-streams-the-other-workload)
- [Why Hedera](#why-hedera)
- [Configuration](#configuration)
- [Status and known limits](#status-and-known-limits)

---

## What you can rent

Real hardware from **Daytona** (CPU) and **Modal** (GPU). One credit is one second held.

| Lane | Hardware | Provider | Price | 120 s session |
|---|---|---|---:|---:|
| `cpu-small` | 1 vCPU, 1 GiB | Daytona | 30,000 tinybar/s | 0.036 ℏ |
| `cpu-4` | 4 vCPU, 8 GiB | Daytona | 147,000 tinybar/s | 0.176 ℏ |
| `gpu-t4` | Tesla T4, 16 GiB | Modal | 411,000 tinybar/s | 0.493 ℏ |
| `gpu-a100-80` | A100 80 GB | Modal | 1,533,000 tinybar/s | 1.840 ℏ |

Each lane's price is committed **inside the 402 the buyer signs**, and the lane is read
from the *session*, never from the request, so a caller cannot pay `cpu-small` prices and
ask for a GPU.

Measured on real machines: 4.15 TFLOP/s fp32 on the T4, 123.8 TFLOP/s tf32 on the A100,
4 million rows through pandas on `cpu-4` with parquet written to disk and read back.
Full numbers in [docs/measurements.md](./docs/measurements.md).

---

## Two shapes of work

```mermaid
flowchart TB
    subgraph ONE["One-shot, cheapest for a known script"]
        direction TB
        O1["POST /compute/&lt;lane&gt;"] --> O2["stream?code=…"]
        O2 --> O3["released the moment<br/>the job exits"]
    end
    subgraph RENT["Rental, hold=1"]
        direction TB
        R1["POST /compute/&lt;lane&gt;"] --> R2["stream?hold=1<br/><i>the rental clock</i>"]
        R2 --> R3["exec · upload · download · ls<br/><i>filesystem persists between steps</i>"]
        R3 --> R3
        R3 --> R4["release → refund"]
    end

    style RENT stroke-dasharray: 4
```

**One-shot** suits a single known script. Submit it, it runs, the machine is handed back
the moment it exits, and you are billed only for the seconds it actually ran.

**Rental** holds an idle machine so you can work on it. Run code, look at the result,
decide what to do next, put files on it, take artifacts off it. The filesystem persists
between steps. This is what makes the service usable by an agent, which works by looking
at what happened and choosing the next step.

Verified on both providers: upload 14,580 B, exec reads it and writes state, a *separate*
exec reads that state back, download a 1 MB artifact with its sha256 checked in transit,
exit codes propagated, money balancing exactly.

---

## Running out mid job

Credits hitting zero does **not** kill the machine. It pauses: the machine is held, the
meter stops, and `SessionWaiting` frames report the grace window draining. Top up and the
*same process* resumes from exactly where it stopped.

```mermaid
stateDiagram-v2
    [*] --> OPENING
    OPENING --> ACTIVE: payment settles
    ACTIVE --> PAUSED: credits exhausted<br/>(machine HELD, meter stopped)
    PAUSED --> ACTIVE: top-up, same machine, same process
    PAUSED --> SETTLING: grace expires, machine released
    ACTIVE --> SETTLING: close or max duration
    SETTLING --> CLOSED: refund, then anchor
    CLOSED --> [*]
```

Measured on the live deployment: a 150 second job on a 120 second session paused at
124 s, was billed **zero** for 10 s of pause, resumed at **step 120, the step it stopped
on, in the same still running process**, and finished. 180 credits bought, 141 billed,
39 refunded, and the on chain verifier passed all five checks.

---

## Why this needs a new payment primitive

x402 pays for **one thing, once**. That breaks the moment consumption is continuous. You
cannot sign a payment per second of compute, and you cannot pay upfront because neither
party knows how long the work will run.

This isn't a hypothesis. Hedera's own x402 documentation says so, under
[**Requirements and limitations**](https://docs.hedera.com/solutions/ai/x402):

> Settlement is per-request and discrete. x402 is **not built for streaming payments**
> or multi-hop routing across ledgers.
>
> [Hedera docs, x402](https://docs.hedera.com/solutions/ai/x402)

[x402 issue #2273](https://github.com/x402-foundation/x402/issues/2273) proposes the fix,
`metered-session`, prepaid sessions with auto refund, and has sat **open with zero
comments** since May 2026. Its `unit` enum already contains `second`, and `metered
compute` is named in its use cases.

Pinout implements that proposal, and answers its open questions with measurements.

---

## How the meter works

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Pinout server
    participant F as x402 facilitator
    participant H as Hedera

    C->>S: POST /compute/gpu-t4
    S-->>C: 402 + PAYMENT-REQUIRED<br/>(signed offer, price, feePayer)
    C->>C: sign bare TransferTransaction
    C->>S: retry + PAYMENT-SIGNATURE
    S->>F: verify
    F-->>S: valid
    S-->>C: 200 · seconds + session secret
    S->>F: settle (after handler succeeds)
    F->>H: submit, facilitator pays ALL gas
    Note over C,H: buyer's balance moves by exactly the price

    loop every second held
        S-->>C: SSE tick · 1 second burned
    end
    S->>H: burn checkpoint → plain HCS topic
    Note over C,S: seconds low → top-up 402 cycle<br/>the machine never stops

    C->>S: POST /close
    S->>H: refund unused seconds
    S->>H: HIP-991 settlement anchor<br/>(costs the seller ~0.73 ℏ)
    S-->>C: signed receipt (JWS/ES256K)
```

**Credit is derived from the settled on chain transfer, never from a price table.**
A session can only ever be credited with the amount that actually moved to the seller in
the transaction the buyer signed. This is structural. Three separate money bugs in this
codebase were the same shape, a flat priced 402 plus a credit read from a lane table plus
an on chain refund of the difference, and deriving credit from the transfer makes that
class impossible rather than fixing it three times.

The refund is **not** gated behind the anchor. Gating it meant an anchor failure stranded
a buyer's balance. The anchor is queued and swept instead, and the verifier reports
`PENDING_ANCHOR` (exit 3) rather than accusing an honest seller during the window before
it lands.

---

## The two tier ledger

The original design checkpointed everything to a HIP-991 fee charging topic. Measurement
killed it:

| Payload | Plain HCS topic | HIP-991 topic |
|--------:|----------------:|--------------:|
|   100 B |       $0.00017  |    **$0.0500** |
| 1,000 B |       $0.00078  |    **$0.0500** |
| 4,000 B |       $0.00080  |    **$0.0500** |

A fee charging topic costs a **flat ~$0.050 per message, 62x a plain topic, independent
of payload size *and* of the fee amount.** So the meter is split:

```mermaid
flowchart LR
    subgraph T1["Tier 1 · burn ledger"]
        A["plain HCS topic<br/>~$0.0008/write<br/>every N seconds"]
    end
    subgraph T2["Tier 2 · settlement anchor"]
        B["HIP-991 topic<br/>~$0.050/write<br/>batched, rare"]
    end
    E[seconds held] --> A
    A -->|"final seq + consensus running_hash"| B
    B -->|"~0.73 ℏ network fee"| NET["Hedera network<br/>(irrecoverable)"]

    style T1 stroke-dasharray: 4
    style NET fill:#1a7f37,color:#fff
```

Tier 2 embeds tier 1's final `sequence_number` and consensus `running_hash`, so burn
history cannot be restated without invalidating the anchor that committed to it.

**Both tiers are HCS. There is no smart contract anywhere in this system.**

Anchors are **batched by default**, one anchor covering many sessions. Per session
anchoring costs ~0.73 HBAR against a session priced in thousandths of that, which turns
abandonment into a drain. `?settlement=priority` buys a dedicated anchor, but only when
the session's own revenue covers its cost. Otherwise it falls back to batched, because
unconditional priority is a free way to make a stranger spend 0.73 HBAR per call.

---

## Verification

The verifier trusts **only** the free public mirror node and the buyer's own record of
seconds received. No API key, nothing to trust.

```bash
npm run verify -- <sessionId>
```

```mermaid
flowchart TD
    V[verifier] --> M[(public mirror node)]
    M --> C1{1 · checkpoints contiguous?}
    C1 --> C2{2 · anchor binds ledger head?}
    C2 --> C3{3 · settlement arithmetic?}
    C3 --> C4{4 · burn count = seconds received?}
    C4 --> C5{5 · commitments match?}
    C5 --> P["exit 0 · PASSED"]
    C4 -->|no| F["exit 1 · FAILED<br/>names the exact overcharge"]
    C5 -->|no| F
    C4 -.->|no client record| I["exit 2 · INCONCLUSIVE"]
    C2 -.->|anchor not landed yet| W["exit 3 · PENDING_ANCHOR"]

    style P fill:#1a7f37,color:#fff
    style F fill:#b62324,color:#fff
    style I fill:#9a6700,color:#fff
    style W fill:#0969da,color:#fff
```

One implementation, shared by the CLI, the MCP tool and the Agent Kit plugin. The
artifact whose entire job is to be trustworthy should not exist twice and disagree with
itself.

### Watch it catch a cheating seller

```bash
npm run e2e -- --cheat 400        # seller inflates the ledger
npm run verify -- <sessionId>     # exits 1
```

```
1. contiguity              PASS
2. tier binding            PASS
3. settlement arithmetic   PASS
4. ledger vs received      FAIL  claims 3000, client received 2600
                                 (+400 phantom = 80000 tinybar overcharge)
5. checkpoint commitments  FAIL  11/11 do not match
```

### Trust boundary

Pinout claims a **tamper evident, independently recomputable consumption ledger**. It does
**not** claim trustless delivery proof.

Under `--cheat`, checks 1 to 3 still pass. The ledger genuinely is immutable and
internally consistent, which is what HCS guarantees and all it guarantees. Only comparing
it against the buyer's own record exposes fabrication. A seller that fabricates events
*and* whose client never notices is outside what this proves.

`INCONCLUSIVE` exists for exactly that reason. Without a client record, the verifier
refuses to say "passed".

---

## Guards

Testnet HBAR is free from a faucet, so **the payment gate provides no economic friction on
testnet**. Payment alone cannot be what stands between a stranger and a real GPU bill.
Admission is decided *before* the 402 is issued, on the principle that you never quote a
price for work you will not do:

- concurrency caps, sessions and GPU sessions counted separately
- per lane wall clock ceilings
- provider budget ceilings, charged in seconds **held** rather than seconds billed, with a
  GPU reserve held back
- **seller solvency**, refusing new sessions when the seller could not afford a settlement
  anchor for every open session, rather than risk stranding a prepaid balance
- an orphan reaper across **both** providers

---

## Quickstart

```bash
git clone https://github.com/hitakshiA/pinout.git
cd pinout && npm install
cp .env.example .env        # fill in accounts, or use real env vars
npm run check-config
```

You need two funded Hedera **testnet** accounts with **ECDSA (secp256k1)** keys. Get one
from [portal.hedera.com](https://portal.hedera.com), then:

```bash
node scripts/new-role-account.mjs SELLER 60   # creates and funds the seller
```

Run the full flow. Every on chain step prints a HashScan link:

```bash
npm run compute-e2e             # rent a real machine, run code, get refunded
npm run e2e                     # metered token stream, end to end
npm run verify -- <sessionId>   # recompute the bill from the mirror node
```

---

## API

### Buying

| Method | Route | Paid | Purpose |
|---|---|:--:|---|
| `POST` | `/compute/<lane>` | ✅ | Buy seconds on a compute lane. Price committed in the 402 |
| `POST` | `/topup/<lane>/<id>` | ✅ | Add seconds to a compute session |
| `POST` | `/session` | ✅ | Open a token billed session |
| `POST` | `/session/<id>/topup` | ✅ | Add credits to a token session |

### Using

| Method | Route | Auth | Purpose |
|---|---|:--:|---|
| `GET` | `/session/<id>/stream` | 🔑 | SSE meter. `?provider=compute`, `?hold=1` to rent, `?n=` seconds cap |
| `POST` | `/session/<id>/exec` | 🔑 | Run code on a machine you are holding |
| `POST` | `/session/<id>/files` | 🔑 | Put a file on the machine |
| `GET` | `/session/<id>/files?path=` | 🔑 | Take a file off, with sha256 |
| `GET` | `/session/<id>/files?dir=` | 🔑 | List a directory |
| `POST` | `/session/<id>/code` | 🔑 | Stage code larger than a query string |
| `POST` | `/session/<id>/close` | 🔑 | Refund, then anchor, then signed receipt |
| `GET` | `/session/<id>` | 🔑 | Session status |

🔑 = `Authorization: Bearer <sessionSecret>`, issued once at mint.

`exec` and the file routes are **not separately priced**. They act on a machine already
billed by the second, and they refuse with `402` at zero credits, because a paused session
would otherwise be free compute.

### Discovery

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/` | Service descriptor, live pricing, topic links |
| `GET` | `/lanes` | Lanes, prices, and how to buy each |
| `GET` | `/health` | Liveness, capacity, provider budget remaining |
| `GET` | `/bazaar`, `/.well-known/x402` | x402 catalog for agents |

---

## For AI agents

Every agent surface is gated on confirmed on chain payment. **No tool returns data before
its payment settles.**

### Tools

`rent_machine` · `exec` · `upload_file` · `download_file` · `list_files` ·
`release_machine` · `run_compute` · `open_session` · `top_up` · `stream` ·
`close_session` · `verify_session` · `spend_report` · `discover`

Spend guards (`maxPerCallTinybar`, `budgetTinybar`) reject a challenge **before any
signature exists**, so a mispriced or injected 402 can never put funds at risk.

### MCP server

```bash
npm run mcp
```

### Hedera Agent Kit v4 plugin

```js
import { ToolDiscovery } from "@hashgraph/hedera-agent-kit";
import { pinoutPlugin } from "pinout/agent-kit";

const tools = new ToolDiscovery([pinoutPlugin]).getAllTools(context);
```

Tools extend `BaseTool`, so they participate in v4's **hooks and policies**. Spend limits,
HCS audit hooks and human in the loop confirmation apply automatically, which is exactly
what you want on a payments plugin.

> [!TIP]
> In Agent Kit, a tool's `method` is its **unique registry key**, not an HTTP verb.
> Setting it to `"post"` or `"get"` collides with core tools and the kit silently drops
> yours with `Plugin tool "post" conflicts with core tool`.

### Conversational agent

```bash
node agent/chat.mjs                       # interactive
node agent/chat.mjs -p "rent a GPU and…"  # headless
```

> Given only a URL and a private key, and forbidden from reading this source, an
> independent agent worked out the protocol from the HTTP responses alone and paid. Its
> balance moved by exactly the purchase amount and not one tinybar more. A second agent,
> given no hints, rented a machine, uploaded a dataset, aggregated it, read that result
> back **in a separate step**, downloaded the verdict and released. 86 seconds billed,
> 34 refunded, summing exactly to the 120 bought.

---

## Token streams, the other workload

The same meter runs token billed sessions, which is where the design started. One payment
buys credits, an SSE stream burns one per event, the client tops up mid stream without
dropping the connection, and unused credits are refunded on chain. Compute reuses this
pipeline unchanged, with one tick per second instead of one per token.

```bash
npm run e2e
```

---

## Why Hedera

| Property | What it buys |
|---|---|
| **Fee payer model** | The facilitator pays all network fees. The buyer needs **no fee headroom**, so it can hold exactly the purchase amount and transact. |
| **HIP-991 topic fees** | A log that **costs money to write**, ~0.7345 HBAR per settlement anchor in irrecoverable network fees, so publishing your final numbers is expensive and over reporting is expensive. No EVM chain charges for a log write without deploying a contract. The topic's custom fee goes to a collector fixed at topic creation, **not** to the paying buyer. |
| **HCS `running_hash`** | The audit chain is computed by consensus nodes, not by the party being audited. |
| **Free mirror node** | Public, unauthenticated, no signup, so verification costs the buyer nothing. |

Full measured numbers, methodology, and the bugs found along the way:
**[docs/measurements.md](./docs/measurements.md)**

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` | | Buyer and payer. On this deployment it is *also* the fixed HIP-991 fee collector, a test artifact rather than a design property. A third party buyer never receives that fee. |
| `SELLER_ACCOUNT_ID`, `SELLER_PRIVATE_KEY` | | Seller. Owns both topics |
| `BURN_TOPIC_ID` | | Tier 1, plain HCS |
| `TOPIC_ID` | | Tier 2, HIP-991 |
| `DAYTONA_API_KEY`, `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | | Compute providers |
| `ALLOW_GPU` | `false` | GPU lanes are off unless explicitly enabled |
| `MAX_CONCURRENT_SESSIONS`, `MAX_CONCURRENT_GPU` | `8`, `1` | Capacity caps |
| `MAX_SECONDS_CPU`, `MAX_SECONDS_GPU` | `900`, `300` | Wall clock ceiling per session |
| `EXHAUSTION_GRACE_MS` | `90000` | How long a machine is held, unbilled, awaiting top up |
| `MAX_CODE_BYTES`, `MAX_FILE_BYTES` | 64 KiB, 32 MiB | Upload limits |
| `PRICE_PER_EVENT_TINYBAR` | `200` | Unit price for token lanes |
| `CHECKPOINT_EVERY` | `250` | Units per burn checkpoint |
| `MAX_SESSION_DURATION_MS` | `600000` | Idle timeout before auto settle |
| `FACILITATOR` | `x402` | `x402` or `blocky402` |

`process.env` overrides `.env`, and `.env` is optional.

> [!WARNING]
> **ECDSA (secp256k1) keys only.** An ED25519 key fails *silently* in EVM adjacent
> tooling. `viem` accepts any 32 byte hex and derives the wrong identity, surfacing as a
> confusing "signature mismatch".

> [!NOTE]
> Accounts auto created via EVM alias are **hollow** (`key: null`) until they sign
> something, which breaks the facilitator's `AccountInfoQuery` check. Use
> `scripts/hydrate-key.mjs`, or create accounts with `AccountCreateTransaction`.

---

## Built on

[`@x402/core`](https://www.npmjs.com/package/@x402/core) ·
[`@x402/hedera`](https://www.npmjs.com/package/@x402/hedera) (exact client **and** server) ·
[`@x402/hono`](https://www.npmjs.com/package/@x402/hono) ·
[`@hiero-ledger/sdk`](https://www.npmjs.com/package/@hiero-ledger/sdk) ·
[`@hashgraph/hedera-agent-kit`](https://www.npmjs.com/package/@hashgraph/hedera-agent-kit) ·
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) ·
[Daytona](https://daytona.io) · [Modal](https://modal.com)

Implements the x402 [`metered-session`](https://github.com/x402-foundation/x402/issues/2273),
[`offer-and-receipt`](https://github.com/x402-foundation/x402/blob/main/specs/extensions/extension-offer-and-receipt.md)
(JWS/ES256K profile) and [`bazaar`](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md) extensions.

---

## Status and known limits

Working end to end on Hedera testnet, deployed on Azure, exercised against real Daytona
and Modal machines. Stated plainly:

- **Testnet only.**
- **Unit economics do not close at demo scale.** A settlement anchor costs ~0.73 HBAR
  while a `cpu-small` session sells for 0.036 HBAR. Batching amortises it, with break even
  around 2,450 billed seconds per anchor, but the seller subsidises small and abandoned
  sessions today. The numbers are in [`compute/PLAN.md` §10](./compute/PLAN.md), not
  hidden.
- **Cold start is absorbed by the seller.** The buyer's meter starts after provisioning. A
  first pull of a 3 GB GPU image measured 101,176 ms. Once Modal has it cached, 187 ms.
  Pre warm before opening a GPU lane publicly.
- **You pay for thinking time when renting.** An agent deliberating between steps is
  billed for those seconds. `run_compute` is cheaper for a single known script.
- **Sandbox egress is filtered.** pypi and huggingface are reachable, CloudFront is reset.
  `os.cpu_count()` reports the host's cores, not the lane's quota.
- **The `gpu-a100-80` cost basis is derived, not measured.** Modal's billing API is Team
  tier only, so it is arithmetic on published rates and is marked `_costVerified: false`.
- Sessions are single node and held in memory, persisted to an append only log. A crash
  loses at most `CHECKPOINT_EVERY` units, and **the loss falls on the seller**.
- Facilitator equivalence rests on one trial each, not a load test.

## License

[MIT](./LICENSE) © Hitakshi Arora
