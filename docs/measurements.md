# Phase 0 findings — measured on Hedera testnet, 2026-07-28

Everything here is measured, not quoted. Every number has a transaction behind it.
Exchange rate at time of measurement: **$0.068801 / HBAR** (network-reported via
`/api/v1/network/exchangerate`, not hardcoded).

---

## 1. x402 `exact` payments work, and the buyer pays zero gas

Two live settlements, one per facilitator, identical structure.

| Facilitator | feePayer (from `/supported`) | Settlement tx |
| --- | --- | --- |
| `x402.org/facilitator` | `0.0.9185802` | `0.0.9185802@1785181172.680425137` |
| `api.testnet.blocky402.com` | `0.0.7162784` | `0.0.7162784@1785181194.987365817` |

Transfer list on both:

```
0.0.9795418  -100000    buyer   — exactly the price, nothing else
0.0.9795817  +100000    seller
0.0.9185802  -290693    facilitator — the ENTIRE network fee
0.0.802      +290693    fee collection
```

**The buyer paid zero network fees.** Its balance fell by exactly the purchase
amount and nothing else; the facilitator absorbed all 290,693 tinybar ($0.00020)
of network cost. This is Hedera's fee-payer model — what Vybe built custom relayer
infrastructure for, obtained from one `extra.feePayer` field.

Stated precisely, because an earlier draft of this claim was wrong: the buyer
pays **zero network fee**, not zero HBAR. In an HBAR-denominated system the buyer
obviously spends HBAR — that is the payment. The "wallet needs no gas token"
framing is a USDC-era argument and does not survive the HBAR-only decision. What
survives, and is worth more, is that the buyer needs **no fee headroom**: it can
hold exactly the purchase amount and transact.

**Both facilitators charged an identical 290,693 tinybar** and produced identical
transfer structures. This is **one trial each**, not a load test — sufficient to
show `feePayer` resolution and fee-payer semantics are equivalent, insufficient to
claim interchangeability under concurrency. Repeated/rapid payment behaviour
remains untested. `feePayer` is resolved from `/supported` at boot and never
hardcoded, which matters because the two values differ.

## 2. Hollow accounts break x402 signature verification

An account auto-created via EVM alias has `key: null` on the ledger until it
signs something. The facilitator verifies the payer via `AccountInfoQuery`
(scheme rule 6), so an unhydrated account fails as
`invalid_exact_hedera_payload_signature_invalid` — an error that looks like a
client signing bug and is not.

Fixed by one self-paid transaction (`scripts/hydrate-key.mjs`). Role accounts
created with `AccountCreateTransaction().setECDSAKeyWithAlias()` publish their
key immediately and never enter the hollow state — that is the better path.

## 3. HIP-991 topic creation costs 29.36 HBAR ($2.02)

`CONSENSUSCREATETOPIC` **with** custom fees: **2,936,003,836 tinybar = 29.3600 HBAR = $2.02**.
A plain topic is a rounding error by comparison.

The SDK's default max transaction fee is far below this, so the failure mode is
`INSUFFICIENT_TX_FEE` (status 9) with no indication that the cause is the custom-fee
machinery. Requires an explicit `.setMaxTransactionFee(new Hbar(40))`.

This is a one-time per-topic cost, but it means topics cannot be created casually
— no topic-per-session designs.

## 4. The load-bearing finding: HIP-991 imposes a flat ~$0.050 surcharge per message

Measured `ConsensusSubmitMessage` cost, same seller, same network, same minute:

| Payload | Plain topic | HIP-991 topic |
| --- | --- | --- |
| 100 B | 247,088 tb = **$0.00017** | 72,673,361 tb = **$0.05007** |
| 1,000 B | 1,136,610 tb = **$0.00078** | 72,673,361 tb = **$0.05007** |
| 4,000 B | 1,160,331 tb = **$0.00080** | 72,673,361 tb = **$0.05007** |

Two independent invariances, both verified:

- **Independent of payload size.** The plain topic shows a clean per-byte curve
  that matches HIP-991's own quoted $0.0008 figure. The fee-charging topic is
  flat to the tinybar across a 40× size range.
- **Independent of the custom fee amount.** Using `fee_schedule_key` to set the
  fee to 1 tinybar and then to 10,000,000 tinybar produced the *identical*
  72,673,361 network charge both times.

So attaching any custom fee to a topic costs the submitter a fixed
**0.7267 HBAR ≈ $0.050** in network fees — **62× a plain-topic submit** — on top of
the custom fee itself.

The custom fee is a rounding error next to the surcharge. At the live 100,000-tinybar
schedule the custom fee is **0.14%** of the seller's total cost
(100,000 / 72,773,361); even at the 10,000,000-tinybar test schedule it is only 12.1%.
The seller is overwhelmingly paying the network, not the buyer — which is precisely
why this rail cannot carry high-frequency writes.

This is almost certainly why the earlier scan found **0 of 100 recent testnet
topics using HIP-991**. The rail is Final and shipped, and effectively unusable
for high-frequency writes.

### Consequence: the single-tier design in README.md is not viable

The original plan checkpoints every N events to a HIP-991 topic. At $0.050 per
checkpoint that is economically broken for micropayments. Realistic LLM token
pricing is ~$0.000001–0.000015 per token; a checkpoint would need to cover
~50,000 tokens just to reach 10% overhead, which makes the meter far too coarse
to be a meter.

### The redesign: two-tier ledger

| Tier | Rail | Frequency | Cost | Purpose |
| --- | --- | --- | --- | --- |
| **Burn ledger** | plain HCS topic `0.0.9795896` | every N events | $0.0008 | fine-grained consumption checkpoints; `running_hash` + `sequence_number` tamper-evidence |
| **Settlement anchor** | HIP-991 topic `0.0.9795865` | batched, rare | $0.050 | seller pays buyer; incentive alignment, amortized |

Both tiers are HCS. **No smart contract anywhere** — the central architectural
claim survives intact. HIP-991 still does real work at the layer where its cost
is amortizable, and the reason it sits there rather than on every checkpoint is
now a measured fact rather than a guess.

This also answers open question #1 of x402 issue #2273 verbatim — *"synchronous
on-chain refund on close vs. signed receipt + batched settlement?"* The measured
answer is **batched settlement**, and the measurement is why.

## 5. `fee_schedule_key` works, and the fee terms are publicly verifiable

Live from `GET /api/v1/topics/0.0.9795865`:

```json
"custom_fees": {"fixed_fees": [
  {"amount": 100000, "collector_account_id": "0.0.9795418", "denominating_token_id": null}
]},
"fee_schedule_key": "ECDSA_SECP256K1",
"fee_exempt_key_list": []
```

- `collector_account_id` is a **fixed account chosen at topic creation**. On this
  deployment it is the operator's own treasury, which happens to be the buyer in
  our own tests — so the "seller pays the party it would defraud" framing held
  only because buyer and collector were the same account. **For a third-party
  buyer it is a self-payment.** An independent audit caught this; the claim has
  been corrected everywhere. The real, unconditional incentive is the
  **~0.7345 HBAR network fee** the seller cannot recover, whoever collects the
  custom fee.
- `denominating_token_id: null` confirms HBAR denomination.
- `fee_exempt_key_list` empty — the seller is deliberately **not** exempt.
- The fee schedule was successfully updated three times, proving the key is live
  and that omitting it at creation would have frozen the terms permanently.

Anyone can read these terms from the free public mirror node without running
anything or trusting the seller.

---

## Accounts

| Role | Account | Notes |
| --- | --- | --- |
| Treasury (also the buyer in our own tests) | `0.0.9795418` | ECDSA, hydrated; the FIXED HIP-991 fee collector — a third-party buyer receives nothing from it |
| Seller | `0.0.9795817` | ECDSA, key published at creation |
| Burn ledger topic | `0.0.9795896` | plain HCS |
| Settlement anchor topic | `0.0.9795865` | HIP-991; custom fee → fixed collector `0.0.9795418`, NOT the paying buyer |

---

# Phase 1–4 — the working system, verified on-chain

## 6. Full session lifecycle runs end to end

One live run, all steps on Hedera testnet:

| Step | Evidence |
| --- | --- |
| `POST /session` → real HTTP **402** with `PAYMENT-REQUIRED` | `0.0.9185802@1785184000.296025280` (session + top-up) |
| client retries with `PAYMENT-SIGNATURE`, server verifies + settles | credits minted **only after** settle succeeded |
| SSE stream, 1 credit burned per event | 2,600 events delivered |
| burn checkpoints → plain HCS `0.0.9795896` | 11 checkpoints |
| **mid-stream top-up**, socket never dropped | fired automatically at 399 credits remaining |
| HIP-991 settlement anchor → `0.0.9795865` | `0.0.9795817@1785184013.047669956` |
| seller pays buyer via the topic's custom fee | 100,000 tinybar, assessed on-chain |
| refund, issued **only after** the anchor landed | `0.0.9795817@1785184016.180196270`, 80,000 tinybar |

Arithmetic checks out: 2,600 × 200 = 520,000 tinybar consumed against 600,000
paid (400,000 mint + 200,000 top-up) → 80,000 refunded.

## 7. The verifier catches a real cheating seller

`node scripts/e2e.mjs --cheat 400` makes the seller inflate the ledger. The
verifier, reading only the public mirror node:

```
1. contiguity              PASS
2. tier binding            PASS
3. settlement arithmetic   PASS
4. ledger vs received      FAIL  claims 3000, client received 2600
                                 (+400 phantom = 80000 tinybar overcharge)
5. checkpoint commitments  FAIL  11/11 do not match
```

Checks 1–3 **passing while the seller cheats** is the point, not a defect. The
ledger really is internally consistent and immutable — that is what HCS
guarantees, and it is all it guarantees. Only comparison against the buyer's own
record exposes fabrication. This is the claimed trust boundary, demonstrated.

Exit codes are CI-usable: `0` passed, `1` fraud detected, `2` inconclusive.

## 8. Two bugs the verifier found in our own code

**Mirror-node race.** The settlement anchor committed to burn-ledger sequence 16
while the head was 17: `burnLedgerHead()` reads the mirror node, which lags
consensus by seconds, so reading immediately after a write returns the *previous*
message. Fixed by taking `topicSequenceNumber` and `topicRunningHash` from the
transaction **receipt** instead. The verifier caught this on its first run.

**Unserialized close → double refund.** Two concurrent `POST /close` calls could
both pass the `state === "CLOSED"` guard, both write an anchor, and both refund.
Fixed with a promise lock in `settleSession()`.

**Verifier rubber-stamp.** When the buyer's event log was missing, checks 4–5 were
skipped and it still printed PASSED — meaning a cheating seller passed whenever
the client record was absent. Now returns **INCONCLUSIVE** (exit 2) and says so.

## 9. MCP server: paid tools for agents

`src/mcp.mjs` exposes `open_session`, `stream`, `close_session`, `verify_session`,
`spend_report`. No tool returns data before its payment settles on-chain. Driven
by a real MCP client, an agent autonomously paid 400,000 tinybar, streamed 300
events, settled, and reported its own spend against a budget.

This is what [`hedera-agent-kit-js#1007`](https://github.com/hashgraph/hedera-agent-kit-js/issues/1007)
asks for — *"x402 middleware wired to an MCP server — tool calls are blocked until
a confirmed HBAR micropayment is received"* — and what
[#894](https://github.com/hashgraph/hedera-agent-kit-js/issues/894) asks for in
*"an HCS audit-log example for accepted paid tool calls"* and *"a Mirror Node
receipt verifier helper"*. Both issues are open and unanswered.

Spend guards (`maxPerCallTinybar`, `budgetTinybar`) reject a challenge **before any
signature exists**, so a mispriced or injected 402 cannot put funds at risk.

## 10. Phase 3 — signed offers and receipts (x402 `offer-and-receipt`, JWS profile)

The extension defines two artifacts and two formats. `eip712` hardcodes an EVM
address for `payTo` and fits Hedera badly; the **JWS profile** is format-agnostic
and works natively with Hedera ECDSA keys via `ES256K`. Pinout implements JWS.

One finding worth recording: **`@hiero-ledger/sdk`'s `PrivateKey.sign()` is not
RFC 7515 compatible.** It returns a correctly shaped 64-byte r||s, but probing
shows the signature verifies against neither plain SHA-256 nor Keccak-256 of the
message, so a standard JWS verifier rejects it. Signing is therefore done
explicitly — SHA-256 over the JWS signing input, secp256k1, low-s normalised.
Anyone can now verify a Pinout receipt with an off-the-shelf JWS library, which
is the entire point of a signed receipt.

- Signed **offer** in every 402, at `extensions["offer-receipt"].info.offers[]`,
  with `payload` omitted per spec (it already lives inside the JWS).
- Signed **receipt** on close, binding settled payment → session → units
  consumed → burn-ledger final sequence → settlement anchor tx.
- `kid` is a did:hedera DID URL: `did:hedera:testnet:0.0.9795817#key-1`.
- Verified: tampering the payload fails; verifying with a wrong key fails.

## 11. Money bugs found by adversarial review, and fixed

Each was reachable and each moved real funds the wrong way.

| Bug | Consequence | Fix |
| --- | --- | --- |
| Unserialized close | two concurrent closes → **two refunds** for one session | promise lock in `settleSession()` |
| CLOSED session kept its credit balance | buyer closes, takes the refund, **keeps streaming for free** | `burn()` checks state before balance; `credits` zeroed on close |
| Top-up challenged a CLOSED session | server issued a 402 for a dead session — buyer pays **on-chain for nothing** | reject with 409 *before* the challenge is issued |
| Concurrent streams on one session | interleaved burns, overlapping checkpoint ranges the verifier would reject | one-stream-per-session guard |
| Persistence was write-only | restart stranded credits the buyer had paid for | rehydrate open sessions on boot |
| Burn state only saved at open/close | a crash mid-stream lost every burn since session start | save at each checkpoint |

Verified after fixing, against a live server:

```
stream-after-close : 409 session is CLOSED
topup-after-close  : 409 session is CLOSED; cannot top up
double-close       : refund 390000 vs first 390000 (no 2nd payout)
credits on CLOSED  : 0 (zeroed)
```

**Crash-recovery bound.** Burn state is durable to the last checkpoint, so a
crash loses at most `CHECKPOINT_EVERY` events. Measured: before restart
`credits 1400 / burned 600`, after `credits 1500 / burned 500` — 100 events lost
out of a 250 interval. The loss falls on the **seller**; a crash can never bill
the buyer for events it did not receive. That asymmetry is deliberate.

## 12. Migrating to the official x402 server stack found bugs the hand-rolled path hid

Originally the **client** used the official `@x402/hedera/exact/client` while the
**server** side was hand-rolled — an asymmetry a Hedera reviewer would spot.
Ported to `@x402/hedera/exact/server` + `@x402/hono`, and bumped 2.19.0 → 2.20.0.

Three things only surfaced because the official code validates what we asserted:

**Our `bazaar` extension was malformed the entire time.** On boot the middleware
reported: *"Route declares a bazaar extension but it is malformed (expected an
object with `info` and `schema` fields)."* We had `info` but no `schema`. Nothing
caught it before because we generated the 402 body ourselves. Fixed in all three
declarations.

**The official ordering is safer than ours.** `@x402/hono` verifies **before** the
handler and settles **after** it succeeds, cancelling the payment if the handler
throws or returns ≥400. We settled first, so a failure after settlement would
have charged the buyer for nothing. We now inherit the safer ordering — and the
settlement tx id consequently arrives in the `PAYMENT-RESPONSE` header rather
than being available inside the handler.

**`extra.feePayer` is injected automatically** by the official scheme's
`enhancePaymentRequirements`, from the facilitator's advertised support. We had
been wiring it by hand.

The port also caught a bug of ours in flight: `extractTransactionFromPayload`
takes the **inner** payload (`{transaction}`), not the whole `PaymentPayload`
envelope. Passing the wrong shape threw, the handler 500'd, and the middleware
correctly **cancelled the payment instead of charging for a failed request** —
the safety property firing on a genuine mistake.

Idempotency now keys on a hash of the signed payment itself rather than the
settlement tx id (which does not exist at handler time under settle-after-
handler). That is strictly better: it dedupes the payment, not its receipt.

Extensions are now registered through `resourceServer.registerExtension()` with
`dynamicInfoFields: ["offers"]`, since a freshly-signed offer with a new
`validUntil` must be excluded from the client's strict echo validation.

## 13. Open security finding: the close endpoint is unauthenticated

Exposing the server on a public URL for a third-party agent test made this
obvious: **`POST /session/:id/close` requires no authentication.** Anyone holding
a session id can close someone else's session, and every close makes the seller
write a HIP-991 anchor at ~0.73 HBAR. That is a griefing and fund-drain vector.

The session id is currently acting as a bearer token by accident rather than by
design. `stream` and `topup` have the same exposure. The fix is a per-session
secret issued at mint and required on every subsequent call — not yet
implemented, and it is the top item before this is a real product.
