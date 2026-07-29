# Pinout Compute build plan

A metered computer an AI agent rents by the second, pays for over x402 on Hedera,
and gets change back from, with a bill anyone can recompute from public data.

Two lanes: **CPU** (Daytona, $200 credit) and **GPU** (Modal, $30 credit).

All provider rates below are confirmed. No estimated numbers remain.

---

## 1. Verified provider facts

Everything below was read from the providers' own docs. Anything unverified says so.

### Modal, the GPU lane

**API shape** (`modal.Sandbox`):

```python
sb = modal.Sandbox.create(
    app=app, image=img, gpu="T4", cpu=2, memory=8192,
    timeout=1800,            # DEFAULT IS 300s. Long jobs die silently without this
    idle_timeout=60,         # Modal bills idle GPU containers
    block_network=False,
    outbound_domain_allowlist=[...],   # egress policy for untrusted code
)
p = sb.exec("python", "-u", "job.py")
for line in p.stdout:        # native line iterator, free streaming
    tick(line)
sb.terminate()
```

Also available: `Sandbox.from_id()` (reconnect, which is what `attach()` uses),
`snapshot_filesystem()`, `set_tags()` / `Sandbox.list()` for reaping orphans.

**Pricing, verified at modal.com/pricing.** The trap: **Sandbox CPU and memory are
billed at roughly 3× the standard task rate.** Quoting GPU cost alone understates a
sandbox by ~55%.

| Resource | Sandbox rate |
| --- | --- |
| GPU T4 | $0.000164 / sec |
| GPU A100-40 | $0.000583 / sec |
| CPU | **$0.00003942** / physical core / sec (standard tasks: $0.0000131) |
| Memory | **$0.00000667** / GiB / sec |

Real T4 sandbox = `0.000164 + 0.00003942 (1 core) + 0.00005336 (8 GiB)` ≈
**$0.000257 / sec**.

**Starter plan limits:** $30/mo credit · 100 containers · **10 GPU concurrency** ·
**1-day log retention** · billing API is Team-tier only.

### Daytona, the CPU lane

**API shape.** `exec()` and `code_run()` block, so streaming must go through a session:

```python
sandbox.process.create_session(sid)
cmd = sandbox.process.execute_session_command(
    sid, SessionExecuteRequest(command="python -u job.py", run_async=True))
await sandbox.process.get_session_command_logs_async(
    sid, cmd.cmd_id, on_stdout, on_stderr)
```

> **From Daytona's own docs:** *"avoid blocking operations inside stdout/stderr
> callbacks. Blocking synchronous callbacks can cause WebSocket disconnections."*

That is a hard constraint on the tick loop, not a style note.

**Billing states, verified:**

| State | vCPU | RAM | Disk |
| --- | :--: | :--: | :--: |
| Started | ✓ | ✓ | ✓ |
| **Creating / Starting / Stopping / Pausing** | ✓ | ✓ | ✓ |
| Stopped | ✗ | ✗ | ✓ |
| Archived | ✗ | ✗ | ✗ |

Cold start and shutdown bill at the full rate. **The meter must start when their
clock starts**, or every refund drifts in the seller's favour.

**Org resource pool (Tier 1):** 10 vCPU / 10 GiB RAM / 30 GiB disk, a ceiling on
concurrent sandboxes, not a per-sandbox limit.

**Pricing, confirmed from the dashboard** (not published in the public docs):

| Resource | Rate |
| --- | --- |
| vCPU | $0.00001400 / s |
| Memory | $0.00000450 / GiB / s |
| Storage | $0.00000003 / GiB / s, **first 5 GB free** |
| Windows OS surcharge | $0.0000238 / vCPU / s |

So `cpu-small` (1 vCPU, 1 GiB, 3 GiB disk) = `0.000014 + 0.0000045 + 0` =
**$0.0000185/s**. Disk is free under the 5 GB allowance.

Daytona also sells GPU (RTX 4090 $0.000275/s, RTX 5090 $0.000358/s, H100 $0.001097/s,
H200 $0.001261/s) at better value than Modal, **but GPU is not available on this
plan**, so the lane split stands: Daytona CPU, Modal GPU.

---

## 2. Budget: GPU is the binding constraint

Lane split is fixed: **Daytona = CPU only** (no GPU on this plan), **Modal = GPU only**.

| Lane | Provider | All-in cost | Credit price | Runway on credit |
| --- | --- | --- | --- | --- |
| `cpu-small` 1 vCPU / 1 GiB | Daytona | $0.0000185/s | 30,000 tinybar | **3,003 h** |
| `cpu-4` 4 vCPU / 8 GiB | Daytona | $0.000092/s | 147,000 tinybar | 604 h |
| `gpu-t4` 2 vCPU / 8 GiB | Modal | $0.000257/s | 411,000 tinybar | **32.5 h** |
| `gpu-a100-80` 4 vCPU / 16 GiB | Modal | $0.000959/s | 1,533,000 tinybar | **8.7 h** |

CPU is effectively free at this scale, 3,000 hours. **GPU is not, and it does not
replenish inside the build window.** 10.8 hours of A100 is roughly one careless
afternoon.

Rules that follow directly:

- **`local` adapter is mandatory before either provider.** Every unit test, integration
  run and demo rehearsal uses it. Zero cost, zero cold start, works offline.
- **CPU is the development lane.** The tick loop, credit burn, checkpointing, refund
  arithmetic and reconciliation are all provider-agnostic, so build and debug them on
  Daytona, where 3,000 hours means mistakes are free.
- **GPU is a demo resource, not a development one.** Touch it only to prove the lane
  works and to record.
- **A100 is opt-in and gated.** T4 is the default GPU lane; A100 requires an explicit
  flag so it can never be selected by accident.
- **Hard server-side wall-clock cap per session**, lower on GPU lanes than CPU.
- **Track GPU seconds spent** against the 32.5 h ceiling and refuse new GPU sessions
  past a reserve, so there is always enough left to record the demo.
- **Reap orphans on boot** via `Sandbox.list()` tags. An abandoned GPU sandbox with
  `idle_timeout` unset burns budget silently.

The flagship is designed around this: **CPU-heavy, GPU-brief.** Parsing 5,000 PDFs is
minutes of CPU; embedding the chunks is seconds of T4. That is also the honest shape of
the workload, so the constraint and the demo agree.

---

## 3. The problem that must be solved first

**A HIP-991 settlement anchor costs a flat $0.050** (measured, see
[docs/measurements.md](../docs/measurements.md)). Against compute:

| Lane | Anchor equals |
| --- | --- |
| gpu-t4 | ~3.2 minutes of compute |
| gpu-a100-80 | ~50 seconds |
| cpu-small | **tens of minutes** |

Per-session settlement is underwater for short jobs, and "one session per lane" means
the two-phase flagship pays **two** anchors. So settlement becomes an explicit tier:

| Tier | Buyer pays | Refund lands |
| --- | --- | --- |
| **Batched** (default) | nothing extra | next sweep, ≤5 min, one anchor covers many sessions |
| **Priority** | the $0.050 anchor | immediately, own anchor |

Batched settlement already exists (`writeBatchSettlement`, used by the expiry sweeper).
This generalises it from a cleanup path to the default settlement path, and it is the
measured answer to open question #1 of x402 issue #2273.

---

## 4. Metering

**1 credit = 1 second of compute held.** Not one output line. The meter never depends
on how chatty the workload is, and the refund arithmetic reads itself.

```
setInterval(1000):
    burn 1 credit
    emit tick { seq, secs, spent, left, lane, provider, stdout: drain(buffer) }
    every N ticks -> HCS burn checkpoint
    if left < threshold -> top-up 402 cycle (stream never drops)
```

The adapter fills `buffer`; the tick drains it. Decoupled in both directions.

```json
{"seq":187,"secs":187,"spent":187,"left":413,
 "lane":"gpu-t4","provider":"modal",
 "stdout":"epoch 12  loss 0.318  1420 tok/s"}
```

The rate card goes inside the **signed offer** (offer-and-receipt already ships), so
the quote is non-repudiable, so a customer can prove what they were promised.

---

## 5. Three-way reconciliation: the moat

`verify()` shows three numbers that must agree:

> **Correction from an independent audit:** the HIP-991 custom fee is paid to a
> collector fixed at topic creation, not to whoever is paying. On this deployment
> that is the operator's treasury, so for a third-party buyer it is a
> self-payment. The unconditional incentive is the ~0.7345 HBAR *network* fee the
> seller cannot recover. Point the collector at an escrow account if you want the
> fee itself to change hands.

1. **What we billed**: credits burned, from the HCS ledger
2. **What the chain says**: replayed from the public mirror node
3. **What the provider says**: Daytona `get_metrics()` for the same window

Modal's billing API is Team-tier only, so the GPU lane is self-instrumented from
`create`/`terminate` timestamps. **Publish which lane has provider-side corroboration
and which does not.** Stating the asymmetry is more credible than flattening it.

Next step beyond the spec: sign the provider's metrics **into the receipt**, making it
a three-party attestation rather than a seller's claim with a timestamp.

---

## 6. Agent surface

```
list_compute()                       free, browsing, no payment
run({code, tier, estimated_seconds, max_budget_tinybar, files?})
                                     402 → settle → provision → returns {session_id, watch_url}
attach({session_id})                 reconnect (Modal: Sandbox.from_id)
status({session_id})                 {credits_left, seconds_elapsed, tail, provider}
stop({session_id})                   terminate + refund
verify({session_id})                 recompute from mirror node + provider metrics
spend_report()                       aggregate across sessions, per lane
```

`run()` returns immediately because MCP is request/response and Claude Code
auto-backgrounds anything over two minutes. The browser page holds its own SSE
connection, independent of what the client renders.

---

## 7. Security: blocking for any public deploy

**Testnet HBAR is free from a faucet.** On a public testnet deployment the payment
gate provides *zero* economic friction: anyone can mint funds at no cost and run
arbitrary code on our Modal and Daytona accounts, billed to a real card.

Required before first deploy, pick one:

- **mainnet** for the deployed instance (real HBAR = real friction), preferred
- **allowlisted testnet**: x402 flow fully real, payer checked against a list
- provider spend caps + egress allowlist + hard wall-clock ceilings, necessary in
  all cases, sufficient in none

---

## 8. Build order

| Step | Deliverable |
| --- | --- |
| 1 | Settlement tiers (batched default / priority paid) |
| 2 | `local` adapter (subprocess), so tests and rehearsals cost nothing |
| 3 | Tick loop, second-based metering, rate card in the signed offer |
| 4 | `list_compute` + `run` + `status` + `stop` |
| 5 | Modal adapter (native iterator) + orphan reaping |
| 6 | Daytona adapter + `get_metrics()` reconciliation |
| 7 | Provider metrics signed into the receipt |
| 8 | Front end: catalogue → meter → log → verify, SSE straight to the meter |
| 9 | Flagship job: two-phase index build (CPU parse → GPU embed) |
| 10 | `attach` + `spend_report` |
| 11 | Abuse controls, `--replay` recording insurance, judge guide |

Cold-agent audit at the end of each step, not only at the finish. That is what
caught the stranded-money bug, and the surface only grows from here.

---

## 9. Gotchas

| | |
| --- | --- |
| Modal sandbox default timeout is **300 s** | Set `timeout=1800` or long jobs die at 5 minutes |
| Daytona `exec()` / `code_run()` **block** | Streaming requires `create_session` → `execute_session_command(run_async=True)` → `get_session_command_logs_async` |
| Daytona **blocking callbacks kill the WebSocket** | Callbacks must be async and must not do work, push to a buffer only |
| Both bill **cold start** | Modal from container allocation incl. image pull; Daytona bills Creating/Starting/Stopping at full rate |
| Daytona CPU sampler is a **5-second window** | Runs under ~5 s report 0%. Keep metered runs ≥30 s |
| Modal billing API is **Team-tier only** | Self-instrument the GPU lane; say so |
| Modal bills **idle GPU containers** | Set `idle_timeout` and terminate deterministically |
| Modal Starter: **1-day log retention** | Don't rely on provider logs as the audit trail, that's what HCS is for |
| Neither exposes a **price catalogue API** | `rates.json` is maintained by hand. Every real broker does this; say so |
| **Arbitrary agent code** | Sandboxed by the providers, but egress policy + wall-clock caps + spend ceilings are ours to set |

---

> **Pinout Compute gives an agent a computer it rents by the second, pays for with a
> wallet instead of an account, and gets the change back from, with a bill anyone can
> recompute from a public log.**


---

## 10. Measured unit economics: the service is not profitable at demo scale

This is the number that matters and it is not flattering.

| | |
| --- | --- |
| Settlement anchor | **0.7345 HBAR** (measured, irrecoverable) |
| cpu-small revenue | 30,000 tinybar/s = **0.0003 HBAR/s** |
| Break-even session length | **~2,450 seconds (41 minutes)** per anchor |

A typical demo session runs 5 to 10 seconds and earns ~0.0018 HBAR against a
0.7345 HBAR anchor, so the seller loses roughly **400x what it earns**.

Batched settlement (implemented) divides the anchor across every session closed
in a sweep window, so the cost per session is `0.7345 / N`. With N=2 in testing
the seller still lost 3.47 HBAR across 3 short sessions. Batching makes the
economics *survivable at volume*, not *profitable at demo scale*.

Honest options, none of which are hidden:

1. **Volume.** At N=100 sessions per anchor the cost is 0.0073 HBAR each, which
   short sessions can carry.
2. **Longer sessions.** Real compute jobs run minutes, not seconds.
3. **Priority tier.** `?settlement=priority` makes the buyer pay for their own
   immediate anchor, where the 0.7345 HBAR is then a disclosed line item rather than
   a loss.
4. **Anchor less often.** One anchor per hour rather than per sweep, trading
   settlement latency for cost.

The seller-solvency guard exists precisely because of this: it refuses new
sessions rather than accept money it cannot afford to settle. During testing it
correctly shut the service down when the operator wallet hit 0.55 HBAR.
