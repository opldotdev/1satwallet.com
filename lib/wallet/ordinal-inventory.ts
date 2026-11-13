import {
	listOrdinals,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";

/**
 * Wallet ordinals inventory. On the built-in wallet the context also reads
 * the legacy ordinal baskets (see `LEGACY_BASKETS`).
 */
export async function listOrdinalInventory(
	ctx: OneSatContext,
): Promise<WalletOutput[]> {
	const { outputs } = await listOrdinals.execute(ctx, {});
	return outputs;
}
