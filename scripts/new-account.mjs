// Generate a Hedera ECDSA (secp256k1) keypair for x402.
// ED25519 is NOT usable: x402/EVM tooling derives identity via ecrecover,
// which is secp256k1-only. An ED25519 key fails silently with a
// confusing "signature mismatch" / "no matching transfer".
import { PrivateKey } from "@hiero-ledger/sdk";

const key = PrivateKey.generateECDSA();
const pub = key.publicKey;

console.log(JSON.stringify({
  keyType: "ECDSA_secp256k1",
  privateKeyDer: key.toStringDer(),
  privateKeyRaw: "0x" + key.toStringRaw(),
  publicKeyDer: pub.toStringDer(),
  publicKeyRaw: pub.toStringRaw(),
  evmAddress: "0x" + pub.toEvmAddress(),
}, null, 2));
