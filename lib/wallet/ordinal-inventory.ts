import {
	listOrdinals,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";

const PAGE = 100;

/**
 * Wallet ordinals inventory, every page. On the built-in wallet the context
 * also reads the legacy ordinal baskets (see `LEGACY_BASKETS`).
 */
export async function listOrdinalInventory(
	ctx: OneSatContext,
): Promise<WalletOutput[]> {
	const outputs: WalletOutput[] = [];
	for (;;) {
		const page = await listOrdinals.execute(ctx, {
			limit: PAGE,
			offset: outputs.length,
		});
		outputs.push(...page.outputs);
		if (
			page.outputs.length < PAGE ||
			outputs.length >= (page.totalOutputs ?? 0)
		) {
			return outputs;
		}
	}
}
