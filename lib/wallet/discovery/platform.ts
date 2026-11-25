/**
 * Which 1Sat Wallet app fits this device. A page cannot tell whether an app is
 * installed (iOS gives web pages no such API, and getInstalledRelatedApps only
 * sees Android and Windows apps), so this only decides which app to offer.
 */
export type DevicePlatform = "ios" | "android" | "mac" | "desktop";

type NavigatorLike = {
	userAgent: string;
	maxTouchPoints?: number;
};

export function detectPlatform(nav?: NavigatorLike): DevicePlatform {
	const target =
		nav ?? (typeof navigator === "undefined" ? undefined : navigator);
	if (!target) return "desktop";
	const ua = target.userAgent;
	if (/iPhone|iPad|iPod/.test(ua)) return "ios";
	// iPadOS asks for desktop sites with a Mac user agent; touch gives it away.
	if (/Macintosh/.test(ua) && (target.maxTouchPoints ?? 0) > 1) return "ios";
	if (/Android/.test(ua)) return "android";
	if (/Macintosh|Mac OS X/.test(ua)) return "mac";
	return "desktop";
}

/** Phones reach a wallet by app, not by localhost (BRC-325 section 11.5). */
export function canReachLocalWallet(platform: DevicePlatform): boolean {
	return platform === "mac" || platform === "desktop";
}
