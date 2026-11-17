import {
	type Bsv20Balance,
	groupBsv20Tokens,
	isListedOutput as isOrdLockV2Listing,
	type OneSatContext,
	type TokenBalance,
	type WalletOutput,
} from "@1sat/actions";
import type { IndexedOutput } from "@1sat/types";
import {
	canonicalOrdinalActions,
	executeOrdinalOperation,
	isOrdinalListed,
	type OrdinalActionSet,
	ordinalActionFailureMessage,
	ordinalAssetId,
} from "@/lib/wallet/ordinal-actions";

export const ASSET_TYPES = [
	"listings",
	"ordinals",
	"bsv21",
	"bsv20",
	"bsv",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export type TaggedOutput = {
	outpoint: string;
	tags?: string[];
	events?: string[];
	data?: unknown;
};

export type ListedAsset = {
	outpoint: string;
	id: string | null;
	source: "wallet" | "legacy";
};

export type MigrationPlan<T extends TaggedOutput = TaggedOutput> = {
	cancel: ListedAsset[];
	sweepListed: T[];
	sweepOrdinals: T[];
	sweepFunding: T[];
	sweepBsv21: TokenBalance[];
	sweepBsv20: Bsv20Balance[];
};

/**
 * MNEE's BSV-21 token id. MNEE outputs are cosigner-locked (P2PKH plus an
 * approver signature), so the generic BSV-21 sweep cannot sign them. Same id
 * @1sat/wallet's Bsv21Indexer routes to its own basket.
 */
export const MNEE_TOKEN_ID =
	"ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0";

/** A BSV-20 output the sweep leaves where it is, and why. */
export interface UnsweepableBsv20 {
	output: IndexedOutput;
	reason: string;
}

export const BSV20_UNREADABLE_REASON = "no readable ticker or amount";
export const BSV20_UNCONFIRMED_REASON =
	"amount comes only from the inscription text, not from the indexer, so a sweep could claim more than the output holds and burn it";

function bsv20Record(output: TaggedOutput): Record<string, unknown> | null {
	const data = output.data;
	if (!data || typeof data !== "object") return null;
	const bsv20 = (data as Record<string, unknown>).bsv20;
	return bsv20 && typeof bsv20 === "object"
		? (bsv20 as Record<string, unknown>)
		: null;
}

/**
 * True when the indexer itself gives this BSV-20 output's amount: an `amt:`
 * event or `data.bsv20.amt`. parseBsv20Token falls back to the inscription's
 * JSON, which anyone can write and no indexer has checked.
 */
export function hasIndexedBsv20Amount(output: TaggedOutput): boolean {
	if (output.events?.some((event) => event.startsWith("amt:"))) return true;
	const amt = bsv20Record(output)?.amt;
	return (typeof amt === "string" && amt.length > 0) || typeof amt === "number";
}

/**
 * Group BSV-20 outputs by ticker for the sweep. Only outputs whose amount the
 * indexer gives are swept: one with an amount from its inscription JSON alone
 * is left at its address with a reason, never batched or swept on its own,
 * since an over-claimed transfer can burn the tokens.
 */
export function splitBsv20Outputs(outputs: IndexedOutput[]): {
	balances: Bsv20Balance[];
	unsweepable: UnsweepableBsv20[];
} {
	const indexed = outputs.filter(hasIndexedBsv20Amount);
	const balances = groupBsv20Tokens(indexed);
	const grouped = new Set(
		balances.flatMap((balance) => balance.outputs.map((o) => o.outpoint)),
	);
	const unsweepable = outputs.flatMap((output) => {
		if (grouped.has(output.outpoint)) return [];
		const fromJsonOnly =
			!hasIndexedBsv20Amount(output) && groupBsv20Tokens([output]).length > 0;
		return [
			{
				output,
				reason: fromJsonOnly
					? BSV20_UNCONFIRMED_REASON
					: BSV20_UNREADABLE_REASON,
			},
		];
	});
	return { balances, unsweepable };
}

/** Drops tokens the generic BSV-21 sweep cannot sign for (MNEE). */
export function excludeUnsweepableTokens<T extends { tokenId: string }>(
	tokens: T[],
): T[] {
	return tokens.filter((t) => t.tokenId !== MNEE_TOKEN_ID);
}

/**
 * True for a marketplace listing: OrdLock v1 (`ordlock` tag, event or data)
 * or OrdLock v2 as @1sat/actions detects it (`ordlock2` event or data, or a
 * `list:` event). v1 stays recognised so nothing listed under it is treated
 * as a plain output.
 */
export function isListedOutput(output: TaggedOutput): boolean {
	if (output.tags?.includes("ordlock")) return true;
	if (
		output.events?.some(
			(event) => event === "ordlock" || event.startsWith("ordlock:"),
		)
	) {
		return true;
	}
	const data =
		output.data !== null && typeof output.data === "object"
			? (output.data as Record<string, unknown>)
			: undefined;
	if (data && "ordlock" in data) return true;
	return isOrdLockV2Listing({
		outpoint: output.outpoint,
		score: 0,
		events: output.events,
		data,
	});
}

/**
 * Batches for one token class: every listed output alone (its OrdLock is
 * cancelled in that spend, so one bad listing cannot sink the rest, as
 * @1sat/actions' bsv21SweepBatches / bsv20SweepBatches do), then the
 * unlisted outputs in chunks of `size`.
 */
export function isolateListedBatches<T extends TaggedOutput>(
	outputs: T[],
	size: number,
): T[][] {
	const listed: T[] = [];
	const unlisted: T[] = [];
	for (const output of outputs) {
		if (isListedOutput(output)) listed.push(output);
		else unlisted.push(output);
	}
	const batches = listed.map((output) => [output]);
	for (let i = 0; i < unlisted.length; i += size) {
		batches.push(unlisted.slice(i, i + size));
	}
	return batches;
}

export function listedFromWallet(outputs: WalletOutput[]): ListedAsset[] {
	return outputs.filter(isOrdinalListed).map((output) => ({
		outpoint: output.outpoint,
		id: ordinalAssetId(output),
		source: "wallet",
	}));
}

export function listedFromLegacy(outputs: TaggedOutput[]): ListedAsset[] {
	return outputs.filter(isListedOutput).map((output) => ({
		outpoint: output.outpoint,
		id: null,
		source: "legacy",
	}));
}

export function mergeListed(
	wallet: ListedAsset[],
	legacy: ListedAsset[],
): ListedAsset[] {
	const seen = new Set<string>();
	const merged: ListedAsset[] = [];
	for (const item of [...wallet, ...legacy]) {
		if (seen.has(item.outpoint)) continue;
		seen.add(item.outpoint);
		merged.push(item);
	}
	return merged;
}

export function withoutListed<T extends TaggedOutput>(outputs: T[]): T[] {
	return outputs.filter((output) => !isListedOutput(output));
}

export function defaultAssetTypes(): Set<AssetType> {
	return new Set(ASSET_TYPES);
}

export function toggleAssetType(
	types: ReadonlySet<AssetType>,
	type: AssetType,
): Set<AssetType> {
	const next = new Set(types);
	if (next.has(type)) next.delete(type);
	else next.add(type);
	return next;
}

export function planMigration<T extends TaggedOutput>(input: {
	types: ReadonlySet<AssetType>;
	listings: ListedAsset[];
	listedLegacyOutputs: T[];
	ordinals: T[];
	opns: T[];
	funding: T[];
	bsv21: TokenBalance[];
	bsv20?: Bsv20Balance[];
}): MigrationPlan<T> {
	const listingsOn = input.types.has("listings");
	const cancelable = new Set(
		input.listings
			.filter((item) => item.source === "wallet" && item.id)
			.map((item) => item.outpoint),
	);
	return {
		cancel: listingsOn
			? input.listings.filter((item) => item.source === "wallet")
			: [],
		sweepListed: listingsOn
			? input.listedLegacyOutputs.filter(
					(output) => !cancelable.has(output.outpoint),
				)
			: [],
		sweepOrdinals: input.types.has("ordinals")
			? [...input.ordinals, ...input.opns]
			: [],
		sweepFunding: input.types.has("bsv") ? input.funding : [],
		// A listed token output is cancelled inside its own sweep spend, so the
		// "Open listings" choice decides whether it moves.
		sweepBsv21: input.types.has("bsv21")
			? withTokenListings(input.bsv21, listingsOn)
			: [],
		sweepBsv20: input.types.has("bsv20")
			? withTokenListings(input.bsv20 ?? [], listingsOn)
			: [],
	};
}

function withTokenListings<B extends { outputs: IndexedOutput[] }>(
	balances: B[],
	listingsOn: boolean,
): B[] {
	if (listingsOn) return balances;
	return balances
		.map((balance) => ({
			...balance,
			outputs: balance.outputs.filter((output) => !isListedOutput(output)),
		}))
		.filter((balance) => balance.outputs.length > 0);
}

/** The listed outputs of each token group; groups with none are dropped. */
export function onlyListedTokens<B extends { outputs: IndexedOutput[] }>(
	balances: B[],
): B[] {
	return balances
		.map((balance) => ({
			...balance,
			outputs: balance.outputs.filter(isListedOutput),
		}))
		.filter((balance) => balance.outputs.length > 0);
}

/** Token outputs of one class, summed across its groups. */
export function tokenOutputCount(
	balances: readonly { outputs: readonly unknown[] }[],
): number {
	return balances.reduce((sum, balance) => sum + balance.outputs.length, 0);
}

export function plannedCount(plan: MigrationPlan): number {
	return (
		plan.cancel.length +
		plan.sweepListed.length +
		plan.sweepOrdinals.length +
		plan.sweepFunding.length +
		tokenOutputCount(plan.sweepBsv21) +
		tokenOutputCount(plan.sweepBsv20)
	);
}

export async function cancelListedAssets(
	ctx: OneSatContext,
	listings: ListedAsset[],
	actions: OrdinalActionSet = canonicalOrdinalActions,
): Promise<{ ok: boolean; txids: string[]; errors: string[] }> {
	const txids: string[] = [];
	const errors: string[] = [];
	for (const item of listings) {
		if (!item.id) {
			errors.push(
				`Listing ${item.outpoint} cannot be cancelled until the wallet refreshes its asset ID.`,
			);
			continue;
		}
		try {
			const result = await executeOrdinalOperation(
				ctx,
				{ kind: "cancel", id: item.id },
				actions,
			);
			if (result.error) {
				errors.push(`Listing ${item.outpoint}: ${result.error}`);
			} else if (result.txid) {
				txids.push(result.txid);
			} else {
				errors.push(
					`Listing ${item.outpoint}: cancel returned no transaction id`,
				);
			}
		} catch (error) {
			console.error(
				`[migration] cancel of listing ${item.outpoint} failed`,
				error,
			);
			errors.push(
				`Listing ${item.outpoint}: ${ordinalActionFailureMessage(error)}`,
			);
		}
	}
	return { ok: errors.length === 0, txids, errors };
}
