// x402 `offer-and-receipt` extension, JWS profile, for Hedera.
//
// The spec defines two signed artifacts — an Offer (the server cryptographically
// commits to the terms it advertises in accepts[]) and a Receipt (the server
// confirms payment and delivery). Both exist for "dispute evidence and
// auditability" and "verifiable proof of commercial interactions".
//
// It supports two formats: eip712 and jws. The eip712 profile hardcodes an EVM
// address for payTo and is a poor fit here. The JWS profile is format-agnostic
// and works natively with Hedera ECDSA (secp256k1) keys via ES256K, so that is
// what Pinout implements.
//
// IMPORTANT: @hiero-ledger/sdk's PrivateKey.sign() does NOT produce an RFC 7515
// compatible signature — probing shows it verifies against neither plain SHA-256
// nor Keccak-256 of the message. Signing here is therefore done explicitly:
// SHA-256 over the JWS signing input, secp256k1, low-s normalised, r||s. Any
// standard JWS library can verify the result, which is the entire point of a
// signed receipt.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { env, NETWORK, HBAR_ASSET } from "./config.mjs";

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uJson = (o) => b64u(Buffer.from(JSON.stringify(o), "utf8"));
const unb64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** did:hedera DID URL identifying the signing key — the JWS `kid`. */
export function keyId(accountId = env.SELLER_ACCOUNT_ID) {
  return `did:hedera:testnet:${accountId}#key-1`;
}

function privBytes() {
  return Buffer.from(env.SELLER_PRIVATE_KEY.replace(/^0x/, ""), "hex");
}

/** Sign a payload into JWS Compact Serialization with ES256K. */
export function signJws(payload, { kid = keyId() } = {}) {
  const header = { alg: "ES256K", typ: "JWT", kid };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const digest = sha256(Buffer.from(signingInput, "ascii"));
  // noble returns raw 64-byte r||s here; older majors returned a Signature
  // object, so normalise rather than assume.
  const sig = secp256k1.sign(digest, privBytes(), { lowS: true });
  const compact = sig instanceof Uint8Array
    ? sig
    : (sig.toBytes?.("compact") ?? sig.toCompactRawBytes());
  return `${signingInput}.${b64u(compact)}`;
}

/**
 * Verify a compact JWS against a secp256k1 public key.
 * @param jws compact serialization
 * @param pubHex 33-byte compressed public key, hex
 */
export function verifyJws(jws, pubHex) {
  const parts = jws.split(".");
  if (parts.length !== 3) return { valid: false, reason: "not compact JWS" };
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(unb64u(h).toString("utf8"));
    payload = JSON.parse(unb64u(p).toString("utf8"));
  } catch (e) {
    return { valid: false, reason: `malformed: ${e.message}` };
  }
  if (header.alg !== "ES256K") return { valid: false, reason: `alg ${header.alg} != ES256K` };
  if (!header.kid) return { valid: false, reason: "missing kid" };

  const digest = sha256(Buffer.from(`${h}.${p}`, "ascii"));
  let valid = false;
  try {
    valid = secp256k1.verify(unb64u(s), digest, Buffer.from(pubHex, "hex"));
  } catch (e) {
    return { valid: false, reason: `bad signature encoding: ${e.message}` };
  }
  return { valid, header, payload, reason: valid ? undefined : "signature does not verify" };
}

/**
 * A signed Offer. Goes in extensions["offer-receipt"].info.offers[] of the 402.
 * Per spec, for format=jws the `payload` field is OMITTED — the payload already
 * lives inside the JWS compact string, and duplicating it invites ambiguity.
 */
export function signOffer({ resourceUrl, amount, payTo, validitySeconds = 180, acceptIndex = 0 }) {
  const payload = {
    version: 1,
    resourceUrl,
    scheme: "exact",
    network: NETWORK,
    asset: HBAR_ASSET,
    payTo,
    amount: String(amount),
    validUntil: Math.floor(Date.now() / 1000) + validitySeconds,
  };
  return {
    format: "jws",
    signature: signJws(payload),
    // unsigned convenience field; MUST NOT be relied on for integrity
    acceptIndex,
  };
}

/**
 * A signed Receipt, issued after payment AND delivery. This is the artifact
 * that makes a metered session disputable: it binds the settled payment to the
 * consumption actually recorded on the burn ledger and to the settlement anchor.
 */
export function signReceipt({
  resourceUrl, sessionId, payer, amount, settlementTxId,
  unitsConsumed, unit, burnTopic, burnFinalSeq, settlementTopic, settlementTxOnTopic,
}) {
  const payload = {
    version: 1,
    resourceUrl,
    scheme: "exact",
    network: NETWORK,
    asset: HBAR_ASSET,
    payTo: env.SELLER_ACCOUNT_ID,
    amount: String(amount),
    payer,
    settlementTx: settlementTxId,
    issuedAt: Math.floor(Date.now() / 1000),
    // metered-session specifics, so the receipt is checkable against the ledger
    session: sessionId,
    unitsConsumed,
    unit,
    burnTopic,
    burnFinalSeq,
    settlementTopic,
    settlementAnchorTx: settlementTxOnTopic,
  };
  return { format: "jws", signature: signJws(payload) };
}

export const sellerPublicKeyHex = () => {
  const priv = privBytes();
  return Buffer.from(secp256k1.getPublicKey(priv, true)).toString("hex");
};
