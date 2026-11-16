import type { WalletInterface } from "@bsv/sdk";
import type { Chain } from "@/lib/chain-endpoints";

const NETWORK_OF: Record<Chain, string> = { main: "mainnet", test: "testnet" };

/**
 * Asks a connected external wallet for its network. Returns null when it
 * matches the selected chain, else the message to show before disconnecting.
 * A wallet that cannot answer counts as mainnet, so wallets without
 * getNetwork keep working on mainnet; only an explicit mismatch is rejected.
 */
export async function externalNetworkMismatch(
	wallet: Partial<Pick<WalletInterface, "getNetwork">>,
	chain: Chain,
): Promise<string | null> {
	let network: string = "mainnet";
	try {
		const reported = (await wallet.getNetwork?.({}))?.network;
		if (reported) network = reported;
	} catch {
		network = "mainnet";
	}
	if (network === NETWORK_OF[chain]) return null;
	if (network === "mainnet" || network === "testnet") {
		return `This wallet is on ${network}. Switch the network in Wallet settings or use another wallet.`;
	}
	return "This wallet reported an unknown network. Use another wallet.";
}
