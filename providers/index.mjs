import { llm } from "./llm.mjs";
import { mirrorFirehose } from "./mirror.mjs";
import { compute } from "./compute.mjs";
const PROVIDERS = { llm, mirror: mirrorFirehose, compute };
export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown provider ${name}; have ${Object.keys(PROVIDERS)}`);
  return p;
}
export { PROVIDERS };
