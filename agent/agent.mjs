// Test agent on the OpenRouter Agent SDK (@openrouter/agent).
//
// `callModel` runs the multi-turn loop, dispatches tools and tracks conversation
// state — there is no hand-rolled loop here.
//
// NOTE: no `stopWhen` by default. The loop ends when the model stops calling
// tools. That is deliberate for testing (we want to see what the agent actually
// chooses to do, not what a ceiling forces it to do), but it means a confused
// model can keep spending real HBAR and real OpenRouter credit. Pass
// `stopWhen` explicitly for anything unsupervised.
import { OpenRouter } from "@openrouter/agent";
import { env } from "../src/config.mjs";

export const DEFAULT_MODEL = env.AGENT_MODEL ?? "openai/gpt-5.6-luna-pro";

export function client() {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing from env/.env");
  return new OpenRouter({ apiKey: env.OPENROUTER_API_KEY });
}

export async function runAgent({
  task,
  tools = [],
  model = DEFAULT_MODEL,
  instructions = "You are an autonomous agent with a Hedera wallet. You pay for what you " +
    "use, out of your own funds. Always verify your bill before you finish. " +
    "State numbers precisely and say plainly if anything does not add up.",
  stopWhen,          // omitted on purpose — see note above
  verbose = true,
} = {}) {
  const openrouter = client();

  const result = openrouter.callModel({
    model,
    instructions,
    input: task,
    ...(tools.length ? { tools } : {}),
    ...(stopWhen ? { stopWhen } : {}),
  });

  if (verbose) {
    // Surface tool calls as they land so a long run is observable.
    (async () => {
      try {
        for await (const c of result.getToolCallsStream()) {
          const a = JSON.stringify(c.arguments ?? c.input ?? {});
          console.log(`  → ${c.name}(${a.length > 130 ? a.slice(0, 130) + "…" : a})`);
        }
      } catch { /* stream closed */ }
    })();
  }

  const answer = await result.getText();
  const response = await result.getResponse().catch(() => null);
  const toolCalls = await result.getToolCalls().catch(() => []);

  return { answer, toolCalls, usage: response?.usage ?? null, model };
}

export { tool, stepCountIs, maxCost, maxTokensUsed, hasToolCall } from "@openrouter/agent";
