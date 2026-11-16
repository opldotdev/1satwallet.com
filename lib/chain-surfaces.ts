import { type Chain, isOneColorAvailable } from "@/lib/chain-endpoints";

/**
 * Routes that read or write mainnet-only services (markets and market
 * activity, OpNS, inscribing, legacy migration). Testnet hides every way to
 * reach them.
 */
const MAINNET_ONLY_ROUTES = [
	"/activity",
	"/market",
	"/opns",
	"/inscribe",
	"/wallet/opns",
	"/wallet/migrate",
] as const;

/** 1Color routes: only on a chain with a color overlay (testnet today). */
const ONE_COLOR_ROUTES = ["/wallet/1color"] as const;

export function isRouteAvailableOn(chain: Chain, href: string): boolean {
	const path = href.split(/[?#]/, 1)[0];
	const under = (route: string) =>
		path === route || path.startsWith(`${route}/`);
	if (!isOneColorAvailable(chain) && ONE_COLOR_ROUTES.some(under)) return false;
	if (chain === "main") return true;
	return !MAINNET_ONLY_ROUTES.some(under);
}

export const WALLET_TABS = [
	{ value: "overview", label: "Wallet", href: "/wallet" },
	{ value: "ordinals", label: "Ordinals", href: "/wallet/ordinals" },
	{ value: "opns", label: "OpNS", href: "/wallet/opns" },
	{ value: "identity", label: "Identity", href: "/wallet/identity" },
	{
		value: "certificates",
		label: "Certificates",
		href: "/wallet/certificates",
	},
	{ value: "bsv21", label: "BSV21", href: "/wallet/bsv21" },
	{ value: "1color", label: "1Color", href: "/wallet/1color" },
	{ value: "history", label: "History", href: "/wallet/history" },
] as const;

export type WalletTabValue = (typeof WALLET_TABS)[number]["value"];

export const walletTabsFor = (chain: Chain) =>
	WALLET_TABS.filter((tab) => isRouteAvailableOn(chain, tab.href));
