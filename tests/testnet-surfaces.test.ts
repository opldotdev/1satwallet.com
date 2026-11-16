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
		const notice = read("components/not-on-testnet.tsx");
		assert.match(notice, /Not available on testnet/);
		assert.doesNotMatch(notice, /\/wallet\/settings/);
	});

	it("runs the wallet on the account's chain and re-initializes when it changes", () => {
		const layout = read("app/layout.tsx");
		assert.match(layout, /<WalletChainProvider>/);
		assert.doesNotMatch(layout, /<WalletToolboxProvider/);
		const provider = read("providers/wallet-chain-provider.tsx");
		assert.match(
			provider,
			/<WalletToolboxProvider key=\{chain\} chain=\{chain\}>/,
		);
		assert.match(provider, /queryClient\.clear\(\)/);
		assert.match(provider, /takeLegacyTestnetNotice\(\)/);
		assert.match(provider, /This wallet is on Mainnet/);
	});

	it("has no manual network switch in settings", () => {
		const settings = read("components/wallet/wallet-settings-form.tsx");
		assert.doesNotMatch(settings, /writeWalletChain/);
		assert.doesNotMatch(settings, /SelectItem value="test"/);
		assert.doesNotMatch(settings, /Switch network/);
		assert.doesNotMatch(settings, /AlertDialog/);
		assert.match(settings, /It cannot be changed\./);
		assert.match(settings, /Reported by the connected wallet\./);
		assert.match(settings, /<TestnetBadge \/>/);
	});

	it("chooses the network once, at create and import", () => {
		const create = read("app/(main)/wallet/create/encrypt/page.tsx");
		assert.match(
			create,
			/<NetworkChoice value=\{network\} onChange=\{setNetwork\} \/>/,
		);
		assert.match(create, /createWallet\(mnemonic, passphrase, network\)/);
		const importPage = read("app/(main)/wallet/import/passphrase/page.tsx");
		assert.match(importPage, /<NetworkChoice/);
		assert.match(importPage, /importWallet\(walletKeys, passphrase, network\)/);
		assert.match(importPage, /finalNetwork,\s*\)/);
		assert.match(importPage, /Set by this backup\./);
		// Mainnet needs nothing from the person; a mainnet backup shows no line.
		assert.match(importPage, /fixedNetwork === "main" \? null/);
		const choice = read("components/wallet/network-choice.tsx");
		// Testnet sits behind a collapsed developer option, closed by default
		// unless testnet is already selected or a note explains a preselection.
		assert.match(choice, /Developer options/);
		assert.match(choice, /useState\(false\)/);
		assert.match(choice, /opened \|\| value === "test" \|\| Boolean\(note\)/);
		assert.match(choice, /onChange\(checked \? "test" : "main"\)/);
	});

	it("syncs messages from the chain's messagebox", () => {
		const engine = read("providers/hooks/use-sync-engine.ts");
		assert.match(engine, /endpointsOf\(chain\)/);
		assert.match(engine, /syncMessages\.execute\(ctx, \{ messageboxUrl \}\)/);
	});

	it("shows a testnet badge and faucet link in the wallet header", () => {
		const header = read("components/wallet/wallet-header.tsx");
		assert.match(header, /chain === "test"/);
		assert.match(header, /<TestnetBadge \/>/);
		assert.match(header, /href=\{faucet\}/);
		assert.match(
			read("components/wallet/testnet-badge.tsx"),
			/Testnet account\. Coins have no real value\./,
		);
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

	it("renders no chain-specific 1Color notice before the client knows the chain", () => {
		const grid = read("components/wallet/one-color-grid.tsx");
		assert.match(
			grid,
			/useSyncExternalStore\(\s*noSubscription,\s*\(\) => true,\s*\(\) => false,\s*\)/,
		);
		assert.doesNotMatch(grid, /Switch the network/);
		assert.doesNotMatch(grid, /\/wallet\/settings/);
		assert.match(grid, /this wallet is a mainnet\s+account\./);
		const loaderAt = grid.indexOf("if (!mounted) return <OneColorLoading");
		assert.ok(loaderAt > 0);
		assert.ok(loaderAt < grid.indexOf("if (!isOneColorAvailable(chain))"));
	});

	it("drops cached 1Color holdings when the wallet identity changes", () => {
		const provider = read("providers/wallet-toolbox-provider.tsx");
		const clear = provider.slice(
			provider.indexOf("const clearIdentityQueries"),
			provider.indexOf("const resetWalletState"),
		);
		assert.match(clear, /removeQueries\(\{ queryKey: \["one-color"\] \}\)/);
	});

	it("never offers a legacy key address on testnet", () => {
		assert.match(
			read("components/app-sidebar.tsx"),
			/isExternal \|\| chain === "test" \? "" : identityAddress \|\| payAddress/,
		);
	});
});

describe("an account on another network replacing this one", () => {
	it("lands an import on /wallet even after the chain remount", () => {
		const page = read("app/(main)/wallet/import/passphrase/page.tsx");
		const effect = page.slice(
			page.indexOf("useEffect(() => {"),
			page.indexOf("}, [hasWallet, walletKeys, encryptedBackup, router]);"),
		);
		assert.ok(effect.length > 0);
		// A saved wallet wins over the empty import state the remount leaves.
		assert.ok(
			effect.indexOf('router.replace("/wallet")') <
				effect.indexOf('router.replace("/wallet/import")'),
		);
		assert.match(
			effect,
			/if \(hasWallet\) \{\s*router\.replace\("\/wallet"\);/,
		);
		assert.match(
			read("app/(main)/wallet/import/page.tsx"),
			/if \(hasWallet\) router\.replace\("\/wallet"\)/,
		);
		// The restore error is mapped, never echoed.
		assert.doesNotMatch(page, /err\.message/);
		assert.match(
			page,
			/backupRestoreErrorMessage\(failure, requiresPassword\)/,
		);
	});

	it("keeps the toaster outside the chain remount", () => {
		const layout = read("app/layout.tsx");
		const toaster = layout.indexOf("<Toaster");
		assert.ok(toaster > layout.indexOf("</WalletChainProvider>"));
		assert.ok(toaster > layout.indexOf("</WalletProvider>"));
		assert.ok(toaster < layout.indexOf("</QueryProvider>"));
		assert.ok(layout.indexOf("<ThemeProvider") < toaster);
	});

	it("drops unlocked keys when another tab clears storage", () => {
		const source = read("providers/wallet-provider.tsx");
		const handler = source.slice(
			source.indexOf("const handleStorageChange"),
			source.indexOf('window.addEventListener("storage"'),
		);
		assert.match(
			handler,
			/walletChangedElsewhere\(event, window\.localStorage\)/,
		);
		assert.match(handler, /if \(exists !== undefined\)/);
		const remove = source.slice(
			source.indexOf("const deleteWallet"),
			source.indexOf("const value = useMemo"),
		);
		// A refused StorageEvent cannot skip the chain refresh or the reset.
		assert.match(remove, /try \{\s*window\.dispatchEvent\(\s*new StorageEvent/);
		assert.ok(
			remove.indexOf("refreshWalletChain()") > remove.indexOf("} catch {"),
		);
		assert.match(remove, /setHasWallet\(false\)/);
	});

	it("opens the built-in wallet only on its own account's chain", () => {
		const provider = read("providers/wallet-toolbox-provider.tsx");
		const init = provider.slice(
			provider.indexOf("const initializeWallet = useCallback"),
			provider.indexOf(
				"const generation",
				provider.indexOf("const initializeWallet = useCallback"),
			),
		);
		assert.match(init, /const storedNetwork = storedAccountNetwork\(\);/);
		assert.match(init, /if \(storedNetwork !== chain\) \{/);
		// An unreadable stored wallet says so instead of failing silently.
		assert.match(init, /storedNetwork === null && hasStoredWallet\(\)/);
		assert.match(init, /setInitError\(/);
		assert.match(init, /refreshWalletChain\(\);\s*return false;/);
		assert.match(init, /operation: "wallet\.initialize\.chain"/);
	});

	it("forgets a network hop whenever a connection fails or a switch starts", () => {
		const provider = read("providers/wallet-toolbox-provider.tsx");
		const fail = provider.slice(
			provider.indexOf("const failConnection"),
			provider.indexOf("// -- Receive address state --"),
		);
		assert.match(fail, /setExternalHop\(null\)/);
		const switcher = provider.slice(
			provider.indexOf("const switchWallet"),
			provider.indexOf('if (option === "embedded")'),
		);
		assert.match(switcher, /setExternalHop\(null\)/);
		// A failed reconnect after a switch moved the chain never claims the
		// old wallet is still in place.
		const connect = provider.slice(
			provider.indexOf("const connectExternal = useCallback"),
			provider.indexOf("const connectExternalWallet = useCallback"),
		);
		assert.match(connect, /resume && externalHop\(\) === "switch"/);
		assert.doesNotMatch(connect, /unchanged/);
		assert.equal(
			(connect.match(/failConnection\(\s*afterSwitchHop\(/g) ?? []).length,
			3,
		);
		assert.match(provider, /setExternalHop\("switch"\)/);
		assert.match(
			provider,
			/SWITCH_HOP_FAILED =\s*"The wallet switch did not finish, and the wallet you were using was disconnected\."/,
		);
	});
});
