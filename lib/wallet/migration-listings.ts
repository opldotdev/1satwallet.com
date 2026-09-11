import type { OneSatContext, TokenBalance, WalletOutput } from "@1sat/actions";
import type { IndexedOutput } from "@1sat/types";
import {
	executeMigrationSweep,
	type MigrationSweepParams,
	type SweepResult,
} from "@/lib/sweep-migration";
import {
	canonicalOrdinalActions,
	executeOrdinalOperation,
	isOrdinalListed,
	type OrdinalActionSet,
	ordinalActionFailureMessage,
	ordinalAssetId,
} from "@/lib/wallet/ordinal-actions";

export const ASSET_TYPES = ["listings", "ordinals", "bsv21", "bsv"] as const;
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
	sweepMnee: boolean;
};

export function isListedOutput(output: TaggedOutput): boolean {
	if (output.tags?.includes("ordlock")) return true;
	if (
		output.events?.some(
			(event) =>
				event === "ordlock" ||
				event.startsWith("ordlock:") ||
				event.startsWith("list:"),
		)
	) {
		return true;
	}
	return (
		output.data !== null &&
		typeof output.data === "object" &&
		"ordlock" in output.data &&
		output.data.ordlock != null
	);
}

export function uniqueOutputs<T extends TaggedOutput>(outputs: T[]): T[] {
	return [
		...new Map(outputs.map((output) => [output.outpoint, output])).values(),
	];
}

export function listedFromWallet(outputs: WalletOutput[]): ListedAsset[] {
	return outputs.filter(isOrdinalListed).map((output) => ({
		outpoint: output.outpoint,
		id: ordinalAssetId(output),
		source: "wallet",
	}));
}

export function listedFromLegacy(outputs: TaggedOutput[]): ListedAsset[] {
	return uniqueOutputs(outputs)
		.filter(isListedOutput)
		.map((output) => ({
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
	mneeBalance: number;
}): MigrationPlan<T> {
	const listingsOn = input.types.has("listings");
	const listings = mergeListed(input.listings, []);
	const cancelable = new Set(
		listings
			.filter((item) => item.source === "wallet")
			.map((item) => item.outpoint),
	);
	const seen = new Set([
		...listings.map((item) => item.outpoint),
		...input.listedLegacyOutputs.map((output) => output.outpoint),
	]);
	const takeUnlisted = <O extends TaggedOutput>(outputs: O[]): O[] =>
		outputs.filter((output) => {
			if (seen.has(output.outpoint) || isListedOutput(output)) return false;
			seen.add(output.outpoint);
			return true;
		});
	return {
		cancel: listingsOn
			? listings.filter((item) => item.source === "wallet")
			: [],
		sweepListed: listingsOn
			? uniqueOutputs(input.listedLegacyOutputs).filter(
					(output) => !cancelable.has(output.outpoint),
				)
			: [],
		sweepOrdinals: input.types.has("ordinals")
			? takeUnlisted([...input.ordinals, ...input.opns])
			: [],
		sweepFunding: input.types.has("bsv") ? takeUnlisted(input.funding) : [],
		sweepBsv21: input.types.has("bsv21")
			? input.bsv21
					.map((token) => ({ ...token, outputs: takeUnlisted(token.outputs) }))
					.filter((token) => token.outputs.length > 0)
			: [],
		sweepMnee:
			input.mneeBalance > 0 &&
			(input.types.has("bsv21") || input.types.has("bsv")),
	};
}

export function plannedCount(plan: MigrationPlan): number {
	return (
		plan.cancel.length +
		plan.sweepListed.length +
		plan.sweepOrdinals.length +
		plan.sweepFunding.length +
		plan.sweepBsv21.reduce((sum, token) => sum + token.outputs.length, 0) +
		(plan.sweepMnee ? 1 : 0)
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
			} else if (result.txid?.trim()) {
				txids.push(result.txid);
			} else {
				errors.push(
					`Listing ${item.outpoint}: cancellation returned no transaction ID. Refresh and retry.`,
				);
			}
		} catch (error) {
			errors.push(
				`Listing ${item.outpoint}: ${ordinalActionFailureMessage(error)}`,
			);
		}
	}
	return { ok: errors.length === 0, txids, errors };
}

/** Cancel every displayed listing, independently of migration type selections. */
export async function delistMigrationListings(
	input: {
		ctx: OneSatContext;
		listings: ListedAsset[];
		legacyOutputs: IndexedOutput[];
		sweepParams: Omit<
			MigrationSweepParams,
			"funding" | "ordinals" | "bsv21Tokens" | "mneeBalance"
		> | null;
	},
	actions: OrdinalActionSet = canonicalOrdinalActions,
	sweep: typeof executeMigrationSweep = executeMigrationSweep,
): Promise<SweepResult & { completedOutpoints: string[] }> {
	const result: SweepResult & { completedOutpoints: string[] } = {
		bsvTxids: [],
		ordinalTxids: [],
		bsv21Txids: [],
		cancelTxids: [],
		errors: [],
		completedOutpoints: [],
	};
	if (input.listings.length === 0) {
		result.errors.push(
			"No listings were cancelled. Refresh the listing inventory before retrying.",
		);
		return result;
	}
	const legacyOutputs = new Map(
		input.legacyOutputs.map((output) => [output.outpoint, output]),
	);
	for (const item of mergeListed(input.listings, [])) {
		if (item.source === "wallet") {
			const cancelled = await cancelListedAssets(input.ctx, [item], actions);
			result.cancelTxids?.push(...cancelled.txids);
			result.errors.push(...cancelled.errors);
			if (cancelled.ok) result.completedOutpoints.push(item.outpoint);
			continue;
		}
		const output = legacyOutputs.get(item.outpoint);
		if (!output || !input.sweepParams) {
			result.errors.push(
				`Listing ${item.outpoint}: legacy cancellation is unavailable. Unlock your wallet and rescan before retrying.`,
			);
			continue;
		}
		try {
			// One listing per sweep gives each retry an exact confirmed outpoint.
			const swept = await sweep({
				...input.sweepParams,
				funding: [],
				ordinals: [output],
				bsv21Tokens: [],
				mneeBalance: 0,
			});
			result.ordinalTxids.push(...swept.ordinalTxids);
			result.errors.push(...swept.errors);
			if (swept.errors.length === 0) {
				if (swept.ordinalTxids.some((txid) => txid.trim())) {
					result.completedOutpoints.push(item.outpoint);
				} else {
					result.errors.push(
						`Listing ${item.outpoint}: cancellation returned no transaction ID. Refresh and retry.`,
					);
				}
			}
		} catch (error) {
			result.errors.push(
				`Listing ${item.outpoint}: ${ordinalActionFailureMessage(error)}`,
			);
		}
	}
	return result;
}

/** Complete selected cancellations before allowing the funding sweep to proceed. */
export async function executeMigrationPlan(
	input: {
		ctx: OneSatContext;
		plan: MigrationPlan<IndexedOutput>;
		listings: ListedAsset[];
		legacyOutputs: IndexedOutput[];
		sweepParams: Omit<
			MigrationSweepParams,
			"funding" | "ordinals" | "bsv21Tokens" | "mneeBalance"
		>;
		mneeBalance: number;
	},
	actions: OrdinalActionSet = canonicalOrdinalActions,
	sweep: typeof executeMigrationSweep = executeMigrationSweep,
): Promise<SweepResult & { completedOutpoints: string[] }> {
	const { plan } = input;
	const selected = mergeListed(plan.cancel, listedFromLegacy(plan.sweepListed));
	const selectedOutpoints = new Set(
		selected.map((listing) => listing.outpoint),
	);
	let result: SweepResult & { completedOutpoints: string[] } = {
		bsvTxids: [],
		ordinalTxids: [],
		bsv21Txids: [],
		cancelTxids: [],
		errors: [],
		completedOutpoints: [],
	};
	if (
		plan.sweepFunding.length > 0 &&
		input.listings.some((listing) => !selectedOutpoints.has(listing.outpoint))
	) {
		result.errors.push("Select listings or cancel them before sweeping funds.");
		return result;
	}
	if (selected.length > 0) {
		result = await delistMigrationListings(
			{ ...input, listings: selected },
			actions,
			sweep,
		);
		if (result.errors.length > 0) return result;
	}
	if (
		plan.sweepFunding.length ||
		plan.sweepOrdinals.length ||
		plan.sweepBsv21.length ||
		plan.sweepMnee
	) {
		try {
			const swept = await sweep({
				...input.sweepParams,
				funding: plan.sweepFunding,
				ordinals: plan.sweepOrdinals,
				bsv21Tokens: plan.sweepBsv21,
				mneeBalance: plan.sweepMnee ? input.mneeBalance : 0,
			});
			result.bsvTxids.push(...swept.bsvTxids);
			result.ordinalTxids.push(...swept.ordinalTxids);
			result.bsv21Txids.push(...swept.bsv21Txids);
			result.cancelTxids?.push(...(swept.cancelTxids ?? []));
			result.errors.push(...swept.errors);
			result.mneeTxid = swept.mneeTxid;
		} catch (error) {
			result.errors.push(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return result;
}
