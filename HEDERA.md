# Hedera capabilities used by Pinout

> **Superseded in part — read [FINDINGS.md](./FINDINGS.md) first.**
> This document was written *before* the on-chain measurements. It argues that
> HIP-991 carries the per-checkpoint burn ledger. Measurement disproved that: a
> fee-charging topic costs a flat ~$0.050 per message — 62x a plain topic,
> regardless of payload size *or* fee amount. The shipped design is therefore
> two-tier: plain HCS for high-frequency burn checkpoints, HIP-991 for the rare
> batched settlement anchor. The reasoning below about *why* HIP-991 is the
> uniquely-Hedera primitive still holds; its placement does not.

Everything below was checked against live testnet, the published HIPs in `hiero-ledger/hiero-improvement-proposals`, the x402 spec in `x402-foundation/x402`, and `@hiero-ledger/sdk` 2.86.2 on 2026-07-27. Where something could not be verified it says so.

The argument this file has to win is the bounty's third criterion: *how well the build uses Hedera rails*. The standard for "uses the rails well" is not "runs on Hedera." It is: **name the primitive without which this design does not exist, and show what it would cost to replace it elsewhere.** For Pinout that primitive is HIP-991. Everything else is supporting cast, and this file is explicit about which rails are genuinely unique and which are merely better.

---

## The inventory

| Capability | Number | What it does | What it does *for Pinout* |
| --- | --- | --- | --- |
| Permissionless revenue-generating topics | **HIP-991** (Final, release 0.59.5) | An HCS topic may charge a fixed fee — HBAR or HTS fungible — to submit a message, enforced at consensus, governed by a Fee Schedule Key, with a Fee Exempt Key List | **The meter itself.** Writing a consumption checkpoint costs money at the protocol level. No contract, no keeper. This is the load-bearing rail. |
| HCS `running_hash` + `sequence_number` | HCS core | Every topic message carries a monotonic sequence number and a consensus-computed running hash (`running_hash_version: 3`) | Makes the burn ledger tamper-evident without inventing a `prevHash` field. The chain is computed by consensus nodes, not by the seller. |
| Mirror Node REST | — | Free, public, unauthenticated historical read of topics, messages, accounts, tokens, transactions | The buyer independently replays checkpoints and recomputes the bill. Also backs the facilitator's own preflight balance/association checks. |
| x402 fee-payer model | Hedera's upstream contribution to the `exact` scheme | Client partially signs; facilitator sets itself as `transactionId.accountId`, co-signs, and submits | The buyer's account can hold **zero HBAR** for an entire session. This is Vybe's hand-built differentiator, free. |
| HBAR as a native asset | asset id `0.0.0` | Native currency, no association step | Default settlement asset. Zero onboarding friction for a fresh agent account. |
| HTS fungible tokens | **HIP-18** (Final, v0.16.0) | Native tokens at the protocol layer; USDC testnet is `0.0.429274`, 6 decimals | Alternative settlement asset the bounty explicitly allows. |
| Fixed, USD-denominated fee schedule | — | HBAR transfer ≈ $0.0001, HTS transfer ≈ $0.001, priced in USD and converted at the network exchange rate | The solvency argument. Per-call pricing is only a product when the fee cannot spike above the revenue. |
| Deterministic finality | aBFT consensus | No reorg window; a transaction is final at consensus | Credits can be granted against a settled transaction without a confirmation-depth policy. |
| HTS custom fees | HIP-18 + **HIP-573** (Final, v0.31.0) | Up to 10 fees per token; fractional fees auto-disbursed inside the same CryptoTransfer; treasury and (optionally) collectors exempt | **Evaluated and rejected** — see *Deliberately not used*. The reason is concrete and worth stating. |
| Long-term scheduled transactions | **HIP-423** (Final, v0.57.0) | `wait_for_expiry`, expiries up to 62 days | Not used. See below. |
| Allowances / approvals | **HIP-336** (Final, v0.25.0) | Delegated spend authority over an account's assets | Not used, and deliberately so — this is the *other* project's primitive. |

---

## HIP-991 — the rail the whole design stands on

**Status: Final, shipped in release 0.59.5.** Not a draft, not a proposal.

An HCS topic can be created with a list of fixed custom fees. Submitting a message to that topic charges the submitter that fee on top of the ordinary network fee, and the ledger moves the funds to the designated collector as part of processing the submission. HIP-991's own framing of the problem is the motivation for Pinout almost word for word: developers "find it challenging to charge users for submitting information to a topic due to the lack of a native fee structure," and the fix is that "topic fees can be distributed similarly to fixed fees on the HTS, supporting multiple wallets and Fungible tokens in addition to HBAR."

**Parameters that matter.**

- Fees are a `repeated FixedCustomFee custom_fees` on `ConsensusCreateTopicTransactionBody` (field 10). Each entry wraps an HTS `FixedFee` plus a `fee_collector_account_id`. A `FixedFee` with no denominating token is denominated in HBAR.
- `MAX_CUSTOM_FEE_ENTRIES_FOR_TOPICS = 10`. Ten collectors, one submission, atomic.
- `fee_schedule_key` (field 8) is the only way to change fees later. **It cannot be added after creation.** If you create the topic without one, the fee schedule is frozen forever. This is the single most consequential irreversible decision in the design.
- `fee_exempt_key_list` (field 9), max `MAX_ENTRIES_FOR_FEE_EXEMPT_KEY_LIST = 10`. Any submission carrying a signature from a listed key pays no custom fee. It holds *keys*, not accounts — the key need not correspond to a live account. Threshold keys work, but the threshold must actually be met. It is **not** pre-populated with the Admin, Submit, or Fee Schedule keys; if you want the operator exempt you must list it explicitly.
- `TransactionBody.max_custom_fees` (field 1001, `repeated CustomFeeLimit`) is the submitter's protection: a cap on what it is willing to pay. If the assessed fee exceeds the limit the transaction fails — **and the submitter still pays node and network fees for the failed transaction.** Omitting it means consenting to any fee up to the account balance.
- No balance is held by the topic. Funds move sender → collector at submission time. Insufficient funds means the message fails.

**SDK surface, verified present in `@hiero-ledger/sdk` 2.86.2:**

- `TopicCreateTransaction`: `setCustomFees`, `addCustomFee`, `getCustomFees`, `clearCustomFees`, `setFeeScheduleKey`, `getFeeScheduleKey`, `setFeeExemptKeys`, `addFeeExemptKey`, `clearFeeExemptKeys`
- `TopicMessageSubmitTransaction`: `setCustomFeeLimits`, `addCustomFeeLimit`, `getCustomFeeLimits`
- Types: `CustomFixedFee`, `CustomFeeLimit`, `AssessedCustomFee`
- Read-back: mirror node `GET /api/v1/topics/{id}` returns `custom_fees.fixed_fees`, `fee_schedule_key`, and `fee_exempt_key_list` as first-class fields — verified live. A judge can confirm the meter's fee terms without running anything.

**Why this cannot be done on an EVM chain without a contract.** On Ethereum, Base, or any EVM L2, "a log write that charges a fee" is not a thing the protocol offers. `LOG` opcodes cost gas paid to validators; there is no mechanism to route value to an application-designated collector as a property of the write. To get equivalent behaviour you deploy a contract with a `payable` function that takes a fee, splits it across collectors, and emits an event — which means a deployment, an upgrade story, an audit surface, a per-write gas cost that varies with congestion, and an owner key that can change the fee arbitrarily and silently. On Hedera the fee schedule is ledger state, readable by anyone from the mirror node, mutable only by a named key whose presence or absence is itself public. That is a materially different trust property, not a cheaper version of the same thing. **This is the honest "uniquely Hedera" claim, and it is the only one in this document.**

**The gotcha that shapes the architecture.** HIP-991's own text: "Starting January 2026, the price for the `ConsensusSubmitMessage` transaction will increase from $0.0001 to $0.0008 USD… with the v0.69 mainnet release and applies only to `ConsensusSubmitMessage` transactions." One write per delivered event is economically impossible at micropayment prices. **Checkpoint.** Write every N events, carrying the cumulative count and a digest over the batch. An observed testnet submit on 2026-07-27 was charged 355,932 tinybar ≈ $0.000247 at the network's reported exchange rate ($0.069350/HBAR) — lower than the published figure, but testnet fee schedules and exchange rates diverge from mainnet, so plan against $0.0008 and measure the real number.

**Verified scarcity:** of the 100 most recently created testnet topics, **zero** carry a HIP-991 fixed fee and **zero** carry a `fee_schedule_key`. A Final, shipped protocol feature that essentially nobody uses.

---

## HCS `running_hash` and `sequence_number` — tamper-evidence for free

Every message on a topic gets a `sequence_number` (monotonic, gapless) and a `running_hash` computed by the consensus nodes over the previous running hash plus the message. Verified live on testnet: `running_hash_version: 3`.

The seller is not the author of the chain. It cannot rewrite a checkpoint, cannot reorder, cannot backdate, cannot delete. The buyer fetches `GET /api/v1/topics/{topicId}/messages?order=asc` and gets `{ consensus_timestamp, sequence_number, running_hash, running_hash_version, message, payer_account_id, chunk_info }` per entry.

**Why this matters more than it sounds.** Every metered-billing system in existence invents a hash chain to make its audit log credible, and every one of those chains is computed by the party being audited. Here the chain is computed by the network. It is the difference between "we hashed our own log" and "consensus hashed our log." On an EVM chain you would rebuild this: a contract holding `bytes32 lastHash`, updated on each write, at storage-write gas cost. Possible — genuinely possible — just a contract, a deployment, and a per-write `SSTORE`. **This rail is better on Hedera, not unique to it.** Say that rather than overselling it.

**The boundary of the claim.** The chain proves the seller's checkpoints are immutable and internally consistent. It does not prove any specific event was delivered to any specific client. Digesting client-observable event identifiers into each checkpoint narrows the gap — the buyer can verify the digest against what it actually received — but a seller fabricating plausible events and checkpointing them honestly is not caught. Pinout claims a tamper-evident, independently recomputable consumption ledger. It does not claim trustless delivery proof.

---

## Mirror Node — the free verification surface

`https://testnet.mirrornode.hedera.com` — public, unauthenticated, no key, no rate-limit sign-up. Endpoints Pinout leans on:

| Endpoint | Use |
| --- | --- |
| `GET /api/v1/topics/{id}/messages` | Replay the burn ledger; recompute the bill |
| `GET /api/v1/topics/{id}` | Read `custom_fees`, `fee_schedule_key`, `fee_exempt_key_list` — confirm the meter's terms |
| `GET /api/v1/transactions/{txId}` | Confirm settlement; read `charged_tx_fee` and `assessed_custom_fees` |
| `GET /api/v1/accounts/{id}` and `/accounts/{id}/tokens` | Balance and token-association checks |
| `GET /api/v1/network/exchangerate` | Convert tinybar to USD honestly rather than hardcoding a price |

This is not incidental. `@x402/hedera`'s own `preflight.ts` builds its facilitator preflight on the mirror node, with the source comment: "The Mirror Node is the reliable source for balance and token-association data; consensus-node token queries no longer return that data dependably." It reads `balance.balance`, `max_automatic_token_associations`, and the `/accounts/{id}/tokens` relationship list. If you are debugging a rejected payment, that is the code path to reason about.

**EVM comparison:** an Ethereum equivalent means an RPC provider — Infura, Alchemy, a key, a quota, a paid tier. Vybe's own README concedes the point on Solana: "Without `rpcUrl` set, it falls back to the public mainnet RPC, which rate-limits at ~5 RPS. Use a paid tier." Hedera's mirror node removes a dependency and a signup from the buyer's verification path. **Better, not unique** — free public RPC exists elsewhere; reliable free archival read does not, but that is a difference of degree.

---

## The x402 ↔ Hedera interaction, exactly

Spec: `specs/schemes/exact/scheme_exact_hedera.md`. Packages: `@x402/core`, `@x402/fetch`, `@x402/hedera` (2.19.0 latest on npm; official reference repos pin 2.16.0 / `^2.14.0` / `^2.13.2`), plus `@x402/hono` or `@x402/express`. `@x402/hedera` exposes `./exact/client`, `./exact/server`, and `./exact/facilitator` subpaths.

**Header names, verified from `@x402/core` build output:** `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, plus `payment-error` and `payment-verified`.

**Sequence:**

1. Client → resource server, unpaid.
2. Server → **402** with `PAYMENT-REQUIRED`: base64 JSON `{ scheme: "exact", network: "hedera:testnet", amount, asset, payTo, maxTimeoutSeconds, extra: { feePayer } }`. `amount` is tinybars when `asset` is `"0.0.0"`, otherwise the token's smallest unit (USDC `0.0.429274` has 6 decimals).
3. Client builds a **bare `TransferTransaction`** — client → `payTo`, exactly `amount` of exactly `asset` — sets `transactionId.accountId = extra.feePayer`, freezes, signs with its ECDSA key. The result is *partially* signed; the fee payer's signature is absent.
4. Client base64-encodes the serialized transaction into `payload.transaction` and retries with `PAYMENT-SIGNATURE`.
5. Server → facilitator `POST /verify`.
6. Facilitator decompiles and enforces the MUST rules (below), returns a `VerifyResponse`.
7. Server → facilitator `POST /settle`; facilitator adds its fee-payer signature and submits.
8. Server → **200** with `PAYMENT-RESPONSE` carrying `{ success, transaction, payer, network }`. Client-side, `httpClient.getPaymentSettleResponse(...)` surfaces `{ success, transaction, payer }`.

**Settlement is asynchronous.** The 200 is emitted and the facilitator submits after. Credits are granted against a transaction that is submitted, not yet necessarily final. This is a real design consideration, not a footnote — see failure modes.

**Facilitator MUST rules that constrain the design.** These are load-bearing; violating any of them means the payment is rejected, not degraded.

1. **Bare transfer only.** "The decompiled transaction MUST be a `TransferTransaction` **directly**. It MUST NOT be wrapped in a `ScheduleCreateTransaction` or any other transaction type." It must "contain **only** transfer operations… necessary to implement the requested payment."
2. `transactionId.accountId == extra.feePayer`. Net HBAR sum zero; net sum for `asset` zero.
3. **Fee-payer safety.** `feePayer` MUST NOT appear as a negative entry in the HBAR list or in the `asset` token list. It MAY appear as a positive entry — the spec explicitly allows "collecting fees or custom fee distributions."
4. Single asset only. No other token IDs in the transfer.
5. **Amount exactness.** Net to `payTo` equals `amount` exactly, and **"no additional positive net transfers to any other party (besides `payTo`) may exist for the specified `asset`."** Any attempt to split revenue inside the x402 transfer is rejected here.
6. Signature verification. The facilitator fetches the payer's on-chain account key (`AccountInfoQuery`) and checks the frozen body carries a satisfying signature, including KeyList/threshold accounts. Failure reason: `invalid_exact_hedera_payload_signature_invalid`.

Rule 5 is why Pinout's revenue mechanics live on the **topic** (HIP-991), not inside the payment transfer. The x402 transaction is a clean one-to-one payment. The fee split, if any, happens on the metering write, which the facilitator never sees.

**Two live facilitators, different fee payers — verified 2026-07-27:**

| Facilitator | `hedera:testnet` `extra.feePayer` |
| --- | --- |
| `https://x402.org/facilitator` | `0.0.9185802` |
| `https://api.testnet.blocky402.com` | `0.0.7162784` |

**Derive `feePayer` from `GET /supported` at boot. Never hardcode.** Also verified: of the eleven payment kinds the canonical facilitator advertises across all chains — including `upto` and `batch-settlement` on `eip155:84532` — **`hedera:testnet` has only `exact`.** No partial-capture, no batch settlement, no auth-capture binding. Any design that needed those is not buildable here today. Pinout does not need them, because x402 issue #2273 explicitly specifies "any existing scheme… No new scheme."

A per-request **dynamic price callback** (`price: (ctx) => ...` inside `accepts`) is blessed by the official reference repos — the natural place to compute a top-up amount from the session's current burn rate.

---

## Deliberately not used, and why

**HTS custom fees (HIP-18 / HIP-573).** Fractional fees are genuinely elegant: up to 10 per token, auto-disbursed to collectors *inside the same `CryptoTransfer`*, atomically, with no contract, surfacing in the record as `assessed_custom_fees` and never appearing in the client-constructed transfer list. `net_of_transfers` decides whether the receiver absorbs the fee (`false`, the default) or the sender is charged on top. The treasury is automatically exempt; collectors can be (HIP-573). They are rejected here for one hard reason: **testnet USDC `0.0.429274` has `fee_schedule_key: null`** — verified on mirror node — so a custom fee can never be attached to it, and HBAR is not a token. Using fractional fees would require minting a bespoke token, which then satisfies neither "HBAR" nor "USDC" as the bounty requires. A second reason: three of five prior Hedera bounty winners' HTS claims were silently broken (`TOKEN_HAS_NO_SUPPLY_KEY`; tokens that never left the treasury). An unverifiable HTS claim is worse than no HTS claim.

**Scheduled transactions / HIP-423.** `ScheduleCreateTransaction` wraps an inner transaction, parties sign over time via `ScheduleSignTransaction`, and it fires the moment the signature requirement is met — unless `wait_for_expiry` is true, in which case it fires at `expiration_time`, or expires having paid nobody. Up to 62 days, immutable once created. Excluded for a spec-level reason: the Hedera `exact` scheme **forbids** wrapping the payment in a `ScheduleCreateTransaction`. There is no version of the x402 payment path where a schedule is legal.

**Allowances / HIP-336.** Delegated spend authority is precisely the primitive behind `qcornell/hedera-payment-sessions` ("approve once, pay many times, revoke anytime"). Adopting it would collapse Pinout into that project. A budget caps what may be spent; a meter counts what was consumed. Keeping them separate is the point.

**KeyList / ThresholdKey accounts.** Native N-of-N or M-of-M control over an account with no contract, and verifiably unused — 0 of 6 prior Hedera bounty winners ever constructed one. Tempting for that reason alone, and excluded for that reason too: a threshold key on the buyer's account would add signatures to the payment path for no benefit to the metering story. The facilitator does handle them correctly (Rule 6 explicitly covers KeyList/threshold accounts), so this is a deliberate pass, not an unavailability.

**Hooks / HIP-1195.** `@hiero-ledger/sdk` 2.86.2 exposes `addHbarTransferWithHook` and `addTokenTransferWithHook`. HIP-1195 is **Approved, not Final**, and a hook attached to a transfer is very likely to be read as a non-transfer operation under Rule 1. Not worth the risk on a payment path.

**Smart contracts.** Excluded on principle. The central claim is *this metering rail does not require a contract*. Deploying one anywhere in the meter path forfeits the argument.

**Not claimed here:** HCS-25's x402 trust signal (`x402UsageStatus` / `x402UsageSummary` with `volume7dUsd`, `inboundTrades7d`, and a log1p-scaled adapter of suggested weight 1) is a real and relevant standard, but its scores are trivially wash-traded and Pinout would be consuming a reputation signal rather than building anything. HCS-10/11 agent registry and HCS-26 skills registry are likewise adjacent and unused. The `hiero-cli` x402 plugin exists **only on GitHub main and is not in the published npm tag** — do not build tooling that assumes it.

---

## Failure modes and the empirical checks that settle them

| Failure mode | Why it happens | The check that settles it |
| --- | --- | --- |
| Checkpoint economics invert | `ConsensusSubmitMessage` at $0.0008 published vs $0.000247 observed on testnet; the fee has a per-byte component | Submit checkpoints at several realistic payload sizes; read `charged_tx_fee` from `GET /api/v1/transactions/{id}`; convert via `/network/exchangerate`. Derive N from measured cost, not from the quoted price. |
| Credits granted, settlement fails | The 200 precedes on-chain submission | Measure the verify→settle gap on both facilitators. Poll the mirror node for the returned `transaction` id and define what happens to a session whose settlement never lands. |
| Top-up arrives too late | Burn rate outruns the 402 round trip | Instrument the full top-up cycle under load; set the threshold from the measured p99, not from Vybe's default of 50 credits. |
| Payment rejected as `invalid_exact_hedera_payload_signature_invalid` | Wrong key type, or the body was mutated after freezing | Confirm the payer account's on-chain key is ECDSA and that `transactionId.accountId` is set *before* freeze. |
| USDC payment fails at settlement | HTS requires association for **every** recipient; `payTo` must be associated with `0.0.429274` | `GET /api/v1/accounts/{payTo}/tokens` and confirm the relationship exists before advertising a USDC price. The facilitator's own preflight also checks `max_automatic_token_associations`. |
| Fee schedule frozen forever | `fee_schedule_key` cannot be added after topic creation | Decide before the first `TopicCreateTransaction`. Then verify with `GET /api/v1/topics/{id}` that the key is actually present. |
| Metering write fails, submitter still charged | `max_custom_fees` set too low; submitter pays node and network fees on failure anyway | Set `CustomFeeLimit` deliberately, then induce a breach on testnet and confirm the failure mode and the residual charge. |
| Facilitator rejects a split payment | Rule 5: no additional positive net transfers besides `payTo` | Attempt one deliberately against `/verify` and record the rejection. Knowing exactly where the wall is beats guessing. |
| Wrong `feePayer` hardcoded | The two live facilitators use different accounts (`0.0.9185802` vs `0.0.7162784`) | Fetch `/supported` at boot, every boot, and assert the value matches what is placed in `extra`. |
