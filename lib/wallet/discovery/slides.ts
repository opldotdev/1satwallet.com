import type { WalletCandidate } from "./discovery";
import { canReachLocalWallet, type DevicePlatform } from "./platform";

export type Slide =
	| { key: string; kind: "candidate"; candidate: WalletCandidate }
	| { key: "local"; kind: "local" }
	| { key: "phone-app"; kind: "phone-app" }
	| { key: "browser"; kind: "browser" };

/**
 * What the first screen offers, in order: wallets the scan found, then the
 * 1Sat Wallet app that fits this device, then a wallet in this browser, then
 * any other desktop wallet.
 */
export function walletSlides(
	platform: DevicePlatform | null,
	candidates: WalletCandidate[],
): Slide[] {
	const found: Slide[] = candidates.map((candidate) => ({
		key: `${candidate.adapter}:${candidate.option}`,
		kind: "candidate",
		candidate,
	}));
	const slides = [...found];
	const hasLocal = candidates.some(({ adapter }) => adapter === "loopback");
	const searchLocal =
		platform !== null && canReachLocalWallet(platform) && !hasLocal;
	// The 1Sat Wallet apps come first where one exists for this device; a
	// computer with no 1Sat app (Windows, Linux) leads with this browser.
	if (platform === "ios") slides.push({ key: "phone-app", kind: "phone-app" });
	if (searchLocal && platform === "mac") {
		slides.push({ key: "local", kind: "local" });
	}
	slides.push({ key: "browser", kind: "browser" });
	if (searchLocal && platform !== "mac") {
		slides.push({ key: "local", kind: "local" });
	}
	return slides;
}
