import type { Chain } from "@/lib/chain-endpoints";
import {
	WALLET_TABS,
	type WalletTabValue,
	walletTabsFor,
} from "@/lib/chain-surfaces";

/** What the wallet chrome shows above a page: its headline, back arrow and tabs. */
export interface WalletSection {
	/** The page's h1: the tab's own label on a section, the page name on a sub-page. */
	title: string;
	/** Sub-pages only: where the back arrow goes. */
	parentHref?: string;
	/** The name of `parentHref`, for the back arrow's label. */
	parentTitle?: string;
	/** Sections show the tab bar; sub-pages do not. */
	showTabs: boolean;
	/** The tab to mark as current, when the chain has it. */
	tab?: WalletTabValue;
}

interface SubPage {
	/** The route; it also covers every path under it. */
	path: string;
	title: string;
	parentHref?: string;
	parentTitle?: string;
}

/**
 * Pages under /wallet that are not sections: they take a back arrow and no
 * tab bar. The most specific path comes first.
 */
const SUB_PAGES: readonly SubPage[] = [
	{
		path: "/wallet/create/",
		title: "Create wallet",
		parentHref: "/wallet/create",
		parentTitle: "Create wallet",
	},
	{
		path: "/wallet/create",
		title: "Create wallet",
		parentHref: "/wallet",
		parentTitle: "Wallet",
	},
	{
		path: "/wallet/import/",
		title: "Import wallet",
		parentHref: "/wallet/import",
		parentTitle: "Import wallet",
	},
	{
		path: "/wallet/import",
		title: "Import wallet",
		parentHref: "/wallet",
		parentTitle: "Wallet",
	},
	{
		path: "/wallet/settings",
		title: "Wallet settings",
		parentHref: "/settings",
		parentTitle: "Settings",
	},
	{
		path: "/wallet/permissions",
		title: "Connected apps",
		parentHref: "/wallet/settings",
		parentTitle: "Wallet settings",
	},
	{
		path: "/wallet/diagnostics",
		title: "Diagnostics",
		parentHref: "/wallet/settings",
		parentTitle: "Wallet settings",
	},
	{
		path: "/wallet/delete",
		title: "Delete wallet",
		parentHref: "/wallet/settings",
		parentTitle: "Wallet settings",
	},
	{
		path: "/wallet/migrate",
		title: "Wallet migration",
		parentHref: "/wallet",
		parentTitle: "Wallet",
	},
	{
		path: "/wallet/bsv21/",
		title: "BSV21 token",
		parentHref: "/wallet/bsv21",
		parentTitle: "BSV21",
	},
	// An app's request: nothing to go back to, and no tabs to wander off by.
	{ path: "/wallet/cwi", title: "Authorize request" },
];

const under = (pathname: string, path: string) =>
	path.endsWith("/")
		? pathname.startsWith(path) && pathname.length > path.length
		: pathname === path || pathname.startsWith(`${path}/`);

/**
 * One spelling per route: no trailing slash ("/wallet/" is "/wallet").
 * Every lookup here expects a path normalised by this.
 */
export function normalizeWalletPath(pathname: string): string {
	return pathname.replace(/\/+$/, "") || "/";
}

/** The sub-page `pathname` is on, or null on a section. */
export function walletSubPageFor(pathname: string): SubPage | null {
	return SUB_PAGES.find((page) => under(pathname, page.path)) ?? null;
}

type Tab = (typeof WALLET_TABS)[number];

/**
 * The tab whose section `pathname` is in. The overview owns /wallet itself
 * only, so an unknown /wallet/* path marks no tab.
 */
export function activeWalletTab<T extends Tab>(
	pathname: string,
	tabs: readonly T[],
): T | undefined {
	return tabs.find((tab) =>
		tab.href === "/wallet" ? pathname === "/wallet" : under(pathname, tab.href),
	);
}

/** The headline, back arrow and tab bar for `pathname` on `chain`. */
export function walletSectionFor(
	pathname: string,
	chain: Chain,
): WalletSection {
	const path = normalizeWalletPath(pathname);
	const sub = walletSubPageFor(path);
	if (sub) {
		return {
			title: sub.title,
			parentHref: sub.parentHref,
			parentTitle: sub.parentTitle,
			showTabs: false,
		};
	}
	// A section the chain lacks (OpNS on testnet) still names itself; its
	// page explains why it is empty, and no tab is marked.
	const section = activeWalletTab(path, WALLET_TABS);
	const tab = activeWalletTab(path, walletTabsFor(chain));
	return {
		title: section?.label ?? "Wallet",
		showTabs: true,
		tab: tab?.value,
	};
}

/** A section page's document title, from the same label as its tab. */
export function walletSectionTitle(value: WalletTabValue): string {
	const tab = WALLET_TABS.find((t) => t.value === value);
	if (!tab) throw new Error(`Unknown wallet section "${value}"`);
	return `${tab.label} - 1Sat`;
}

/** A sub-page's document title, from the same title as its headline. */
export function walletSubPageTitle(path: string): string {
	const page = walletSubPageFor(normalizeWalletPath(path));
	if (!page) throw new Error(`"${path}" is not a wallet sub-page`);
	return `${page.title} - 1Sat`;
}
