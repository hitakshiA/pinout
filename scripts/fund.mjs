// Move HBAR from the buyer (treasury) to a role account.
//   node scripts/fund.mjs SELLER 50
import { Client, PrivateKey, AccountId, Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { env, mirror } from "../src/config.mjs";

const ROLE = (process.argv[2] || "SELLER").toUpperCase();
const AMT = Number(process.argv[3] ?? 25);
const to = AccountId.fromString(env[`${ROLE}_ACCOUNT_ID`]);
const from = AccountId.fromString(env.HEDERA_ACCOUNT_ID);
const key = PrivateKey.fromStringECDSA(env.HEDERA_PRIVATE_KEY.replace(/^0x/, ""));

const client = Client.forTestnet().setOperator(from, key);
const resp = await new TransferTransaction()
  .addHbarTransfer(from, new Hbar(-AMT))
  .addHbarTransfer(to, new Hbar(AMT))
  .setTransactionMemo(`pinout: fund ${ROLE.toLowerCase()}`)
  .freezeWith(client).sign(key).then((tx) => tx.execute(client));
console.log((await resp.getReceipt(client)).status.toString(), resp.transactionId.toString());
client.close();

await new Promise((r) => setTimeout(r, 4000));
for (const [label, id] of [["buyer", from], [ROLE.toLowerCase(), to]]) {
  const a = await mirror(`/api/v1/accounts/${id}`);
  console.log(`${label.padEnd(8)} ${(Number(a.balance.balance) / 1e8).toFixed(4)} HBAR`);
}
