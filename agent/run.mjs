// node agent/run.mjs                                  full paid run, default model
// node agent/run.mjs --model qwen/qwen3.7-flash       swap model
// node agent/run.mjs "custom task text"
import { runAgent, DEFAULT_MODEL } from "./agent.mjs";
import { pinoutTools } from "./tools.mjs";

const argv = process.argv.slice(2);
const mi = argv.indexOf("--model");
const model = mi > -1 ? argv[mi + 1] : DEFAULT_MODEL;
const task = argv.filter((_, i) => mi === -1 || (i !== mi && i !== mi + 1)).join(" ") ||
  "Find out what this service sells and what it costs. Then buy some, consume 600 events " +
  "(top up automatically if you run low), close the session properly so you get your refund, " +
  "and verify you were billed correctly. Report the verdict and whether the numbers add up.";

console.log(`model : ${model}\ntask  : ${task}\n`);
const out = await runAgent({ task, model, tools: pinoutTools() });
console.log(`\n─── answer ───\n${out.answer}\n`);
console.log(`tool calls: ${out.toolCalls?.length ?? 0} | usage:`, JSON.stringify(out.usage ?? {}));
process.exit(0);
