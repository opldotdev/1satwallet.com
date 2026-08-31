import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	BSV21_BASKET,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";
import type { IndexedOutput, TokenDetailResponse } from "@1sat/types";
import type { ListOutputsArgs } from "@bsv/sdk";
import type { P2PBsv21TradeItem } from "../lib/types/p2p";
import { validateBsv21OfferForLock } from "../lib/wallet/bsv21-offer-validation";

const TOKEN_ID = `${"ab".repeat(32)}_1`;
const OTHER_TOKEN_ID = `${"ba".repeat(32)}_2`;
const FIRST_OUTPOINT = `${"cd".repeat(32)}_0`;
const SECOND_OUTPOINT = `${"ef".repeat(32)}_1`;

function offer(amount = "100"): P2PBsv21TradeItem {
	return {
		type: "bsv21",
		id: TOKEN_ID,
		name: "TOK",
		amount,
		decimals: 0,
	};
}

function localOutput(
	outpoint: string,
	amount: string,
	op = "transfer",
	tags: string[] = [`bsv21:${TOKEN_ID}`],
): WalletOutput {
	return {
		outpoint: outpoint.replace("_", "."),
		satoshis: 1,
		tags,
		customInstructions: JSON.stringify({ id: TOKEN_ID, amt: amount, op }),
	} as WalletOutput;
}

function overlayOutput(
	outpoint: string,
	amount: string,
	tokenId = TOKEN_ID,
): IndexedOutput {
	return {
		outpoint,
		score: 1,
		data: {
			bsv21: { id: tokenId, amt: amount, op: "transfer" },
		},
	};
}

function tokenDetails(tokenId = TOKEN_ID, active = true): TokenDetailResponse {
	return {
		tokenId,
		token: { id: tokenId, op: "deploy+mint", amt: "1000" },
		status: {
			token_id: tokenId,
			is_active: active,
			balance: 0,
			credits: 0,
			debits: 0,
			output_count: 0,
			fee_per_output: 0,
			fee_address: "",
			is_whitelisted: false,
			is_blacklisted: false,
		},
	};
}

interface ContextOptions {
	outputs?: WalletOutput[];
	list?: () => Promise<WalletOutput[]>;
	details?: () => Promise<TokenDetailResponse>;
	validate?: (
		tokenId: string,
		outpoints: string[],
		opts: { unspent?: boolean; tags?: string },
	) => Promise<IndexedOutput[]>;
}

function context(options: ContextOptions = {}): {
	ctx: OneSatContext;
	listArgs: ListOutputsArgs[];
	validationCalls: Array<{
		tokenId: string;
		outpoints: string[];
		opts: { unspent?: boolean; tags?: string };
	}>;
	events: string[];
} {
	const listArgs: ListOutputsArgs[] = [];
	const validationCalls: Array<{
		tokenId: string;
		outpoints: string[];
		opts: { unspent?: boolean; tags?: string };
	}> = [];
	const events: string[] = [];
	const wallet = {
		listOutputs: async (args: ListOutputsArgs) => {
			listArgs.push(args);
			const outputs = options.list
				? await options.list()
				: (options.outputs ?? []);
			return { totalOutputs: outputs.length, outputs };
		},
	};
	const bsv21 = {
		clearCache: () => events.push("clear"),
		getTokenDetails: async () => {
			events.push("details");
			return options.details?.() ?? tokenDetails();
		},
		validateOutputs: async (
			tokenId: string,
			outpoints: string[],
			opts: { unspent?: boolean; tags?: string },
		) => {
			validationCalls.push({ tokenId, outpoints, opts });
			return options.validate?.(tokenId, outpoints, opts) ?? [];
		},
	};
	return {
		ctx: {
			wallet,
			services: { bsv21 },
			chain: "main",
			isBaseWallet: false,
		} as unknown as OneSatContext,
		listArgs,
		validationCalls,
		events,
	};
}

describe("BSV21 P2P pre-lock validation", () => {
	it("freshly validates exact local coverage against active overlay rows", async () => {
		const harness = context({
			outputs: [
				localOutput(FIRST_OUTPOINT, "60"),
				localOutput(SECOND_OUTPOINT, "50"),
			],
			validate: async (_tokenId, outpoints) =>
				outpoints.map((outpoint) =>
					overlayOutput(outpoint, outpoint === FIRST_OUTPOINT ? "60" : "50"),
				),
		});
		const result = await validateBsv21OfferForLock(harness.ctx, [offer()]);
		assert.deepEqual(result, {
			ok: true,
			coverage: [
				{
					tokenId: TOKEN_ID,
					requestedAmount: "100",
					validatedAmount: "110",
				},
			],
		});
		assert.equal(harness.listArgs.length, 1);
		assert.equal(harness.listArgs[0].basket, BSV21_BASKET);
		assert.equal(harness.listArgs[0].includeTags, true);
		assert.equal(harness.listArgs[0].includeCustomInstructions, true);
		assert.deepEqual(harness.events, ["clear", "details"]);
		assert.deepEqual(harness.validationCalls[0], {
			tokenId: TOKEN_ID,
			outpoints: [FIRST_OUTPOINT, SECOND_OUTPOINT],
			opts: { unspent: true, tags: "bsv21" },
		});
	});

	it("excludes auth, zero, and malformed local outputs", async () => {
		const harness = context({
			outputs: [
				localOutput(FIRST_OUTPOINT, "1000", "auth", [
					`bsv21:${TOKEN_ID}`,
					"bsv21:auth",
				]),
				localOutput(SECOND_OUTPOINT, "0"),
				localOutput(`${"12".repeat(32)}_2`, "not-an-amount"),
			],
		});
		const result = await validateBsv21OfferForLock(harness.ctx, [offer("1")]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "insufficient-coverage");
		assert.equal(harness.validationCalls.length, 0);
	});

	it("fails closed for inactive deployments and identity mismatches", async () => {
		const inactive = context({
			outputs: [localOutput(FIRST_OUTPOINT, "100")],
			details: async () => tokenDetails(TOKEN_ID, false),
		});
		const inactiveResult = await validateBsv21OfferForLock(inactive.ctx, [
			offer(),
		]);
		assert.equal(inactiveResult.ok, false);
		if (!inactiveResult.ok) assert.equal(inactiveResult.code, "token-inactive");

		const mismatch = context({
			outputs: [localOutput(FIRST_OUTPOINT, "100")],
			details: async () => tokenDetails(OTHER_TOKEN_ID),
		});
		const mismatchResult = await validateBsv21OfferForLock(mismatch.ctx, [
			offer(),
		]);
		assert.equal(mismatchResult.ok, false);
		if (!mismatchResult.ok) {
			assert.equal(mismatchResult.code, "overlay-mismatch");
		}

		const deploymentMismatch = context({
			outputs: [localOutput(FIRST_OUTPOINT, "100")],
			details: async () => ({
				...tokenDetails(),
				token: { ...tokenDetails().token, id: OTHER_TOKEN_ID },
			}),
		});
		const deploymentMismatchResult = await validateBsv21OfferForLock(
			deploymentMismatch.ctx,
			[offer()],
		);
		assert.equal(deploymentMismatchResult.ok, false);
		if (!deploymentMismatchResult.ok) {
			assert.equal(deploymentMismatchResult.code, "overlay-mismatch");
		}
	});

	it("rejects overlay amount, token, duplicate, and coverage mismatches", async () => {
		for (const rows of [
			[overlayOutput(FIRST_OUTPOINT, "99")],
			[overlayOutput(FIRST_OUTPOINT, "100", OTHER_TOKEN_ID)],
			[
				overlayOutput(FIRST_OUTPOINT, "100"),
				overlayOutput(FIRST_OUTPOINT, "100"),
			],
		]) {
			const harness = context({
				outputs: [localOutput(FIRST_OUTPOINT, "100")],
				validate: async () => rows,
			});
			const result = await validateBsv21OfferForLock(harness.ctx, [offer()]);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.code, "overlay-mismatch");
		}

		const missing = context({
			outputs: [localOutput(FIRST_OUTPOINT, "100")],
			validate: async () => [],
		});
		const missingResult = await validateBsv21OfferForLock(missing.ctx, [
			offer(),
		]);
		assert.equal(missingResult.ok, false);
		if (!missingResult.ok) {
			assert.equal(missingResult.code, "insufficient-coverage");
		}
	});

	it("reports offline and timeout failures without signing an action", async () => {
		const unavailable = await validateBsv21OfferForLock(null, [offer()]);
		assert.equal(unavailable.ok, false);
		if (!unavailable.ok) assert.equal(unavailable.code, "wallet-unavailable");

		const unreadable = context({
			list: async () => {
				throw new Error("wallet secret");
			},
		});
		const unreadableResult = await validateBsv21OfferForLock(unreadable.ctx, [
			offer(),
		]);
		assert.equal(unreadableResult.ok, false);
		if (!unreadableResult.ok) {
			assert.equal(unreadableResult.code, "wallet-read-failed");
			assert.doesNotMatch(unreadableResult.message, /secret/);
		}

		const offline = context({
			outputs: [localOutput(FIRST_OUTPOINT, "100")],
			validate: async () => {
				throw new Error("network secret");
			},
		});
		const offlineResult = await validateBsv21OfferForLock(offline.ctx, [
			offer(),
		]);
		assert.equal(offlineResult.ok, false);
		if (!offlineResult.ok) {
			assert.equal(offlineResult.code, "overlay-unavailable");
			assert.doesNotMatch(offlineResult.message, /secret/);
		}

		const timedOut = context({
			outputs: [localOutput(FIRST_OUTPOINT, "100")],
			details: () => new Promise(() => {}),
		});
		const timeoutResult = await validateBsv21OfferForLock(
			timedOut.ctx,
			[offer()],
			{ timeoutMs: 5 },
		);
		assert.equal(timeoutResult.ok, false);
		if (!timeoutResult.ok) assert.equal(timeoutResult.code, "overlay-timeout");
	});

	it("gates the signed lock command behind validation in the trade UI", () => {
		const source = readFileSync(
			join(process.cwd(), "components/landing/trade-dialog.tsx"),
			"utf8",
		);
		const validateAt = source.indexOf("await validateBsv21OfferForLock");
		const signAt = source.indexOf("await signP2PCommand");
		assert.ok(validateAt > 0);
		assert.ok(signAt > validateAt);
		assert.match(source, /if \(!validation\.ok\)/);
		assert.match(source, /Checking BSV21 assets/);
		assert.doesNotMatch(source, /createAction|signAction/);
	});
});
