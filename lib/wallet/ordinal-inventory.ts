import {
	listOrdinals,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";
import { LEGACY_P1SAT_BASKET_MIGRATIONS, ONESAT_BASKET } from "@1sat/types";
import { LEFTOVER_ORDINALS_BASKET } from "@/lib/wallet/legacy-basket-migrate";

export const LEGACY_ORDINAL_BASKETS = [
	...new Set([
		...LEGACY_P1SAT_BASKET_MIGRATIONS.filter(
			(migration) => migration.to === ONESAT_BASKET,
		).map((migration) => migration.from),
		LEFTOVER_ORDINALS_BASKET,
	]),
];

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
