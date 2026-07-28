// A hollow account (created via EVM alias) has no public key on the ledger
// until it signs something. The x402 facilitator verifies payer signatures
// via AccountInfoQuery, so an unhydrated key surfaces as
// `invalid_exact_hedera_payload_signature_invalid` — a misleading error.
// One self-paid transaction publishes the key permanently.
import { Client, PrivateKey, AccountId, Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { env, mirror } from "../src/config.mjs";

const me = AccountId.fromString(env.HEDERA_ACCOUNT_ID);
const key = PrivateKey.fromStringECDSA(env.HEDERA_PRIVATE_KEY.replace(/^0x/, ""));

const before = await mirror(`/api/v1/accounts/${me}`);
if (before.key) {
  console.log("already hydrated:", before.key._type);
  process.exit(0);
}

const client = Client.forTestnet().setOperator(me, key);
// Smallest possible real transfer, self-paid, to force the key on-ledger.
const sink = AccountId.fromString("0.0.98"); // fee collection account
const tx = await new TransferTransaction()
  .addHbarTransfer(me, Hbar.fromTinybars(-1))
  .addHbarTransfer(sink, Hbar.fromTinybars(1))
  .setTransactionMemo("pinout: hydrate account key")
  .freezeWith(client)
  .sign(key);

const resp = await tx.execute(client);
const rec = await resp.getReceipt(client);
console.log("status        :", rec.status.toString());
console.log("transaction_id:", resp.transactionId.toString());
client.close();

await new Promise((r) => setTimeout(r, 5000));
const after = await mirror(`/api/v1/accounts/${me}`);
console.log("key now       :", after.key ? after.key._type : "STILL HOLLOW");
