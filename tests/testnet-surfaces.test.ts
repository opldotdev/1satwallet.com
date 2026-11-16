import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isRouteAvailableOn, walletTabsFor } from "../lib/chain-surfaces";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const HIDDEN_ON_TESTNET = [
	"/activity",
	"/market/ordinals",
	"/market/ordinals/my-listings",
	"/market/bsv21",
	"/market/bsv21/abc_0",
	"/opns",
	"/opns/name?x=1",
	"/inscribe",
	"/wallet/opns",
	"/wallet/migrate",
];

describe("testnet surfaces", () => {
	it("lists wallet tabs per chain", () => {
		assert.deepEqual(
			walletTabsFor("main").map((tab) => tab.value),
			[
				"overview",
				"ordinals",
				"opns",
				"identity",
				"certificates",
				"bsv21",
				"history",
			],
		);
		assert.deepEqual(
			walletTabsFor("test").map((tab) => tab.value),
			[
				"overview",
				"ordinals",
				"identity",
				"certificates",
				"bsv21",
				"1color",
				"history",
			],
		);
	});

	it("hides Market, OpNS, Inscribe and migration on testnet only", () => {
		for (const href of HIDDEN_ON_TESTNET) {
			assert.equal(isRouteAvailableOn("main", href), true, href);
			assert.equal(isRouteAvailableOn("test", href), false, href);
		}
		for (const href of [
			"/",
			"/wallet",
			"/wallet/bsv21",
			"/wallet/history",
			"/wallet/settings",
			"/settings",
			"/docs",
			"/marketing",
			"/opnsx",
		]) {
			assert.equal(isRouteAvailableOn("test", href), true, href);
		}
	});

	it("filters every navigation surface by chain", () => {
		assert.match(
			read("components/wallet/wallet-tabs.tsx"),
			/walletTabsFor\(useWalletChain\(\)\)/,
		);
		const sidebar = read("components/left-sidebar.tsx");
		assert.match(sidebar, /isRouteAvailableOn\(chain, item\.url\)/);
		assert.match(sidebar, /groups\.map\(/);
		const shortcuts = read("components/keyboard-shortcuts.tsx");
		assert.match(shortcuts, /isRouteAvailableOn\(chain, command\.href\)/);
		assert.match(
			shortcuts,
			/if \(isRouteAvailableOn\(chain, href\)\) router\.push/,
		);
		assert.doesNotMatch(
			shortcuts.slice(
				shortcuts.indexOf("switch (key)"),
				shortcuts.indexOf('} else if (key === "g")'),
			),
			/router\.push\(/,
		);
	});

	it("guards direct visits to every hidden route", () => {
		for (const dir of [
			"activity",
			"market",
			"opns",
			"inscribe",
			"wallet/opns",
			"wallet/migrate",
		]) {
			const layout = join("app/(main)", dir, "layout.tsx");
			assert.ok(existsSync(join(process.cwd(), layout)), layout);
			assert.match(read(layout), /<MainnetOnly>\{children\}<\/MainnetOnly>/);
		}
		assert.match(
			read("components/not-on-testnet.tsx"),
			/Not available on testnet/,
		);
	});

	it("runs the wallet on the saved chain and re-initializes on a switch", () => {
		const layout = read("app/layout.tsx");
		assert.match(layout, /<WalletChainProvider>/);
		assert.doesNotMatch(layout, /<WalletToolboxProvider/);
		const provider = read("providers/wallet-chain-provider.tsx");
		assert.match(
			provider,
			/<WalletToolboxProvider key=\{chain\} chain=\{chain\}>/,
		);
		assert.match(provider, /queryClient\.clear\(\)/);
	});

	it("syncs messages from the chain's messagebox", () => {
		const engine = read("providers/hooks/use-sync-engine.ts");
		assert.match(engine, /endpointsOf\(chain\)/);
		assert.match(engine, /syncMessages\.execute\(ctx, \{ messageboxUrl \}\)/);
	});

	it("shows a testnet badge and faucet link in the wallet header", () => {
		const header = read("components/wallet/wallet-header.tsx");
		assert.match(header, /chain === "test"/);
		assert.match(header, /Testnet/);
		assert.match(header, /href=\{faucet\}/);
	});

	it("refreshes the testnet notice once the wallet is on mainnet", () => {
		assert.match(
			read("app/(main)/not-on-testnet/page.tsx"),
			/NotOnTestnetRoute/,
		);
		const route = read("components/not-on-testnet-route.tsx");
		assert.match(route, /readWalletChain\(\) === "main"/);
		assert.match(route, /router\.refresh\(\)/);
		assert.match(route, /subscribeWalletChain\(refreshOnMainnet\)/);
	});

	it("never offers a legacy key address on testnet", () => {
		assert.match(
			read("components/app-sidebar.tsx"),
			/isExternal \|\| chain === "test" \? "" : identityAddress \|\| payAddress/,
		);
	});
});
