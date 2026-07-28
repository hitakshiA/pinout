// LLM token stream. `unit: "token"` is already in x402 #2273's enum, and
// "LLM token streams" is the first use case the proposal names. Per-token
// billing is the canonical unknown-total-cost problem: neither party can know
// what a completion will cost before generating it.
//
// Deterministic by default so a judge can reproduce a run byte-for-byte
// without an API key. Set OPENAI_API_KEY to stream real tokens instead.
import { createHash } from "node:crypto";
import { env } from "../src/config.mjs";

const CORPUS = `Hedera's x402 documentation lists a discrete per-request design as an explicit
limitation: not streaming, not multi-hop routing. Prepaid metered sessions close that gap. A buyer
pays once through a standard exact-scheme cycle, receives credits, and consumes events until the
balance runs low, at which point the client tops up without dropping the connection. Consumption is
checkpointed to a consensus topic so the bill can be recomputed by anyone from the public mirror
node, and the settlement anchor charges the seller a fee paid directly to the buyer.`
  .split(/\s+/);

export const llm = {
  name: "llm",
  unit: "token",
  async *stream({ n = 500, prompt = "" } = {}) {
    if (env.OPENAI_API_KEY) {
      yield* realTokens({ n, prompt });
      return;
    }
    const seed = createHash("sha256").update(String(prompt)).digest();
    for (let i = 0; i < n; i++) {
      const w = CORPUS[(seed[i % seed.length] + i) % CORPUS.length];
      yield {
        id: `tok-${i}`,
        i,
        token: w + (i % 12 === 11 ? "\n" : " "),
        unit: "token",
      };
      await new Promise((r) => setTimeout(r, 4));
    }
  },
};

async function* realTokens({ n, prompt }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt || "Explain HTTP 402 in detail." }],
      stream: true, max_tokens: n,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let i = 0, buf = "";
  while (i < n) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const tok = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
      if (tok) yield { id: `tok-${i}`, i: i++, token: tok, unit: "token" };
    }
  }
}
