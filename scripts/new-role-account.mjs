// Create a funded ECDSA role account (seller / second buyer / etc).
// Uses AccountCreateTransaction rather than EVM-alias auto-creation so the
// public key is published on-ledger immediately — no hollow-account state,
// so the facilitator's AccountInfoQuery signature check works on first use.
//
//   node scripts/new-role-account.mjs SELLER 50
import {
  Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction,
} from "@hiero-ledger/sdk";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { env, ROOT, mirror } from "../src/config.mjs";

const ROLE = (process.argv[2] || "SELLER").toUpperCase();
const FUND = Number(process.argv[3] ?? 20);

if (env[`${ROLE}_ACCOUNT_ID`]) {
  console.log(`${ROLE} already exists: ${env[`${ROLE}_ACCOUNT_ID`]} — refusing to overwrite.`);
  process.exit(0);
}

const operator = AccountId.fromString(env.HEDERA_ACCOUNT_ID);
const operatorKey = PrivateKey.fromStringECDSA(env.HEDERA_PRIVATE_KEY.replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(operator, operatorKey);

const key = PrivateKey.generateECDSA();

const resp = await new AccountCreateTransaction()
  .setECDSAKeyWithAlias(key)
  .setInitialBalance(new Hbar(FUND))
  .setAccountMemo(`pinout ${ROLE.toLowerCase()}`)
  .freezeWith(client)
  .sign(key)
  .then((tx) => tx.execute(client));

const receipt = await resp.getReceipt(client);
const id = receipt.accountId.toString();
client.close();

console.log(`${ROLE} account   : ${id}`);
console.log(`funded          : ${FUND} HBAR`);
console.log(`evm address     : 0x${key.publicKey.toEvmAddress()}`);
console.log(`transaction_id  : ${resp.transactionId.toString()}`);

appendFileSync(join(ROOT, ".env"),
  `\n${ROLE}_ACCOUNT_ID=${id}\n${ROLE}_PRIVATE_KEY=0x${key.toStringRaw()}\n`);
console.log(`\nappended ${ROLE}_ACCOUNT_ID / ${ROLE}_PRIVATE_KEY to .env`);

await new Promise((r) => setTimeout(r, 5000));
const acct = await mirror(`/api/v1/accounts/${id}`);
console.log(`on-chain key    : ${acct.key ? acct.key._type : "HOLLOW (unexpected)"}`);
console.log(`balance         : ${Number(acct.balance.balance) / 1e8} HBAR`);
