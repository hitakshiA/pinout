# Pinout Compute

A metered computer an AI agent rents **by the second**, pays for over x402 on Hedera,
and gets change back from, with a bill anyone can recompute from public data.

Two lanes: **CPU** (Daytona) and **GPU** (Modal). The agent picks the lane the job needs.

## Why this is a product, not a demo

The agent submits **arbitrary code**. `run(code, tier)`, so the agent decides what to
execute. That is the difference between a metering layer and a metering demo.

It also fills a documented hole:

- **No mainstream GPU/compute provider accepts x402.** An autonomous agent cannot buy
  compute today without a human first opening an account.
- **Prepaid-but-unused time is rarely refunded.** Vast.ai: *"no refunds on spent
  credits, ever."* Browserbase ships prepaid minutes over x402 and keeps the unused ones.
- **Hedera's own x402 page** lists *"discrete per-request design (not streaming)"* under
  Constraints.

An agent that cannot predict how long a job runs has two options today: overpay and eat
the loss, or underpay and get cut off. This is the third.

## The jobs this is for

The test for whether a job belongs here: **nobody can quote the duration before
starting.**

| Job | Lane | Why duration is unknowable |
| --- | --- | --- |
| **Index a document set** (flagship) | CPU → GPU | chunk count is only known after parsing |
| Fine-tune a classifier | GPU | convergence is unknowable by definition |
| Run this code / test suite | CPU | passes in 40 s or hangs for 10 minutes |
| Transcribe a batch | GPU | proportional to total audio, unknown until probed |
| Backtest a strategy | CPU | unbounded sweeps; agent stops early when results are bad |

The flagship is the two-phase index build because **the burn rate visibly changes when
the agent switches lanes**: cheap ticks, then expensive ticks. That happens naturally
rather than being staged.

## Status

**Working, verified on-chain.** Agents have paid for and used it end to end:
per-second metering, real sandboxes on Daytona (CPU) and Modal (GPU), refunds
for unheld seconds, and independent bill verification from the public mirror node.

- [PLAN.md](./PLAN.md): verified provider APIs and pricing, budget, build order, gotchas
- [rates.json](./rates.json): rate card. `cpu-small` is flagged `_costVerified: false`
  because Daytona does not publish per-resource container rates
- [adapters/interface.mjs](./adapters/interface.mjs): the one interface, three implementations

Built on the metering core in [`../src`](../src): x402 payment gate, HCS burn ledger,
HIP-991 settlement anchor, standalone verifier.
