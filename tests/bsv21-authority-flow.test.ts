import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OneSatContext } from "@1sat/actions";
import {
	BSV21_CAPABILITY_UNAVAILABLE,
	type Bsv21AuthorityActions,
	confirmsPermanentMintTermination,
	executeBsv21AuthorityIntent,
	permanentMintTerminationConfirmation,
	prepareLiveBsv21AuthorityExecution,
	requireLiveBsv21Capability,
} from "../lib/wallet/bsv21-authority";

const tokenId = `${"ab".repeat(32)}_0`;

describe("canonical BSV21 authority action dispatch", () => {
	test("uses only deployBsv21Auth and mintBsv21 public input shapes", async () => {
		const calls: Array<{ action: string; input: unknown }> = [];
		const actions: Bsv21AuthorityActions = {
			deploy: async (_ctx, input) => {
				calls.push({ action: "deployBsv21Auth", input });
				return { txid: "deploy", tokenId, authOutpoint: tokenId };
			},
			mint: async (_ctx, input) => {
				calls.push({ action: "mintBsv21", input });
				return { txid: "mint" };
			},
		};
		const ctx = {} as OneSatContext;

		await executeBsv21AuthorityIntent(
			ctx,
			{ kind: "deploy", symbol: "TEST", decimals: 8 },
			actions,
		);
		await executeBsv21AuthorityIntent(
			ctx,
			{ kind: "mint", tokenId, amount: 125n },
			actions,
		);
		await executeBsv21AuthorityIntent(
			ctx,
			{
				kind: "transfer",
				tokenId,
				destination: { counterparty: "02".padEnd(66, "1") },
			},
			actions,
		);
		await executeBsv21AuthorityIntent(
			ctx,
			{ kind: "terminate-authority", tokenId },
			actions,
		);
		await executeBsv21AuthorityIntent(
			ctx,
			{ kind: "terminate", tokenId, finalAmount: 7n },
			actions,
		);

		assert.deepEqual(calls, [
			{
				action: "deployBsv21Auth",
				input: {
					symbol: "TEST",
					decimals: 8,
					destination: { counterparty: "self" },
				},
			},
			{
				action: "mintBsv21",
				input: {
					tokenId,
					mint: {
						amount: 125n,
						destination: { counterparty: "self" },
					},
				},
			},
			{
				action: "mintBsv21",
				input: {
					tokenId,
					auth: {
						destination: { counterparty: "02".padEnd(66, "1") },
					},
				},
			},
			{
				action: "mintBsv21",
				input: {
					tokenId,
					endMinting: true,
				},
			},
			{
				action: "mintBsv21",
				input: {
					tokenId,
					mint: {
						amount: 7n,
						destination: { counterparty: "self" },
					},
					endMinting: true,
				},
			},
		]);
	});

	test("rechecks the live context services immediately before authority execution", async () => {
		const context = (capabilities: string[]) =>
			({
				services: { getCapabilities: async () => capabilities },
			}) as unknown as Pick<OneSatContext, "services">;

		await requireLiveBsv21Capability(context(["bsv21"]));
		await assert.rejects(
			requireLiveBsv21Capability(context(["ordfs", "market"])),
			new RegExp(BSV21_CAPABILITY_UNAVAILABLE),
		);
		await assert.rejects(
			requireLiveBsv21Capability({ services: undefined }),
			new RegExp(BSV21_CAPABILITY_UNAVAILABLE),
		);
	});

	test("clears BSV21 cached state only after the live capability check passes", async () => {
		const events: string[] = [];
		const context = {
			services: {
				getCapabilities: async () => {
					events.push("capabilities");
					return ["bsv21"];
				},
				bsv21: {
					clearCache: () => events.push("clear-cache"),
				},
			},
		} as unknown as Pick<OneSatContext, "services">;

		await prepareLiveBsv21AuthorityExecution(context);
		assert.deepEqual(events, ["capabilities", "clear-cache"]);

		const staleContext = {
			services: {
				getCapabilities: async () => {
					events.push("missing-capability");
					return ["ordfs"];
				},
				bsv21: {
					clearCache: () => events.push("unsafe-cache-clear"),
				},
			},
		} as unknown as Pick<OneSatContext, "services">;
		await assert.rejects(
			prepareLiveBsv21AuthorityExecution(staleContext),
			new RegExp(BSV21_CAPABILITY_UNAVAILABLE),
		);
		assert.equal(events.includes("unsafe-cache-clear"), false);
	});

	test("requires an exact typed confirmation for permanent termination", () => {
		const confirmation = permanentMintTerminationConfirmation(tokenId);
		assert.equal(confirmsPermanentMintTermination(confirmation, tokenId), true);
		for (const rejected of [
			"",
			confirmation.toLowerCase(),
			`${confirmation} `,
			permanentMintTerminationConfirmation(`${"cd".repeat(32)}_0`),
		]) {
			assert.equal(confirmsPermanentMintTermination(rejected, tokenId), false);
		}
	});

	test("uses the public authority-only termination shape without mint or auth", async () => {
		let mintInput: Record<string, unknown> | undefined;
		const actions: Bsv21AuthorityActions = {
			deploy: async () => ({}),
			mint: async (_ctx, input) => {
				mintInput = input as unknown as Record<string, unknown>;
				return { txid: "authority-termination" };
			},
		};

		await executeBsv21AuthorityIntent(
			{} as OneSatContext,
			{ kind: "terminate-authority", tokenId },
			actions,
		);

		assert.deepEqual(mintInput, { tokenId, endMinting: true });
		assert.equal(Object.hasOwn(mintInput ?? {}, "mint"), false);
		assert.equal(Object.hasOwn(mintInput ?? {}, "auth"), false);
	});

	test("preserves final positive mint termination without an auth output", async () => {
		let mintInput: Record<string, unknown> | undefined;
		const actions: Bsv21AuthorityActions = {
			deploy: async () => ({}),
			mint: async (_ctx, input) => {
				mintInput = input as unknown as Record<string, unknown>;
				return { txid: "final-mint" };
			},
		};

		await executeBsv21AuthorityIntent(
			{} as OneSatContext,
			{ kind: "terminate", tokenId, finalAmount: 1n },
			actions,
		);

		assert.equal(mintInput?.endMinting, true);
		assert.deepEqual(mintInput?.mint, {
			amount: 1n,
			destination: { counterparty: "self" },
		});
		assert.equal(Object.hasOwn(mintInput ?? {}, "auth"), false);
	});
});
