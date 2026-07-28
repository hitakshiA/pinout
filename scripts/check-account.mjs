// Resolve the auto-created account ID from the EVM address and report
// HBAR balance, auto-association slots, and USDC association state.
const MIRROR = "https://testnet.mirrornode.hedera.com";
const EVM = "0x6591c3fad786e5336e0bd04f6a47486810c8afbd";
const USDC = "0.0.429274";

const r = await fetch(`${MIRROR}/api/v1/accounts/${EVM}`);
if (!r.ok) {
  console.log(`Account does not exist yet (mirror node ${r.status}).`);
  console.log("Send testnet HBAR to the EVM address to auto-create it.");
  process.exit(0);
}
const a = await r.json();
console.log("account_id                       :", a.account);
console.log("evm_address                      :", a.evm_address);
console.log("hbar balance (tinybar)           :", a.balance?.balance);
console.log("max_automatic_token_associations :", a.max_automatic_token_associations);
console.log("key type                         :", a.key?._type);

const t = await fetch(`${MIRROR}/api/v1/accounts/${a.account}/tokens?token.id=${USDC}`);
const tokens = (await t.json()).tokens ?? [];
console.log("USDC associated                  :", tokens.length > 0);
if (tokens.length) console.log("USDC balance (6dp)               :", tokens[0].balance);
