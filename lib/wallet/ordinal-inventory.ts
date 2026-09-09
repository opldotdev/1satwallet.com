import {
	listOrdinals,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";

/** Leftover Yours / theme-token basket names. Preferred inventory is `1sat`. */
export const LEGACY_ORDINAL_BASKETS = ["p 1sat ordinals", "ordinals"] as const;

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
