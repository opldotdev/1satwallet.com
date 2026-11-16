import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PromptRequest } from "@1sat/permission-module";
import { InMemoryPermissionStore } from "@1sat/wallet-browser";
import {
	assetBasket,
	ColorConsentDeclinedError,
	ColorPermissionModule,
} from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import { WalletPermissionsManager } from "@bsv/wallet-toolbox-client";
import type { Chain } from "@/lib/chain-endpoints";
import {
	createColorContext,
	createWalletColorModule,
} from "@/lib/wallet/color-module";
import { withOriginator } from "@/lib/wallet/with-originator";

const ADMIN = "1satwallet.com";
const APP = "app.example.com";
const ASSET = `${"a".repeat(64)}_0`;

type Call = { method: string; args: unknown; originator?: string };

/** The raw wallet the manager wraps: records calls, answers empty listings. */
const fakeWallet = () => {
	const calls: Call[] = [];
	const wallet = {
		async listOutputs(args: unknown, originator?: string) {
			calls.push({ method: "listOutputs", args, originator });
			return { totalOutputs: 0, outputs: [] };
		},
	} as unknown as WalletInterface;
	return { wallet, calls };
};

const managerFor = (chain: Chain) => {
	const raw = fakeWallet();
	const prompts: PromptRequest[] = [];
	const color = createWalletColorModule({
		wallet: raw.wallet,
		chain,
		adminOriginator: ADMIN,
		promptHandler: async (request) => {
			prompts.push(request);
			return false;
		},
		permissionStore: new InMemoryPermissionStore(),
	});
	const manager = new WalletPermissionsManager(raw.wallet, ADMIN, {
		permissionModules: color ? { color: color.module } : {},
	});
	return { raw, color, manager, prompts };
};

const listAssetBasket = (manager: WalletInterface, originator: string) =>
	manager.listOutputs({ basket: assetBasket(ASSET, "value") }, originator);

describe("1Color module registration", () => {
	it("is created on testnet with the chain's color overlay", async () => {
		const { color } = managerFor("test");
		assert.ok(color);
		assert.ok(color.module instanceof ColorPermissionModule);
		assert.equal(
			await color.overlay.resolveOrigin(ASSET),
			"https://testnet.openex.dev",
		);
	});

	it("is absent on mainnet, so p color stays unsupported", async () => {
		const { color, manager, raw } = managerFor("main");
		assert.equal(color, null);
		await assert.rejects(
			listAssetBasket(manager, ADMIN),
			/Unsupported P-module scheme: p color/,
		);
		assert.equal(raw.calls.length, 0);
	});
});

describe("1Color consent", () => {
	it("lets the admin read a p color basket through the manager", async () => {
		const { manager, raw } = managerFor("test");
		const result = await listAssetBasket(manager, ADMIN);
		assert.equal(result.totalOutputs, 0);
		assert.equal(raw.calls.length, 1);
		assert.equal(raw.calls[0].originator, ADMIN);
	});

	it("asks the user for an app, and a decline stops it before the raw wallet", async () => {
		const { manager, raw, prompts } = managerFor("test");
		await assert.rejects(
			listAssetBasket(manager, APP),
			ColorConsentDeclinedError,
		);
		assert.deepEqual(
			prompts.map((prompt) => [prompt.kind, prompt.originator]),
			[["basketAccess", APP]],
		);
		assert.equal(raw.calls.length, 0);
	});

	it("the color context runs as the admin through the manager", async () => {
		const { manager, raw } = managerFor("test");
		const ctx = createColorContext(manager, {
			adminOriginator: ADMIN,
			chain: "test",
		});
		assert.equal(ctx.chain, "test");
		await ctx.wallet.listOutputs({ basket: assetBasket(ASSET, "value") });
		assert.equal(raw.calls.length, 1);
		assert.equal(raw.calls[0].originator, ADMIN);
	});
});

describe("withOriginator", () => {
	it("fills a missing originator and keeps an explicit one", async () => {
		const raw = fakeWallet();
		const bound = withOriginator(raw.wallet, ADMIN);
		await bound.listOutputs({ basket: "x" });
		await bound.listOutputs({ basket: "x" }, undefined);
		await bound.listOutputs({ basket: "x" }, APP);
		assert.deepEqual(
			raw.calls.map((c) => c.originator),
			[ADMIN, ADMIN, APP],
		);
	});
});

describe("wallet provider color wiring", () => {
	const source = readFileSync(
		join(process.cwd(), "providers/wallet-toolbox-provider.tsx"),
		"utf8",
	);
	const init = source.slice(
		source.indexOf("const initializeWallet"),
		source.indexOf("// -- Wallet destroy --"),
	);

	it("registers color with the asset modules and tracks it for dispose", () => {
		assert.match(
			init,
			/createWalletColorModule\(\{[\s\S]*chain,[\s\S]*adminOriginator: ADMIN_ORIGINATOR,\s*promptHandler: requestAssetPermission,/,
		);
		assert.match(
			init,
			/color\s*\?\s*\{ \.\.\.assetPermissionModules, color: color\.module \}\s*:\s*assetPermissionModules/,
		);
		assert.match(
			init,
			/pendingPermissionModules = Object\.values\(permissionModules\)/,
		);
		assert.match(init, /permissionModules,\n/);
		assert.match(
			init,
			/assetPermissionModulesRef\.current = pendingPermissionModules/,
		);
	});

	it("disposes every registered module on teardown and on a failed init", () => {
		const teardown = source.slice(
			source.indexOf("const teardownWallet"),
			source.indexOf("const teardown = (async"),
		);
		assert.match(
			teardown,
			/for \(const module of assetPermissionModulesRef\.current\)\s*module\.dispose\(\)/,
		);
		assert.match(
			init,
			/catch \{\s*for \(const module of pendingPermissionModules\) module\.dispose\(\)/,
		);
	});

	it("exposes the color context and overlay only for a built-in testnet wallet", () => {
		assert.match(
			source,
			/if \(!permissionsManager \|\| !colorOverlay \|\| connectionMode !== "built-in"\)\s*return null;/,
		);
		assert.match(source, /setColorOverlay\(color\?\.overlay \?\? null\)/);
		assert.match(source, /colorOverlay: colorContext \? colorOverlay : null/);
	});

	it("restores the built-in manager and overlay when switching back from an external wallet", () => {
		assert.match(
			init,
			/localPermissionsRef\.current = \{\s*manager: wpm,\s*colorOverlay: color\?\.overlay \?\? null,\s*\}/,
		);
		const embedded = source.slice(
			source.indexOf("const switchWallet"),
			source.indexOf(
				"setIsInitializing(true);",
				source.indexOf("const switchWallet"),
			),
		);
		assert.match(
			embedded,
			/const localPermissions = localPermissionsRef\.current;[\s\S]*if \(!local \|\| !localPermissions/,
		);
		assert.match(
			embedded,
			/setPermissionsManager\(localPermissions\.manager\);\s*setColorOverlay\(localPermissions\.colorOverlay\);[\s\S]*setConnectionMode\("built-in"\)/,
		);
		const teardown = source.slice(
			source.indexOf("const teardownWallet"),
			source.indexOf("const teardown = (async"),
		);
		assert.match(
			teardown,
			/walletResultRef\.current = null;\s*localPermissionsRef\.current = null;/,
		);
	});

	it("restores the built-in identity and receive addresses when switching back", () => {
		assert.match(
			init,
			/localReceiveRef\.current = \{\s*identityKey: newIdentityKey,\s*addressManager: receiveResult\.addressManager,\s*state: receiveResult\.state,\s*\}/,
		);
		const rotation = source.slice(
			source.indexOf("const _handleQueuedOutpoint"),
			source.indexOf(
				"saveReceiveAddressState({ chain, identityKey }, advanced.state)",
			),
		);
		assert.match(
			rotation,
			/if \(localReceiveRef\.current\?\.identityKey === identityKey\) \{\s*localReceiveRef\.current = \{\s*identityKey,\s*addressManager: advanced\.addressManager,\s*state: advanced\.state,/,
		);
		const embedded = source.slice(
			source.indexOf("const switchWallet"),
			source.indexOf(
				"setIsInitializing(true);",
				source.indexOf("const switchWallet"),
			),
		);
		assert.match(
			embedded,
			/if \(!local \|\| !localPermissions \|\| !localReceive\)/,
		);
		for (const restore of [
			/addressManagerRef\.current = addressManager;/,
			/receiveStateRef\.current = state;/,
			/setIdentityKey\(localReceive\.identityKey\);/,
			/setReceiveAddressIndex\(state\.currentIndex\);/,
			/setDepositAddress\(getDepositAddress\(addressManager, state\) \|\| null\);/,
			/setReceiveAddresses\(getActiveReceiveAddresses\(addressManager, state\)\);/,
			/setTrackedAddresses\(addressManager\.getAddresses\(\)\);/,
			/setLastRotationOutpoint\(state\.lastRotationOutpoint \?\? null\);/,
			/setAddressManagerReady\(true\);/,
		]) {
			assert.match(embedded, restore);
		}
		const teardown = source.slice(
			source.indexOf("const teardownWallet"),
			source.indexOf("const teardown = (async"),
		);
		assert.match(
			teardown,
			/localPermissionsRef\.current = null;\s*localReceiveRef\.current = null;/,
		);
	});

	it("uses the wallet's host, the form the toolbox accepts, as the admin", () => {
		assert.match(
			source,
			/const ADMIN_ORIGINATOR =\s*typeof window !== "undefined" \? window\.location\.host : "1satwallet\.com";/,
		);
		assert.doesNotMatch(source, /location\.origin/);
	});

	it("guards the manager it exposes to apps against misrouted p names", () => {
		assert.match(
			init,
			/const wpm = guardModuleIdentifiers\(\s*new WalletPermissionsManager\(result\.wallet, ADMIN_ORIGINATOR, \{[\s\S]*?\}\),\s*ADMIN_ORIGINATOR,\s*\);/,
		);
		assert.doesNotMatch(source, /setPermissionsManager\(new /);
	});

	it("destroy and unmount wait out a pending teardown first", () => {
		const destroy = source.slice(
			source.indexOf("const destroyWallet"),
			source.indexOf("const disconnectExternalWallet"),
		);
		assert.match(
			destroy,
			/while \(teardownPromiseRef\.current\) await teardownPromiseRef\.current;\s*await teardownWallet\("disconnected"\);/,
		);
		const unmount = source.slice(source.indexOf("const unmountWallet"));
		assert.match(
			unmount,
			/while \(teardownPromiseRef\.current\) await teardownPromiseRef\.current;\s*await teardownWallet\("disconnected", \{ keepConnection: true \}\);/,
		);
		assert.match(
			source,
			/useEffect\(\(\) => \(\) => void unmountWallet\(\), \[unmountWallet\]\);/,
		);
	});

	it("dispose clears the module's in-memory state", () => {
		const { color } = managerFor("test");
		assert.ok(color);
		const module = color.module as unknown as {
			selected: Set<string>;
			dispose: () => void;
		};
		module.selected.add(`${"b".repeat(64)}.0`);
		module.dispose();
		assert.equal(module.selected.size, 0);
		module.dispose();
	});
});
