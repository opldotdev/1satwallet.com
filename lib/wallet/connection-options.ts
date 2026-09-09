import type { ConnectWalletResult } from "@1sat/connect";
import { WalletClient } from "@bsv/sdk";

export type WalletConnectionOption = "injected" | "desktop" | "embedded";
const substrates = {
	injected: "window.CWI",
	desktop: "json-api",
	embedded: "react-native",
} as const;

export function createConnectionClient(option: WalletConnectionOption) {
	return new WalletClient(substrates[option]);
}

/** Discovery never requests authentication or the user's identity. */
export async function isConnectionAvailable(
	option: WalletConnectionOption,
	createClient = createConnectionClient,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const client = createClient(option);
		const result = await Promise.race([
			client.getVersion({}),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 1500);
			}),
		]);
		return !!result && typeof result.version === "string";
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Connect exactly the option the user chose; do not race other wallets. */
export async function connectSelectedWallet(
	option: WalletConnectionOption,
	createClient = createConnectionClient,
): Promise<ConnectWalletResult> {
	const wallet = createClient(option);
	await wallet.connectToSubstrate();
	await wallet.waitForAuthentication({});
	const { publicKey } = await wallet.getPublicKey({ identityKey: true });
	return {
		wallet,
		identityKey: publicKey,
		provider: option,
		disconnect: () => {},
	};
}
