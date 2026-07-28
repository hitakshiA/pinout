# Pinout

**Prepaid metered streaming credits over x402 on Hedera.** One x402 `exact` payment buys a
block of credits; an SSE stream burns them one event at a time; consumption is checkpointed
to Hedera Consensus Service so the buyer can recompute the bill from the free public mirror
node and prove the seller did not over-bill.

Settlement asset is **HBAR** only. Everything below that is marked ✅ has a transaction id
you can open on HashScan.

---

## The gap this fills

Hedera's own x402 documentation lists, under *Constraints & Limitations*:

> "Discrete per-request design (**not streaming** or multi-hop routing)"

x402's core loop is per-request by construction, and streaming breaks it twice: you cannot
sign a transaction per token of an LLM stream (latency and fee overhead defeat the use
case), and you cannot pay up front for a stream whose length nobody knows.

x402 issue [#2273](https://github.com/x402-foundation/x402/issues/2273) —
*"metered-session: prepaid metered sessions with auto-refund for streaming x402 transports"*
— proposes the fix and has sat **open with zero comments since 2026-05-12**. Its first named
use case is "LLM token streams" and its `unit` enum already contains `token`. It also states
plainly: *"Client signs a PaymentPayload for the upfront budget using any existing scheme.
No new scheme."* That matters on Hedera, where the facilitators advertise only `exact`.

Pinout implements that proposal and answers its open questions with measurements.

## Status

| Capability | State | Evidence |
| --- | --- | --- |
| x402 `exact` payment, buyer pays zero network fee | ✅ | `0.0.9185802@1785181172.680425137` |
| Both facilitators (x402.org, blocky402) | ✅ | one settlement each, identical fees |
| Real HTTP 402 → `PAYMENT-SIGNATURE` → 200 over the wire | ✅ | `scripts/e2e.mjs` |
| SSE stream burning one credit per event | ✅ | 2,600 events, one session |
| Burn checkpoints to HCS | ✅ | 11 checkpoints, topic `0.0.9795896` |
| Mid-stream top-up, socket never dropped | ✅ | fired at 399 credits remaining |
| HIP-991 settlement anchor, seller pays buyer | ✅ | topic `0.0.9795865` |
| Refund gated behind the anchor | ✅ | 80,000 tinybar returned |
| Independent verifier, mirror node only | ✅ | `scripts/verify.mjs`, exit 0/1 |
| Verifier catches a cheating seller | ✅ | `--cheat 400` → detected |
| Reproducible cost benchmark | ✅ | `scripts/bench-hcs.mjs` |
| MCP server — paid agent tools | ✅ | `src/mcp.mjs`, driven by a real MCP client |
| Agent spend caps enforced before signing | ✅ | `maxPerCall` / `budget`, typed errors |
| `offer-and-receipt` signed **offers** (JWS/ES256K) | ✅ | live in every 402, `src/receipt.mjs` |
| `offer-and-receipt` signed **receipts** on close | ✅ | binds payment → burn ledger seq → anchor |
| Session persistence across restart | ✅ | append-only `sessions.jsonl` |
| `bazaar` discovery extension | ⚠️ emitted in 402, nothing indexes it | — |
| Hedera Agent Kit v4 plugin | ❌ not built | MCP server covers the same surface |
| USDC / HTS settlement | ❌ out of scope | HBAR only, by choice |

## Run it

```bash
npm install
cp .env.example .env          # fill in accounts, or use real env vars
node scripts/e2e.mjs          # full flow, prints HashScan links
node scripts/verify.mjs <sessionId>
node scripts/e2e.mjs --cheat 400   # dishonest seller
node scripts/verify.mjs <sessionId>   # exits 1
```

## How it works

**Session mint.** `POST /session` returns **402** with a `PAYMENT-REQUIRED` header carrying
base64 JSON: `scheme: "exact"`, `network: "hedera:testnet"`, `amount`, `asset: "0.0.0"`,
`payTo`, `maxTimeoutSeconds`, and `extra.feePayer`. The client builds a bare
`TransferTransaction`, sets `transactionId.accountId` to `extra.feePayer`, signs with its
ECDSA key, and retries with `PAYMENT-SIGNATURE`. The server calls the facilitator's
`/verify` then `/settle`, and **only after settlement succeeds** mints credits. Minting on
the 402 response instead would mean a failed settle leaves the buyer streaming free.

`extra.feePayer` is resolved from `GET /supported` at boot and never hardcoded — the two
live facilitators use different accounts (`0.0.9185802` vs `0.0.7162784`).

**Consumption.** SSE. Each delivered event decrements the balance. `SessionUpdate` frames
carry `unitsConsumed` and `remainingBalance`, per #2273.

**Burn ledger (tier 1).** Every N events a checkpoint goes to a plain HCS topic: session id,
payer, the funding transaction ids, unit price, pricing version, the half-open event range,
cumulative burn, remaining balance, and a SHA-256 commitment over the event ids the client
actually received. HCS assigns a `sequence_number` and a consensus-computed `running_hash`,
so the chain is built by the network, not by the party being audited.

**Top-up.** When the balance crosses the threshold the client runs another 402 cycle *while
the stream is open* and splices the credits in. Mints are idempotent on the settlement
transaction id, so a retry cannot double-credit.

**Settlement anchor (tier 2).** On close the seller writes one message to a **HIP-991
fee-charging topic**, paying a fee **to the buyer**. It declares total consumed, amount owed,
refund due, and the burn ledger's final `sequence_number` + `running_hash` — binding tier 1
to tier 2, so burn history cannot be restated without invalidating the anchor.

**This anchor is a precondition, not a receipt.** `settleSession()` refuses to issue the
refund until it lands. The seller cannot close a session and keep the unused balance without
paying to publish its final numbers.

**Verification.** The buyer replays both topics from `testnet.mirrornode.hedera.com` — free,
public, unauthenticated — and checks contiguity, the tier binding, the anchor's arithmetic,
the claimed burn count against events actually received, and every per-checkpoint commitment.

## What the measurements changed

The original design checkpointed to a HIP-991 topic on every interval. Measurement killed
that. See [FINDINGS.md](./FINDINGS.md):

> Attaching any custom fee to an HCS topic costs the submitter a flat **0.7267 HBAR ≈ $0.050**
> per message — **62× a plain-topic submit** — independent of payload size *and* of the fee
> amount. A plain topic scales per-byte and matches HIP-991's own quoted $0.0008.

So the meter is two-tier: cheap plain-HCS checkpoints at high frequency, one HIP-991 anchor
at the point where its cost is amortized and its incentive actually bites. This is also the
measured answer to open question #1 of #2273 — *"synchronous on-chain refund on close vs.
signed receipt + batched settlement?"* — namely **batched settlement**, and why.

Both tiers are HCS. **There is no smart contract anywhere in this system.**

## What is claimed, and what is not

Pinout claims a **tamper-evident, independently recomputable consumption ledger**. It does
not claim trustless delivery proof.

The distinction is demonstrated, not asserted. Under `--cheat 400` the verifier's first three
checks — contiguity, tier binding, settlement arithmetic — all still **pass**. The ledger is
internally consistent and immutable; that is what HCS guarantees. What catches the seller is
comparing the ledger against the client's own record of received event ids. A seller who
fabricates events *and* the client never notices is outside what this proves.

## Prior art, honestly

- [`@vybenetwork/x402-client`](https://github.com/vybenetwork/x402-client) — the product
  shape (prepaid WS credits, auto-topup, spend caps) is re-derived from Vybe's commercial
  SDK. Not a fork; different chain, different trust model. Their headline feature —
  "the wallet only needs USDC, no SOL for gas" — required custom relayer infrastructure.
  On Hedera it is one `extra.feePayer` field.
- [`Risingtell/meter402`](https://github.com/Risingtell/meter402) — per-tick streaming
  settlement for x402, chain-agnostic (Casper, Base, Arc). Settles one payment *per tick*,
  which is what #2273 says defeats WS use cases. Its verifier checks the token Transfer
  ledger — payments, not consumption.
- [`tomrowbo/hak-mppx-hedera-plugin`](https://github.com/tomrowbo/hak-mppx-hedera-plugin) —
  session payments on Hedera via MPP, using an **on-chain Solidity escrow contract** and
  EIP-712 vouchers. The closest neighbour; the no-contract property is the distinction.
- `qcornell/hedera-payment-sessions` — allowance-based spending budgets (HIP-336). A budget
  caps what *may* be spent; a meter counts what *was* consumed. Different primitive.

## Known limitations

- Sessions are in-memory; a server restart loses them. The ledger survives, the session does not.
- Facilitator equivalence is established from **one trial each**, not under concurrency.
- The `bazaar` extension is emitted in the 402 body but nothing indexes it yet.
- ECDSA (secp256k1) keys only. ED25519 fails *silently* in EVM-adjacent tooling — viem
  accepts any 32-byte hex and derives the wrong identity.
- Accounts auto-created via EVM alias are **hollow** (`key: null`) until they sign something,
  which breaks the facilitator's `AccountInfoQuery` signature check. Use
  `scripts/hydrate-key.mjs`, or create accounts with `AccountCreateTransaction`.
