import type { DisconnectReason } from "@1sat/connect";
import { WalletClient } from "@bsv/sdk";

export type WalletConnectionStatus =
	| "no-wallet"
	| "authorization-required"
	| "provider-error"
	| "locked"
	| "authenticating"
	| "ready"
	| "disconnected";

const NO_WALLET_MESSAGE =
	"No BRC-100 wallet responded. Open 1Sat Wallet Desktop, enable a compatible extension, or use an embedded wallet browser and try again.";
const AUTHORIZATION_REQUIRED_MESSAGE =
	"A BRC-100 wallet responded, but it did not grant identity access to 1satwallet.com. Unlock or approve the request in your wallet, then try again.";
const PROVIDER_ERROR_MESSAGE =
	"A BRC-100 wallet responded and is unlocked, but it failed while providing its identity key. This is a wallet/provider error; update or restart the wallet, then try again.";

export type WalletConnectionProbeResult =
	| { state: "unreachable" }
	| { state: "authorization-required" }
	| { state: "identity-ready" }
	| { state: "provider-error"; code?: string };

function walletErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const candidate = error as { code?: unknown; name?: unknown };
	const value =
		typeof candidate.code === "string"
			? candidate.code
			: typeof candidate.name === "string" && candidate.name !== "Error"
				? candidate.name
				: undefined;
	return value?.match(/^[A-Z][A-Z0-9_]{2,39}$/)?.[0];
}

function isPermissionError(error: unknown): boolean {
	const code = walletErrorCode(error);
	return code === "ERR_PERMISSION_DENIED" || code === "WERR_UNAUTHORIZED";
}

async function probeWalletReachability(): Promise<WalletConnectionProbeResult> {
	const wallet = new WalletClient("auto");
	try {
		await wallet.connectToSubstrate();
		await wallet.getVersion({});
	} catch {
		return { state: "unreachable" };
	}

	try {
		const { authenticated } = await wallet.isAuthenticated({});
		if (!authenticated) return { state: "authorization-required" };
		const { publicKey } = await wallet.getPublicKey({ identityKey: true });
		if (!/^(02|03)[0-9a-fA-F]{64}$/.test(publicKey)) {
			return { state: "provider-error", code: "INVALID_IDENTITY_KEY" };
		}
		return { state: "identity-ready" };
	} catch (error) {
		if (isPermissionError(error)) {
			return { state: "authorization-required" };
		}
		return { state: "provider-error", code: walletErrorCode(error) };
	}
}

export async function diagnoseNoWalletResult(
	probe: () => Promise<WalletConnectionProbeResult> = probeWalletReachability,
): Promise<{
	status: "no-wallet" | "authorization-required" | "provider-error";
	message: string;
}> {
	const result = await probe().catch(
		(): WalletConnectionProbeResult => ({ state: "unreachable" }),
	);
	if (result.state === "unreachable") {
		return { status: "no-wallet", message: NO_WALLET_MESSAGE };
	}
	if (result.state === "authorization-required") {
		return {
			status: "authorization-required",
			message: AUTHORIZATION_REQUIRED_MESSAGE,
		};
	}
	const code = result.state === "provider-error" ? result.code : undefined;
	return {
		status: "provider-error",
		message: code
			? `${PROVIDER_ERROR_MESSAGE} (${code})`
			: PROVIDER_ERROR_MESSAGE,
	};
}

export function statusAfterDisconnect(
	reason: DisconnectReason,
): WalletConnectionStatus {
	return reason === "unauthenticated" ? "locked" : "disconnected";
}
