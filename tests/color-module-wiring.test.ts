import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	assetBasket,
	ColorConsentDeclinedError,
	ColorPermissionModule,
} from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import { WalletPermissionsManager } from "@bsv/wallet-toolbox-client";
import type { Chain } from "@/lib/chain-endpoints";
import {
	adminOnlyTokenAccess,
	createColorContext,
	createWalletColorModule,
} from "@/lib/wallet/color-module";
import { withOriginator } from "@/lib/wallet/with-originator";

const ADMIN = "https://1satwallet.com";
const APP = "https://app.example.com";
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
	const color = createWalletColorModule({
		wallet: raw.wallet,
		chain,
		requestTokenAccess: adminOnlyTokenAccess(ADMIN),
	});
	const manager = new WalletPermissionsManager(raw.wallet, ADMIN, {
		permissionModules: color ? { color: color.module } : {},
	});
	return { raw, color, manager };
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

describe("1Color consent (admin only)", () => {
	it("approves the wallet itself and declines every other originator", async () => {
		const access = adminOnlyTokenAccess(ADMIN);
		const message = JSON.stringify({ type: "color_send" });
		assert.equal(await access(ADMIN, message), true);
		assert.equal(await access(APP, message), false);
		assert.equal(await access("", message), false);
	});

	it("lets the admin read a p color basket through the manager", async () => {
		const { manager, raw } = managerFor("test");
		const result = await listAssetBasket(manager, ADMIN);
		assert.equal(result.totalOutputs, 0);
		assert.equal(raw.calls.length, 1);
		assert.equal(raw.calls[0].originator, ADMIN);
	});

	it("declines an app before the raw wallet is reached", async () => {
		const { manager, raw } = managerFor("test");
		await assert.rejects(
			listAssetBasket(manager, APP),
			ColorConsentDeclinedError,
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
			/createWalletColorModule\(\{[\s\S]*chain,[\s\S]*adminOnlyTokenAccess\(ADMIN_ORIGINATOR\)/,
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
