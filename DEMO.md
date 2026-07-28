# 5-minute demo script

The bounty judges three things. This ordering front-loads criterion 2 (real
on-chain x402), because the biggest framing risk is a judge reading this as
"a credit system that happens to use x402" rather than an x402 project.

## 0:00–0:30 — Establish it is x402, on the wire

```bash
curl -i -X POST http://localhost:4021/session
```

On screen: **HTTP/1.1 402 Payment Required** and the `PAYMENT-REQUIRED` header.
Decode it live to show `scheme: "exact"`, `network: "hedera:testnet"`,
`asset: "0.0.0"`, and `extra.feePayer`.

Say: *feePayer is read from the facilitator's `/supported` at boot, never
hardcoded — the two live facilitators use different accounts.*

Also visible in that body: the `offer-receipt` extension carrying a **signed
offer** (JWS/ES256K), and the `bazaar` discovery extension.

## 0:30–1:15 — One payment, and the buyer pays zero gas

Run `node scripts/e2e.mjs`. Stop on the session mint and open the HashScan link.

Point at the transfer list:

```
0.0.9795418  -100000   buyer      exactly the price, nothing else
0.0.9795817  +100000   seller
0.0.9185802  -290693   facilitator  the ENTIRE network fee
```

Say: *the buyer's balance moved by exactly the purchase amount. The facilitator
absorbed every tinybar of network fee. On Solana, Vybe built a custom relayer to
get this. On Hedera it is one field.*

## 1:15–2:30 — The stream, and the top-up nobody notices

Let the SSE stream run. On screen: tokens arriving, balance decrementing,
checkpoint lines appearing with HashScan links.

At 399 credits the top-up fires. Emphasise: **the socket did not drop.** A second
payment settles on-chain mid-stream and credits splice in.

Say: *this is x402 issue #2273 — an open, unanswered extension proposal for
exactly this. Its first named use case is LLM token streams and its unit enum
already contains `token`.*

## 2:30–3:15 — Close: the anchor gates the refund

Show the close output: settlement anchor tx, then refund tx.

Open the HIP-991 topic on HashScan and show `custom_fees.fixed_fees` —
**collector is the buyer's account**.

Say: *the seller pays the buyer to close a session. The refund is not issued
until that anchor lands — `settleSession` refuses. The meter pays its own
auditor, and declaring your final numbers costs you money.*

## 3:15–4:15 — The part that makes it trustworthy

```bash
node scripts/verify.mjs <sessionId>
```

Five checks pass, reading **only the public mirror node**. No API key, nothing
to trust.

Then the money shot:

```bash
node scripts/e2e.mjs --cheat 400
node scripts/verify.mjs <sessionId>   # exits 1
```

> LEDGER OVER-BILLS: claims 3000 events, client received 2600
> (+400 phantom = 80000 tinybar overcharge)

Say: *checks 1–3 still pass while the seller cheats. The ledger really is
internally consistent — that is all HCS guarantees. Only comparing it to the
buyer's own record catches fabrication. We claim a tamper-evident, independently
recomputable consumption ledger. We do not claim trustless delivery proof.*

## 4:15–5:00 — Why Hedera, with a number

Show the FINDINGS.md table:

| Payload | Plain topic | HIP-991 topic |
| --- | --- | --- |
| 100 B | $0.00017 | $0.05007 |
| 4,000 B | $0.00080 | $0.05007 |

Say: *we measured this. A fee-charging topic costs a flat $0.050 per message
regardless of size or fee amount — 62× a plain topic. That killed our original
single-tier design and forced two tiers. It is probably also why zero of the
100 most recent testnet topics use HIP-991.*

Close on: *both tiers are HCS. There is no smart contract anywhere in this
system. On an EVM chain, a log write that pays an application-designated
collector requires deploying one.*

---

## Pre-flight

```bash
npm run check-config
lsof -ti:4021 | xargs -r kill -9
rm -f sessions.jsonl last-session.json
```

Seller needs >5 HBAR (each settlement anchor costs ~0.73 HBAR + fee).
Have HashScan open in tabs for: burn topic `0.0.9795896`, settlement topic
`0.0.9795865`, seller `0.0.9795817`.

## Do not claim on camera

- "trustless delivery proof" — false; say tamper-evident and recomputable
- "the buyer holds zero HBAR" — false in an HBAR system; say **zero network fee**
- "facilitators are interchangeable" — one trial each, not a load test
