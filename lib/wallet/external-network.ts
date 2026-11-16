import type { WalletInterface } from "@bsv/sdk";
import type { Chain } from "@/lib/chain-endpoints";

export const UNKNOWN_EXTERNAL_NETWORK =
	"This wallet reported an unknown network. Use another wallet.";
export const EXTERNAL_NETWORK_CHANGED =
	"This wallet changed network while connecting. Try again.";

/**
 * The chain a connected external wallet runs on, which becomes the active
 * chain. A wallet that cannot answer counts as mainnet, so wallets without
 * getNetwork keep working; only an explicitly unknown network is rejected.
 */
export async function externalWalletChain(
	wallet: Partial<Pick<WalletInterface, "getNetwork">>,
): Promise<{ chain: Chain } | { error: string }> {
	let network: string | undefined;
	try {
		network = (await wallet.getNetwork?.({}))?.network;
	} catch (error) {
		console.warn(
			"[external-network] getNetwork failed; treating the wallet as mainnet",
			error,
		);
		return { chain: "main" };
	}
	if (!network || network === "mainnet") return { chain: "main" };
	if (network === "testnet") return { chain: "test" };
	console.error("[external-network] unknown network reported", network);
	return { error: UNKNOWN_EXTERNAL_NETWORK };
}
