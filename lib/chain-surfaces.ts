import { type Chain, isOneColorAvailable } from "@/lib/chain-endpoints";

/**
 * Routes that read or write mainnet-only services (markets and market
 * activity, OpNS, legacy migration). Testnet hides every way to reach them.
 * Inscribing stays: the testnet stack serves ordfs, which is all it needs.
 */
const MAINNET_ONLY_ROUTES = [
	"/activity",
	"/market",
	"/opns",
	"/wallet/opns",
	"/wallet/migrate",
	"/wallet/sweep",
] as const;

/** 1Color routes: only on a chain with a color overlay (testnet today). */
const ONE_COLOR_ROUTES = ["/wallet/1color"] as const;

/** Whether `href` (query and hash ignored) is `route` or a path under it. */
const isUnder = (href: string, route: string) => {
	const path = href.split(/[?#]/, 1)[0];
	return path === route || path.startsWith(`${route}/`);
};

const isOneColorRoute = (href: string) =>
	ONE_COLOR_ROUTES.some((route) => isUnder(href, route));

export function isRouteAvailableOn(chain: Chain, href: string): boolean {
	if (!isOneColorAvailable(chain) && isOneColorRoute(href)) return false;
	if (chain === "main") return true;
	return !MAINNET_ONLY_ROUTES.some((route) => isUnder(href, route));
}

/**
 * Where a page the chain lacks sends the visitor, when it has a home there:
 * 1Color's pages go to Tokens, so a chain without 1Color never shows one.
 * Null for a page the chain has, and for a mainnet-only page on testnet,
 * which keeps its address and gets the static notice instead.
 */
export function unavailableRouteRedirect(
	chain: Chain,
	href: string,
): string | null {
	return !isOneColorAvailable(chain) && isOneColorRoute(href)
		? "/wallet/tokens"
		: null;
}

/**
 * The wallet's sections, in tab order. Tokens holds every fungible token
 * standard the chain has: BSV-21 everywhere, 1Color where it has an overlay.
 */
export const WALLET_TABS = [
	{ value: "overview", label: "Wallet", href: "/wallet" },
	{ value: "ordinals", label: "Ordinals", href: "/wallet/ordinals" },
	{ value: "tokens", label: "Tokens", href: "/wallet/tokens" },
	{ value: "opns", label: "OpNS", href: "/wallet/opns" },
	{ value: "identity", label: "Identity", href: "/wallet/identity" },
	{
		value: "certificates",
		label: "Certificates",
		href: "/wallet/certificates",
	},
	{ value: "history", label: "History", href: "/wallet/history" },
] as const;

export type WalletTabValue = (typeof WALLET_TABS)[number]["value"];

export const walletTabsFor = (chain: Chain) =>
	WALLET_TABS.filter((tab) => isRouteAvailableOn(chain, tab.href));
