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
const realWallet = async () => (await realWalletWithStorage()).wallet;

const realWalletWithStorage = async () => {
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
	const wallet = new Wallet({ chain: "test", keyDeriver, storage });
	return { wallet, local, identityKey: keyDeriver.identityKey };
};

/**
 * Write completed actions straight into the wallet's storage: each with its
 * labels and one output per basket, as the wallet would list them.
 */
const seedActions = async (
	local: StorageIdb,
	identityKey: string,
	actions: { labels: string[]; baskets: string[] }[],
) => {
	const { user } = await local.findOrInsertUser(identityKey);
	const now = new Date();
	const stamp = { created_at: now, updated_at: now };
	const baskets = new Map<string, number>();
	const labels = new Map<string, number>();
	const basketId = async (name: string) => {
		const known = baskets.get(name);
		if (known !== undefined) return known;
		const id = await local.insertOutputBasket({
			...stamp,
			basketId: 0,
			userId: user.userId,
			name,
			numberOfDesiredUTXOs: 0,
			minimumDesiredUTXOValue: 0,
			isDeleted: false,
		});
		baskets.set(name, id);
		return id;
	};
	const labelId = async (label: string) => {
		const known = labels.get(label);
		if (known !== undefined) return known;
		const id = await local.insertTxLabel({
			...stamp,
			txLabelId: 0,
			userId: user.userId,
			label,
			isDeleted: false,
		});
		labels.set(label, id);
		return id;
	};
	const txids: string[] = [];
	for (const [index, action] of actions.entries()) {
		const txid = (index + 1).toString(16).padStart(64, "0");
		txids.push(txid);
		const transactionId = await local.insertTransaction({
			...stamp,
			transactionId: 0,
			userId: user.userId,
			status: "completed",
			reference: `ref-${index}`,
			isOutgoing: true,
			satoshis: 1,
			description: `action ${index}`,
			txid,
			version: 1,
			lockTime: 0,
		});
		for (const label of action.labels)
			await local.insertTxLabelMap({
				...stamp,
				txLabelId: await labelId(label),
				transactionId,
				isDeleted: false,
			});
		for (const [vout, basket] of action.baskets.entries())
			await local.insertOutput({
				...stamp,
				outputId: 0,
				userId: user.userId,
				transactionId,
				basketId: await basketId(basket),
				spendable: true,
				change: false,
				outputDescription: "out",
				vout,
				satoshis: 1,
				providedBy: "you",
				purpose: "",
				type: "custom",
				txid,
				lockingScript: [0x51],
			});
	}
	return txids;
};

/** The provider's wiring: color module, manager, guard, all on `admin`. */
const setup = async (admin = ADMIN) => {
	const { wallet, local, identityKey } = await realWalletWithStorage();
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
	return { wallet, manager, prompts, local, identityKey };
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

describe("args that are not a plain object against a real wallet", () => {
	it("refuses array-shaped args before the manager reads them", async () => {
		const { manager, prompts } = await setup();
		const counterparty = PrivateKey.fromRandom().toPublicKey().toString();
		const misrouted = `P${PROTOCOL[1].slice(1)}`;
		for (const call of [
			manager.listOutputs(
				Object.assign([], { basket: " default" }) as never,
				APP,
			),
			manager.listOutputs(
				Object.assign([], { basket: `P${BASKET.slice(1)}` }) as never,
				APP,
			),
			manager.getPublicKey(
				Object.assign([], {
					protocolID: [PROTOCOL[0], misrouted],
					keyID: "color",
					counterparty: "self",
				}) as never,
				APP,
			),
			manager.revealSpecificKeyLinkage(
				Object.assign([], {
					counterparty,
					verifier: counterparty,
					protocolID: PROTOCOL,
					keyID: "color",
				}) as never,
				APP,
			),
			manager.listActions(
				Object.assign([], { labels: [], includeLabels: true }) as never,
				APP,
			),
		]) {
			await assert.rejects(call, {
				name: "MisroutedModuleIdentifierError",
				reason: "not-an-object",
				field: "args",
			});
		}
		assert.deepEqual(prompts, []);
	});
});

describe("an app's listActions against a real wallet", () => {
	it("hides 1Color, keeps p nosend, and pages over visible actions", async () => {
		const { manager, local, identityKey } = await setup();
		const txids = await seedActions(local, identityKey, [
			{ labels: ["p color plan x"], baskets: [BASKET] },
			{ labels: ["mylabel"], baskets: ["tokens"] },
			{ labels: ["mylabel"], baskets: ["tokens", BASKET] },
			{ labels: ["mylabel", "p color plan x"], baskets: ["tokens"] },
			{ labels: ["p nosend expiry never", "mylabel"], baskets: ["tokens"] },
			{ labels: [], baskets: [BASKET] },
		]);
		const own = await manager.listActions({ labels: [] }, ADMIN);
		assert.equal(own.totalActions, 6);

		const all = await manager.listActions(
			{ labels: [], includeLabels: true, includeOutputs: true },
			APP,
		);
		assert.equal(all.totalActions, 4);
		assert.deepEqual(
			all.actions.map((action) => [
				action.txid,
				// The wallet adds a "reference …" label of its own.
				action.labels?.filter((label) => !label.startsWith("reference ")),
				action.outputs?.map((output) => output.basket),
			]),
			[
				[txids[1], ["mylabel"], ["tokens"]],
				[txids[2], ["mylabel"], ["tokens"]],
				[txids[4], ["mylabel", "p nosend expiry never"], ["tokens"]],
				[txids[5], [], []],
			],
		);

		const pages: string[][] = [];
		for (let offset = 0; offset < 5; offset++) {
			const page = await manager.listActions(
				{ labels: [], offset, limit: 1 },
				APP,
			);
			assert.equal(page.totalActions, 4);
			pages.push(page.actions.map((action) => action.txid));
		}
		assert.deepEqual(pages, [
			[txids[1]],
			[txids[2]],
			[txids[4]],
			[txids[5]],
			[],
		]);
		const byLabel = await manager.listActions({ labels: ["mylabel"] }, APP);
		assert.equal(byLabel.totalActions, 3);
		assert.equal(byLabel.actions[0].labels, undefined);
	});
});
