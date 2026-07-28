// Hedera tools: mirror-node reads plus the Pinout discovery surface. Read-only
// and free — nothing here spends HBAR.
import { tool } from "@openrouter/agent";
import { z } from "zod";
import { mirror, env, hashscan, tinybarToUsd } from "../src/config.mjs";

export function hederaTools() {
  return [
    tool({
      name: "hedera_account",
      description: "Look up a Hedera account: balance, key type, tokens. Free, reads the public mirror node.",
      inputSchema: z.object({ accountId: z.string().describe("e.g. 0.0.1234 or an EVM address") }),
      execute: async (a) => {
        const d = await mirror(`/api/v1/accounts/${a.accountId}`);
        return { account: d.account, balanceHbar: Number(d.balance?.balance ?? 0) / 1e8,
                 keyType: d.key?._type ?? "hollow (unsigned)", evmAddress: d.evm_address,
                 autoTokenAssociations: d.max_automatic_token_associations,
                 hashscan: hashscan.account(d.account) };
      },
    }),
    tool({
      name: "hedera_transaction",
      description: "Look up a Hedera transaction: result, fee, and every transfer it moved.",
      inputSchema: z.object({ transactionId: z.string() }),
      execute: async (a) => {
        const norm = a.transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
        const t = (await mirror(`/api/v1/transactions/${norm}`)).transactions?.[0];
        if (!t) return { error: "not found" };
        const { usd } = await tinybarToUsd(t.charged_tx_fee);
        return { name: t.name, result: t.result, chargedTxFee: t.charged_tx_fee, feeUsd: usd,
                 transfers: (t.transfers ?? []).filter((x) => Math.abs(x.amount) >= 1000),
                 assessedCustomFees: t.assessed_custom_fees ?? [],
                 hashscan: hashscan.tx(a.transactionId) };
      },
    }),
    tool({
      name: "hedera_topic_messages",
      description: "Read messages from a Hedera Consensus Service topic. This is how anyone audits Pinout's billing ledger without trusting the seller.",
      inputSchema: z.object({
        topicId: z.string().optional().describe("defaults to the burn ledger"),
        limit: z.number().optional(), order: z.enum(["asc", "desc"]).optional(),
      }),
      execute: async (a) => {
        const id = a.topicId ?? env.BURN_TOPIC_ID;
        const r = await mirror(`/api/v1/topics/${id}/messages?order=${a.order ?? "desc"}&limit=${a.limit ?? 10}`);
        return { topicId: id, hashscan: hashscan.topic(id),
          messages: (r.messages ?? []).map((m) => {
            let body; try { body = JSON.parse(Buffer.from(m.message, "base64").toString("utf8")); } catch { body = "(not json)"; }
            return { seq: m.sequence_number, consensusTimestamp: m.consensus_timestamp,
                     runningHash: String(m.running_hash).slice(0, 24) + "…", body };
          }) };
      },
    }),
    tool({
      name: "hedera_topic_info",
      description: "Read a topic's fee terms: custom fees, who collects them, and whether the fee schedule can still be changed.",
      inputSchema: z.object({ topicId: z.string().optional() }),
      execute: async (a) => {
        const id = a.topicId ?? env.TOPIC_ID;
        const t = await mirror(`/api/v1/topics/${id}`);
        return { topicId: id, memo: t.memo, customFees: t.custom_fees,
                 feeScheduleKey: t.fee_schedule_key ? "present (fees can change)" : "absent (frozen forever)",
                 feeExemptKeyList: t.fee_exempt_key_list ?? [], hashscan: hashscan.topic(id) };
      },
    }),
    tool({
      name: "hbar_price",
      description: "Current HBAR/USD rate as reported by the Hedera network itself.",
      inputSchema: z.object({ tinybar: z.number().optional() }),
      execute: async (a) => {
        const { usd, usdPerHbar } = await tinybarToUsd(a.tinybar ?? 1e8);
        return { usdPerHbar, ...(a.tinybar ? { tinybar: a.tinybar, usd } : {}) };
      },
    }),
  ];
}
