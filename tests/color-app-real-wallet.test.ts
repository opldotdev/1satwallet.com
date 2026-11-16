// A real toolbox Wallet on an in-memory IndexedDB, so the originator and name
// checks below are the wallet's own, not a fake's.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assetBasket, colorProtocolID } from "@bsv/color-permission-module";
import { KeyDeriver, PrivateKey } from "@bsv/sdk";
import {
	type PermissionsManagerConfig,
	StorageIdb,
	StorageProvider,
	Wallet,
	WalletPermissionsManager,
	WalletStorageManager,
} from "@bsv/wallet-toolbox-client";
import { parseBrowserOrigin, redirectOriginator } from "@/lib/cwi/types";
import { clearDiagnostics } from "@/lib/runtime-diagnostics";
import {
	ColorUnavailableToAppsError,
	createColorContext,
	createWalletColorModule,
} from "@/lib/wallet/color-module";
import {
	guardModuleIdentifiers,
	MisroutedModuleIdentifierError,
} from "@/lib/wallet/module-identifier-guard";

// The wallet's host in development, as window.location.host gives it.
const ADMIN = "localhost:3000";
const APP = "app.example.com";
const ASSET = `${"a".repeat(64)}_0`;
const BASKET = assetBasket(ASSET, "value");
const PROTOCOL = colorProtocolID(ASSET, "cHJlZml4", "c3VmZml4");
const SPEC_OP_CHANGE_BASKET =
	"b9184a72141e6a4d3d148c67a6d0ad92864a4d85290579ea5bef8bd62eb01b6f";

// The provider's prompt settings that matter here.
const CONFIG: PermissionsManagerConfig = {
	seekProtocolPermissionsForSigning: true,
	seekPermissionsForKeyLinkageRevelation: true,
	seekPermissionsForPublicKeyRevelation: false,
	seekBasketListingPermissions: false,
	seekPermissionWhenListingActionsByLabel: false,
	encryptWalletMetadata: true,
};

const originalError = console.error;
beforeEach(() => {
	console.error = () => {};
});
afterEach(() => {
	console.error = originalError;
	clearDiagnostics();
});

let databases = 0;
const realWallet = async () => {
	const keyDeriver = new KeyDeriver(PrivateKey.fromRandom());
	const local = new StorageIdb(
		StorageProvider.createStorageBaseOptions("test"),
	);
	await local.migrate(
		`color-app-real-wallet-${++databases}`,
		keyDeriver.identityKey,
	);
	await local.makeAvailable();
	const storage = new WalletStorageManager(keyDeriver.identityKey, local);
	await storage.makeAvailable();
	return new Wallet({ chain: "test", keyDeriver, storage });
};

/** The provider's wiring: color module, manager, guard, all on `admin`. */
const setup = async (admin = ADMIN) => {
	const wallet = await realWallet();
	const color = createWalletColorModule({
		wallet,
		chain: "test",
		adminOriginator: admin,
	});
	assert.ok(color);
	const manager = guardModuleIdentifiers(
		new WalletPermissionsManager(wallet, admin, {
			...CONFIG,
			permissionModules: { color: color.permissionModule },
		}),
		admin,
	);
	const prompts: string[] = [];
	for (const event of [
		"onProtocolPermissionRequested",
		"onBasketAccessRequested",
	] as const) {
		manager.bindCallback(event, async (request) => {
			prompts.push(event);
			await manager.denyPermission(request.requestID);
		});
	}
	return { wallet, manager, prompts };
};

describe("the admin originator against a real wallet", () => {
	it("the wallet refuses a full origin and accepts a host with a port", async () => {
		const wallet = await realWallet();
		await assert.rejects(
			wallet.listOutputs({ basket: "tokens" }, "http://localhost:3000"),
			/canonical DNS hostname with an optional port/,
		);
		const listed = await wallet.listOutputs({ basket: "tokens" }, ADMIN);
		assert.equal(listed.totalOutputs, 0);
	});

	it("the color context reaches the wallet as the admin", async () => {
		const { manager } = await setup();
		const ctx = createColorContext(manager, {
			adminOriginator: ADMIN,
			chain: "test",
		});
		const listed = await ctx.wallet.listOutputs({ basket: BASKET });
		assert.equal(listed.totalOutputs, 0);
		const key = await ctx.wallet.getPublicKey({
			protocolID: PROTOCOL,
			keyID: "color",
			counterparty: "self",
		});
		assert.match(key.publicKey, /^0[23][0-9a-f]{64}$/);
	});

	it("an app on another localhost port is not the admin to 1Color", async () => {
		const relayed = parseBrowserOrigin("http://localhost:3001");
		assert.equal(relayed?.originator, "localhost");
		const { manager } = await setup();
		await assert.rejects(
			manager.listOutputs({ basket: BASKET }, "localhost"),
			ColorUnavailableToAppsError,
		);
		await assert.rejects(
			manager.getPublicKey(
				{ protocolID: PROTOCOL, keyID: "color", counterparty: "self" },
				"localhost",
			),
			ColorUnavailableToAppsError,
		);
	});
});

describe("admin-only baskets against a real wallet", () => {
	it("the wallet resolves padded and uppercase spellings, so apps are refused them", async () => {
		const { wallet, manager, prompts } = await setup();
		// The wallet reads both as the admin-only names.
		const padded = await wallet.listOutputs({ basket: " default" }, APP);
		assert.equal(padded.totalOutputs, 0);
		await assert.rejects(
			wallet.listOutputs({ basket: SPEC_OP_CHANGE_BASKET.toUpperCase() }, APP),
			/basket namespace as the first tag/,
		);
		// The manager alone stops only the exact spelling.
		await assert.rejects(
			manager.listOutputs({ basket: "default" }, APP),
			/admin-only/,
		);
		for (const basket of [
			" default",
			"Default",
			SPEC_OP_CHANGE_BASKET.toUpperCase(),
			` ${SPEC_OP_CHANGE_BASKET}`,
		]) {
			await assert.rejects(
				manager.listOutputs({ basket, tags: ["p color"] }, APP),
				(error: unknown) =>
					error instanceof MisroutedModuleIdentifierError &&
					error.reason === "not-canonical",
			);
		}
		assert.deepEqual(prompts, []);
		const own = await manager.listOutputs({ basket: "default" }, ADMIN);
		assert.equal(own.totalOutputs, 0);
	});
});

describe("key linkage for reserved protocols against a real wallet", () => {
	it("refuses an app without a prompt and serves the wallet itself", async () => {
		const { manager, prompts } = await setup();
		const counterparty = PrivateKey.fromRandom().toPublicKey().toString();
		const reveal = (name: string, originator: string) =>
			manager.revealSpecificKeyLinkage(
				{
					counterparty,
					verifier: counterparty,
					protocolID: [2, name],
					keyID: "color",
				},
				originator,
			);
		for (const name of [PROTOCOL[1], "admin keys"]) {
			await assert.rejects(reveal(name, APP), {
				name: "MisroutedModuleIdentifierError",
				reason: "reserved-linkage",
			});
		}
		assert.deepEqual(prompts, []);
		await assert.rejects(reveal("todo list", APP), /denied/i);
		assert.deepEqual(prompts, ["onProtocolPermissionRequested"]);
		const own = await reveal(PROTOCOL[1], ADMIN);
		assert.ok(own.encryptedLinkage.length > 0);
	});
});

describe("redirect requests run as the app's host", () => {
	it("passes a host the wallet accepts and never the wallet's own", async () => {
		assert.equal(
			redirectOriginator("https://app.example.com", "1satwallet.com"),
			APP,
		);
		assert.equal(
			redirectOriginator("https://app.example.com:8443", "1satwallet.com"),
			APP,
		);
		assert.equal(
			redirectOriginator("https://1satwallet.com", "1satwallet.com"),
			null,
		);
		assert.equal(
			redirectOriginator("https://1SATWALLET.com:8443", "1satwallet.com"),
			null,
		);
		assert.equal(redirectOriginator("http://localhost:3001", ADMIN), null);
		assert.equal(redirectOriginator("http://app.example.com", ADMIN), null);
		assert.equal(redirectOriginator("not a url", ADMIN), null);

		const wallet = await realWallet();
		await assert.rejects(
			wallet.listOutputs({ basket: "tokens" }, "https://app.example.com"),
			/canonical DNS hostname/,
		);
		const originator = redirectOriginator(
			"https://app.example.com",
			"1satwallet.com",
		);
		assert.ok(originator);
		const listed = await wallet.listOutputs({ basket: "tokens" }, originator);
		assert.equal(listed.totalOutputs, 0);
	});
});
