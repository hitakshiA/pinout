# Public release readiness

**Live:** `http://20.1.144.110:4021` — Azure `Standard_D2alds_v7`, eastus2, systemd `Restart=always`.

## What a stranger can do right now

```bash
curl http://20.1.144.110:4021/lanes                    # what is sold and what it costs
curl -X POST http://20.1.144.110:4021/compute/cpu-small # 402 with a signed offer
```

Pay the 402 with any funded Hedera **testnet** ECDSA account, rent a real
Daytona sandbox, run arbitrary Python billed per second, and get refunded for
seconds you did not hold. Then recompute the bill yourself from the public
mirror node — the seller is not trusted at any point.

## Guards in front of arbitrary code execution

Testnet HBAR is free from a faucet, so **payment provides no economic friction**.
That is the central operational risk and it is handled explicitly, not implied:

| Guard | Setting |
|---|---|
| GPU lanes | **off by default** (`ALLOW_GPU`) |
| Concurrent sessions | 8 |
| Concurrent GPU | 1 |
| Wall clock per session | 900s CPU / 180s GPU, enforced server-side regardless of credits held |
| Code size | 64 KiB |
| Provider spend ledger | USD, survives restarts, 25% of Modal budget reserved |
| Orphan sandboxes | reaped on boot |
| Admission control | runs **before** the 402, so money is never taken for work that will be refused |

## Hedera primitives, and what each is load-bearing for

| Primitive | Use |
|---|---|
| x402 `exact` scheme | every payment; `feePayer` resolved from `/supported`, never hardcoded |
| Fee-payer model | buyer pays **zero network fees**; needs no fee headroom |
| HCS plain topic `0.0.9795896` | burn ledger, one checkpoint per N units |
| HCS `running_hash` + `sequence_number` | tamper evidence computed by consensus, not by the seller |
| HIP-991 topic `0.0.9795865` | settlement anchor. Writing one costs the seller **~0.7345 HBAR in network fees** — that irrecoverable cost is the incentive against over-reporting. The topic's custom fee goes to a **fixed collector set at topic creation** (here, the operator's treasury), so it is *not* a payment to the buyer. See below. |
| `fee_schedule_key` | present, so fee terms are publicly readable and provably mutable-by-named-key |
| Mirror node | free public verification; the buyer trusts nothing else |
| ECDSA secp256k1 | required; ED25519 fails silently in EVM-adjacent tooling |

**No smart contract anywhere.**

## Known limits, stated plainly

- Testnet only. On mainnet the free-faucet problem disappears and the guards matter less.
- Sessions are single-node, held in memory with an append-only log. A crash loses at most `CHECKPOINT_EVERY` units and **the loss falls on the seller**.
- Modal's billing API is Team-tier only, so the GPU lane is self-instrumented. Daytona's `getMetricsLatest` gives real provider-side corroboration on CPU. That asymmetry is published rather than flattened.
- Facilitator equivalence rests on one trial each, not a load test.
- The service bills only seconds a job actually ran; cold start and teardown are absorbed by the seller.


## Correction: who receives the settlement fee

**What the settlement anchor actually costs and who gets paid.** Writing an
anchor costs the seller **~0.7345 HBAR in irrecoverable network fees** (measured).
That cost is the incentive: publishing your final numbers is expensive, so
over-reporting is expensive. The topic's HIP-991 custom fee (100,000 tinybar) is
paid to a **fixed collector account set at topic creation** — on this deployment
that is the operator's own treasury, so for a third-party buyer it is a
self-payment and carries no auditor semantics. Set `ANCHOR_FEE_COLLECTOR` to an
escrow or counterparty account if you want the fee to actually change hands. The
network fee is the part that bites regardless of who collects.


## Known economic asymmetry: the seller subsidises abandoned sessions

Independent audit named this as the weakest remaining point, and it is real.

A buyer risks nothing. Open a session, burn zero seconds, close: the full
prepayment is refunded, while the **seller** pays the refund transaction gas
(~146,000 tinybar) plus a share of the ~0.7345 HBAR settlement anchor. Testnet
HBAR is free, so an attacker's cost is zero and the seller's is real.

What limits it today:

- **Batched settlement** — one anchor covers every session closed in a sweep
  window, so the per-session anchor share falls as volume rises.
- **Solvency admission** — new sessions are refused with 503 when the operator
  cannot afford an anchor per open session. It protects buyers from stranded
  balances; it does not stop the drain.
- **Concurrency caps** — 8 sessions, 1 GPU.

What would actually remove it, none of which is implemented:

1. A small **non-refundable booking fee** covering amortised anchor + gas.
2. **Mainnet settlement**, where the attacker's HBAR is not free.
3. **Payer allowlisting** for a public testnet deployment.

This is disclosed rather than hidden because it is the difference between "a
buyer cannot steal from us" (true, and verified across four audits) and "we
cannot lose money" (false).
