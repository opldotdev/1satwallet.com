import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WALLET_TABS, walletTabsFor } from "../lib/chain-surfaces";
import {
	activeWalletTab,
	walletSectionFor,
	walletSectionTitle,
	walletSubPageFor,
} from "../lib/wallet-sections";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("walletSectionFor", () => {
	it("heads every section with its tab's own label and marks that tab", () => {
		for (const chain of ["main", "test"] as const) {
			for (const tab of walletTabsFor(chain)) {
				assert.deepEqual(walletSectionFor(tab.href, chain), {
					title: tab.label,
					showTabs: true,
					tab: tab.value,
				});
			}
		}
	});

	it("keeps a section's tab current on paths under it and with a trailing slash", () => {
		assert.equal(walletSectionFor("/wallet/history/", "main").tab, "history");
		assert.equal(
			walletSectionFor("/wallet/ordinals/x", "main").tab,
			"ordinals",
		);
		assert.equal(walletSectionFor("/wallet/", "main").tab, "overview");
	});

	it("names a section the chain lacks but marks no tab", () => {
		assert.deepEqual(walletSectionFor("/wallet/opns", "test"), {
			title: "OpNS",
			showTabs: true,
			tab: undefined,
		});
		assert.equal(walletSectionFor("/wallet/opns", "main").tab, "opns");
	});

	it("never marks the overview for another /wallet path", () => {
		assert.equal(walletSectionFor("/wallet/nope", "main").tab, undefined);
		assert.equal(
			activeWalletTab("/wallet/identity", walletTabsFor("main"))?.value,
			"identity",
		);
		assert.equal(activeWalletTab("/walletx", WALLET_TABS), undefined);
	});

	it("gives sub-pages a back arrow and no tabs", () => {
		const cases: [string, string, string, string][] = [
			["/wallet/settings", "Wallet settings", "/settings", "Settings"],
			["/wallet/create", "Create wallet", "/wallet", "Wallet"],
			[
				"/wallet/create/confirm",
				"Create wallet",
				"/wallet/create",
				"Create wallet",
			],
			[
				"/wallet/create/encrypt",
				"Create wallet",
				"/wallet/create",
				"Create wallet",
			],
			["/wallet/import", "Import wallet", "/wallet", "Wallet"],
			[
				"/wallet/import/json",
				"Import wallet",
				"/wallet/import",
				"Import wallet",
			],
			[
				"/wallet/import/mnemonic",
				"Import wallet",
				"/wallet/import",
				"Import wallet",
			],
			[
				"/wallet/import/passphrase",
				"Import wallet",
				"/wallet/import",
				"Import wallet",
			],
			[
				"/wallet/permissions",
				"Connected apps",
				"/wallet/settings",
				"Wallet settings",
			],
			[
				"/wallet/diagnostics",
				"Diagnostics",
				"/wallet/settings",
				"Wallet settings",
			],
			[
				"/wallet/delete",
				"Delete wallet",
				"/wallet/settings",
				"Wallet settings",
			],
			["/wallet/migrate", "Wallet migration", "/wallet", "Wallet"],
			["/wallet/1color/abc_0", "1Color token", "/wallet/1color", "1Color"],
			["/wallet/bsv21/abc_0", "BSV21 token", "/wallet/bsv21", "BSV21"],
		];
		for (const [path, title, parentHref, parentTitle] of cases) {
			for (const chain of ["main", "test"] as const) {
				assert.deepEqual(
					walletSectionFor(path, chain),
					{ title, parentHref, parentTitle, showTabs: false },
					`${path} on ${chain}`,
				);
			}
		}
	});

	it("shows an app's request with no tabs and nowhere to go back to", () => {
		assert.deepEqual(walletSectionFor("/wallet/cwi/authorize", "main"), {
			title: "Authorize request",
			parentHref: undefined,
			parentTitle: undefined,
			showTabs: false,
		});
	});

	it("keeps the 1Color and BSV21 lists as sections, their tokens as sub-pages", () => {
		assert.equal(walletSubPageFor("/wallet/1color"), null);
		assert.equal(walletSubPageFor("/wallet/bsv21"), null);
		assert.equal(walletSectionFor("/wallet/1color", "test").tab, "1color");
		assert.equal(
			walletSubPageFor("/wallet/1color/abc_0")?.title,
			"1Color token",
		);
	});

	it("titles each section's document with its tab label", () => {
		assert.equal(walletSectionTitle("overview"), "Wallet - 1Sat");
		assert.equal(walletSectionTitle("history"), "History - 1Sat");
		assert.throws(
			() => walletSectionTitle("nope" as "history"),
			/Unknown wallet section "nope"/,
		);
	});
});

describe("wallet chrome", () => {
	it("renders the tabs as links in a labelled navigation", () => {
		const tabs = read("components/wallet/wallet-tabs.tsx");
		assert.match(tabs, /<nav aria-label="Wallet sections">/);
		assert.match(tabs, /aria-current=\{current \? "page" : undefined\}/);
		assert.match(tabs, /<Link/);
		assert.doesNotMatch(tabs, /TabsTrigger|router\.push/);
		// Phones label only the current tab; the rest stay named for readers.
		assert.match(tabs, /!current && "max-sm:sr-only"/);
		assert.match(tabs, /inline: "center"/);
		assert.match(tabs, /if \(hidden\) return null;/);
	});

	it("styles the tabs calmly: sans, 44px, brand underline without a glow", () => {
		const css = read("components/wallet/wallet-tabs.module.css");
		assert.match(css, /font-family: var\(--font-sans\)/);
		assert.doesNotMatch(css, /font-mono/);
		assert.match(css, /min-width: 44px;\s*min-height: 44px;/);
		assert.match(css, /scrollbar-width: none/);
		assert.match(css, /height: 2px;[\s\S]*background: var\(--brand\)/);
		assert.doesNotMatch(css, /box-shadow: 0 0/);
		assert.match(
			css,
			/\[data-more-after\][\s\S]*calc\(100% - 16px\), transparent/,
		);
	});

	it("heads the page with the section and drops the tagline", () => {
		const header = read("components/wallet/wallet-header.tsx");
		assert.match(header, /walletSectionFor\(usePathname\(\), chain\)/);
		assert.match(header, /<PageTitle[^>]*>\{section\.title\}<\/PageTitle>/);
		assert.match(header, /aria-label=\{`Back to \$\{section\.parentTitle\}`\}/);
		assert.doesNotMatch(header, /at a glance/);
		// The connection is a dot with a screen-reader label; Lock and
		// Disconnect are icons on phones.
		assert.match(header, /<span className="sr-only">\{label\}<\/span>/);
		assert.match(header, /<span className="max-md:sr-only">Lock<\/span>/);
		assert.match(header, /<span className="max-md:sr-only">Disconnect<\/span>/);
	});

	it("drops the hand-built back headers the wallet header now draws", () => {
		for (const page of ["settings", "permissions", "diagnostics"]) {
			const source = read(`app/(main)/wallet/${page}/page.tsx`);
			assert.doesNotMatch(source, /ArrowLeft|Back to/, page);
		}
	});

	it("exports a document title from every section page", () => {
		const pages: [string, string][] = [
			["page.tsx", "overview"],
			["ordinals/page.tsx", "ordinals"],
			["opns/page.tsx", "opns"],
			["identity/page.tsx", "identity"],
			["certificates/page.tsx", "certificates"],
			["bsv21/page.tsx", "bsv21"],
			["history/page.tsx", "history"],
		];
		for (const [file, value] of pages) {
			const source = read(`app/(main)/wallet/${file}`);
			assert.doesNotMatch(source, /^"use client"/, file);
			assert.match(
				source,
				new RegExp(`title: walletSectionTitle\\("${value}"\\)`),
				file,
			);
		}
	});

	it("keeps the phone top bar 48px and opens the wallet panel with the wallet icon", () => {
		const shell = read("components/dual-sidebar-layout.tsx");
		assert.match(
			shell,
			/<header[^>]*max-md:h-\[calc\(--spacing\(12\)\+env\(safe-area-inset-top\)\)\]/,
		);
		assert.match(
			shell,
			/aria-label="Toggle wallet navigation"[\s\S]*<Wallet \/>/,
		);
		assert.doesNotMatch(shell, /SidebarTrigger/);
	});
});
