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
| HIP-991 topic `0.0.9795865` | settlement anchor whose **fee collector is the buyer** — the seller pays its own auditor |
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
