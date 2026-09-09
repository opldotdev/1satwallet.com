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

export class WalletSwitchError extends Error {
	readonly reason: "unavailable" | "connect-failed" | "identity-failed";

	constructor(
		reason: "unavailable" | "connect-failed" | "identity-failed",
		message: string,
	) {
		super(message);
		this.name = "WalletSwitchError";
		this.reason = reason;
	}
}

/** Probe and connect a target without touching the current wallet. */
export async function prepareWalletSwitch(
	target: Exclude<WalletConnectionOption, "embedded">,
	deps: {
		probe?: typeof isConnectionAvailable;
		connect?: typeof connectSelectedWallet;
	} = {},
): Promise<ConnectWalletResult> {
	const probe = deps.probe ?? isConnectionAvailable;
	const connect = deps.connect ?? connectSelectedWallet;
	if (!(await probe(target))) {
		throw new WalletSwitchError(
			"unavailable",
			`${target} wallet is not available`,
		);
	}
	try {
		return await connect(target);
	} catch (error) {
		const message = error instanceof Error ? error.message : "connect failed";
		if (/identit|public key/i.test(message)) {
			throw new WalletSwitchError(
				"identity-failed",
				"Connected, but identity could not be derived",
			);
		}
		throw new WalletSwitchError("connect-failed", message);
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
