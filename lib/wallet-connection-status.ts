import type { DisconnectReason } from "@1sat/connect";
import { WalletClient } from "@bsv/sdk";

export type WalletConnectionStatus =
	| "no-wallet"
	| "authorization-required"
	| "locked"
	| "authenticating"
	| "ready"
	| "disconnected";

const NO_WALLET_MESSAGE =
	"No BRC-100 wallet responded. Open 1Sat Wallet Desktop, enable a compatible extension, or use an embedded wallet browser and try again.";
const AUTHORIZATION_REQUIRED_MESSAGE =
	"A BRC-100 wallet responded, but it did not grant identity access to 1satwallet.com. Unlock or approve the request in your wallet, then try again.";

async function probeWalletReachability(): Promise<void> {
	const wallet = new WalletClient("auto");
	await wallet.connectToSubstrate();
	await wallet.getVersion({});
}

export async function diagnoseNoWalletResult(
	probe: () => Promise<void> = probeWalletReachability,
): Promise<{
	status: "no-wallet" | "authorization-required";
	message: string;
}> {
	try {
		await probe();
		return {
			status: "authorization-required",
			message: AUTHORIZATION_REQUIRED_MESSAGE,
		};
	} catch {
		return { status: "no-wallet", message: NO_WALLET_MESSAGE };
	}
}

export function statusAfterDisconnect(
	reason: DisconnectReason,
): WalletConnectionStatus {
	return reason === "unauthenticated" ? "locked" : "disconnected";
}
