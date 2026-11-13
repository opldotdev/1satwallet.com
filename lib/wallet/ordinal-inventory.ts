import {
	listOrdinals,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";

/**
 * Older wallets filed ordinals in these baskets. Nothing moves them now
 * (wallet-toolbox rejects re-filing an output into another basket), so the
 * inventory keeps reading them alongside the preferred `1sat` basket.
 */
export const LEGACY_ORDINAL_BASKETS = ["p 1sat ordinals", "ordinals"];

export function mergeWalletOutputs(groups: WalletOutput[][]): WalletOutput[] {
	const seen = new Set<string>();
	return groups.flatMap((outputs) =>
		outputs.filter((output) => {
			if (seen.has(output.outpoint)) return false;
			seen.add(output.outpoint);
			return true;
		}),
	);
}

export async function listOrdinalInventory(
	ctx: OneSatContext,
): Promise<WalletOutput[]> {
	const preferred = await listOrdinals.execute(ctx, {});
	const legacy = await Promise.all(
		LEGACY_ORDINAL_BASKETS.map((basket) =>
			ctx.wallet
				.listOutputs({
					basket,
					includeTags: true,
					includeCustomInstructions: true,
				})
				.then((result) => result.outputs)
				.catch(() => [] as WalletOutput[]),
		),
	);
	return mergeWalletOutputs([preferred.outputs, ...legacy]);
}
