import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	assetBasket,
	ColorConsentDeclinedError,
	colorProtocolID,
} from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import {
	type PermissionsManagerConfig,
	WalletPermissionsManager,
} from "@bsv/wallet-toolbox-client";
import {
	clearDiagnostics,
	getDiagnosticEvents,
} from "@/lib/runtime-diagnostics";
import { createWalletColorModule } from "@/lib/wallet/color-module";
import {
	findMisroutedModuleIdentifier,
	guardModuleIdentifiers,
	MisroutedModuleIdentifierError,
} from "@/lib/wallet/module-identifier-guard";

const ADMIN = "https://1satwallet.com";
const APP = "app.example.com";
const ASSET = `${"a".repeat(64)}_0`;
const BASKET = assetBasket(ASSET, "value");
const PROTOCOL = colorProtocolID(ASSET, "cHJlZml4", "c3VmZml4");
const PUBKEY = `02${"11".repeat(32)}`;

// Refusals are logged with console.error; keep it quiet and readable here,
// as tests/runtime-diagnostics.test.ts does.
const originalError = console.error;
let logged: unknown[][] = [];
beforeEach(() => {
	logged = [];
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
});
afterEach(() => {
	console.error = originalError;
	clearDiagnostics();
});

// The provider's prompt settings that matter here.
const CONFIG: PermissionsManagerConfig = {
	seekProtocolPermissionsForSigning: true,
	seekPermissionsForPublicKeyRevelation: false,
	seekBasketInsertionPermissions: true,
	seekBasketRemovalPermissions: true,
	seekBasketListingPermissions: false,
	seekPermissionWhenApplyingActionLabels: false,
	encryptWalletMetadata: true,
	seekSpendingPermissions: true,
	seekGroupedPermission: true,
};

type RawCall = { method: string; originator: unknown };

/**
 * A raw wallet that records every call and answers the few the manager needs;
 * a prompt of any kind is recorded and granted, so a test sees both.
 */
const setup = () => {
	const calls: RawCall[] = [];
	const wallet = new Proxy(
		{},
		{
			get:
				(_target, prop: string) =>
				async (_args: unknown, originator: unknown) => {
					calls.push({ method: prop, originator });
					if (prop === "listOutputs") return { totalOutputs: 0, outputs: [] };
					if (prop === "getPublicKey") return { publicKey: PUBKEY };
					if (prop === "encrypt") return { ciphertext: [1, 2, 3] };
					if (prop === "createSignature") return { signature: [1] };
					if (prop === "relinquishOutput") return { relinquished: true };
					if (prop === "internalizeAction") return { accepted: true };
					throw new Error(`raw ${prop} not faked`);
				},
		},
	) as WalletInterface;
	const color = createWalletColorModule({
		wallet,
		chain: "test",
		adminOriginator: ADMIN,
	});
	assert.ok(color);
	const manager = guardModuleIdentifiers(
		new WalletPermissionsManager(wallet, ADMIN, {
			...CONFIG,
			permissionModules: { color: color.permissionModule },
		}),
	);
	const prompts: string[] = [];
	for (const event of [
		"onProtocolPermissionRequested",
		"onBasketAccessRequested",
		"onSpendingAuthorizationRequested",
	] as const) {
		manager.bindCallback(event, async (request) => {
			prompts.push(event);
			await manager.grantPermission({
				requestID: request.requestID,
				ephemeral: true,
			});
		});
	}
	manager.bindCallback("onGroupedPermissionRequested", async (request) => {
		prompts.push("onGroupedPermissionRequested");
		await manager.denyGroupedPermission(request.requestID);
	});
	return { calls, color, manager, prompts };
};

const methods = (calls: RawCall[]) => calls.map((call) => call.method);

const variants = (name: string) => [
	`P${name.slice(1)}`,
	` ${name}`,
	`${name.toUpperCase()}`,
	` ${name}`,
];

describe("findMisroutedModuleIdentifier", () => {
	it("finds every field that the wallet lowercases into a p name", () => {
		const bad = "P color x";
		const cases: [unknown, string][] = [
			[{ basket: bad }, "basket"],
			[{ tags: ["ok", bad] }, "tags[1]"],
			[{ labels: [bad] }, "labels[0]"],
			[{ protocolID: [2, bad] }, "protocolID[1]"],
			[{ outputs: [{}, { basket: bad }] }, "outputs[1].basket"],
			[{ outputs: [{ tags: [bad] }] }, "outputs[0].tags[0]"],
			[
				{ outputs: [{ insertionRemittance: { basket: bad } }] },
				"outputs[0].insertionRemittance.basket",
			],
			[
				{ outputs: [{ insertionRemittance: { basket: "b", tags: [bad] } }] },
				"outputs[0].insertionRemittance.tags[0]",
			],
		];
		for (const [args, field] of cases) {
			assert.deepEqual(findMisroutedModuleIdentifier(args), {
				field,
				value: bad,
				prefix: "p ",
			});
		}
	});

	it("finds names the wallet lowercases into the reserved admin namespace", () => {
		const cases: [unknown, string, string][] = [
			[{ basket: "Admin foo" }, "basket", "Admin foo"],
			[{ basket: " admin foo" }, "basket", " admin foo"],
			[
				{ labels: ["ok", "ADMIN originator x"] },
				"labels[1]",
				"ADMIN originator x",
			],
			[{ tags: ["\u00a0admin"] }, "tags[0]", "\u00a0admin"],
			[{ protocolID: [2, " admin keys"] }, "protocolID[1]", " admin keys"],
			[
				{ outputs: [{ basket: "Administrator" }] },
				"outputs[0].basket",
				"Administrator",
			],
			[
				{ outputs: [{ insertionRemittance: { basket: "AdMin x" } }] },
				"outputs[0].insertionRemittance.basket",
				"AdMin x",
			],
		];
		for (const [args, field, value] of cases) {
			assert.deepEqual(findMisroutedModuleIdentifier(args), {
				field,
				value,
				prefix: "admin",
			});
		}
	});

	it("leaves canonical reserved names, plain names and non-strings alone", () => {
		for (const args of [
			{ basket: BASKET, labels: ["p color plan 0 1 ab"], tags: ["p color"] },
			{ basket: "admin foo", labels: ["admin originator x"] },
			{ protocolID: [2, "admin keys"], tags: ["my admin", "ad min"] },
			{ protocolID: PROTOCOL },
			{ basket: "Default", labels: ["Payments"], tags: [" pcolor"] },
			{ basket: 1, labels: [null], protocolID: [2] },
			{ outputs: [null, { insertionRemittance: null }] },
			"P color",
			undefined,
		]) {
			assert.equal(findMisroutedModuleIdentifier(args), null);
		}
	});
});

describe("misrouted p names never reach the wallet (case and padding)", () => {
	const misrouted = (calls: RawCall[], prompts: string[]) => {
		assert.deepEqual(calls, []);
		assert.deepEqual(prompts, []);
	};

	for (const basket of variants(BASKET)) {
		it(`refuses listOutputs, relinquishOutput and internalizeAction for basket ${JSON.stringify(basket)}`, async () => {
			const { manager, calls, prompts } = setup();
			await assert.rejects(
				manager.listOutputs({ basket }, APP),
				MisroutedModuleIdentifierError,
			);
			await assert.rejects(
				manager.relinquishOutput(
					{ basket, output: `${"c".repeat(64)}.0` },
					APP,
				),
				MisroutedModuleIdentifierError,
			);
			await assert.rejects(
				manager.internalizeAction(
					{
						tx: [1],
						description: "take it in",
						outputs: [
							{
								outputIndex: 0,
								protocol: "basket insertion",
								insertionRemittance: { basket },
							},
						],
					},
					APP,
				),
				MisroutedModuleIdentifierError,
			);
			misrouted(calls, prompts);
		});
	}

	for (const name of variants(PROTOCOL[1])) {
		it(`refuses createSignature for protocol ${JSON.stringify(name.slice(0, 12))}`, async () => {
			const { manager, calls, prompts } = setup();
			await assert.rejects(
				manager.createSignature(
					{
						protocolID: [PROTOCOL[0], name],
						keyID: "color",
						counterparty: "self",
						data: [1, 2, 3],
					},
					APP,
				),
				MisroutedModuleIdentifierError,
			);
			misrouted(calls, prompts);
		});
	}

	it("covers the 1Sat p modules and createAction labels, tags and baskets", async () => {
		const { manager, calls, prompts } = setup();
		const action = (patch: object) =>
			manager.createAction({ description: "make it", ...patch }, APP);
		for (const call of [
			manager.listOutputs({ basket: "P 1sat ordinals" }, APP),
			action({ labels: [" p 1sat bsv21"] }),
			action({
				outputs: [
					{
						lockingScript: "51",
						satoshis: 1,
						outputDescription: "one",
						basket: "P color x",
					},
				],
			}),
			action({
				outputs: [
					{
						lockingScript: "51",
						satoshis: 1,
						outputDescription: "one",
						tags: ["P color"],
					},
				],
			}),
		]) {
			await assert.rejects(call, MisroutedModuleIdentifierError);
		}
		misrouted(calls, prompts);
	});

	it("tells the app which field it refused and logs the full detail", async () => {
		const { manager } = setup();
		await assert.rejects(manager.listOutputs({ basket: ` ${BASKET}` }, APP), {
			name: "MisroutedModuleIdentifierError",
			message: /basket .*lowercase "p "/,
		});
		const [event] = getDiagnosticEvents();
		assert.equal(event.operation, "wallet.module-identifier.listOutputs");
		const detail = logged.find(
			(args) => args[0] === "[wallet] refused a misrouted reserved name",
		);
		assert.deepEqual(detail?.[1], {
			correlationId: event.correlationId,
			method: "listOutputs",
			originator: APP,
			field: "basket",
			value: ` ${BASKET}`,
			prefix: "p ",
		});
	});

	it("refuses misrouted admin names from an app before the manager sees them", async () => {
		const { manager, calls, prompts } = setup();
		for (const call of [
			manager.listOutputs({ basket: " admin foo" }, APP),
			manager.relinquishOutput(
				{ basket: "Admin foo", output: `${"c".repeat(64)}.0` },
				APP,
			),
			manager.listActions({ labels: ["Admin originator other.app"] }, APP),
			manager.createAction(
				{ description: "make it", labels: [" admin month 2026-11"] },
				APP,
			),
			manager.createSignature(
				{
					protocolID: [2, "Admin keys"],
					keyID: "1",
					counterparty: "self",
					data: [1],
				},
				APP,
			),
			manager.internalizeAction(
				{
					tx: [1],
					description: "take it in",
					outputs: [
						{
							outputIndex: 0,
							protocol: "basket insertion",
							insertionRemittance: { basket: "ADMIN x" },
						},
					],
				},
				APP,
			),
		]) {
			await assert.rejects(call, {
				name: "MisroutedModuleIdentifierError",
				message: /reserved "admin" prefix.*lowercase "admin"/,
			});
		}
		assert.deepEqual(calls, []);
		assert.deepEqual(prompts, []);
		const detail = logged.find(
			(args) => args[0] === "[wallet] refused a misrouted reserved name",
		);
		assert.deepEqual(detail?.[1], {
			correlationId: getDiagnosticEvents()[0].correlationId,
			method: "listOutputs",
			originator: APP,
			field: "basket",
			value: " admin foo",
			prefix: "admin",
		});
	});

	it("still routes the canonical name to the module, which refuses the app", async () => {
		const { manager, calls } = setup();
		await assert.rejects(
			manager.listOutputs({ basket: BASKET }, APP),
			ColorConsentDeclinedError,
		);
		assert.deepEqual(calls, []);
	});

	it("passes other calls and the manager's own methods through", async () => {
		const { manager, calls } = setup();
		assert.ok(manager instanceof WalletPermissionsManager);
		const result = await manager.listOutputs({ basket: BASKET }, ADMIN);
		assert.equal(result.totalOutputs, 0);
		const id = manager.bindCallback("onBasketAccessRequested", () => {});
		assert.equal(manager.unbindCallback("onBasketAccessRequested", id), true);
		assert.deepEqual(methods(calls), ["listOutputs"]);
	});
});

describe("1Color refuses every app on every routed method", () => {
	it("refuses getPublicKey and verifySignature under a p color protocol", async () => {
		const { manager, calls } = setup();
		await assert.rejects(
			manager.getPublicKey(
				{ protocolID: PROTOCOL, keyID: "color", counterparty: PUBKEY },
				APP,
			),
			ColorConsentDeclinedError,
		);
		await assert.rejects(
			manager.verifySignature(
				{
					protocolID: PROTOCOL,
					keyID: "color",
					counterparty: PUBKEY,
					data: [1],
					signature: [1],
				},
				APP,
			),
			ColorConsentDeclinedError,
		);
		assert.deepEqual(calls, []);
	});

	it("refuses internalizeAction into a p color basket", async () => {
		const { manager, calls } = setup();
		await assert.rejects(
			manager.internalizeAction(
				{
					tx: [1],
					description: "take it in",
					outputs: [
						{
							outputIndex: 0,
							protocol: "basket insertion",
							insertionRemittance: { basket: BASKET },
						},
					],
				},
				APP,
			),
			ColorConsentDeclinedError,
		);
		assert.deepEqual(calls, []);
	});

	it("refuses createAction with a color plan before anything is funded", async () => {
		const { manager, calls } = setup();
		for (const options of [{}, { signAndProcess: false }]) {
			await assert.rejects(
				manager.createAction(
					{
						description: "send tokens",
						labels: ["p color plan 0 1 ab"],
						options,
					},
					APP,
				),
				ColorConsentDeclinedError,
			);
		}
		assert.ok(!methods(calls).includes("createAction"));
	});

	it("still serves the wallet itself", async () => {
		const { manager, calls } = setup();
		const key = await manager.getPublicKey(
			{ protocolID: PROTOCOL, keyID: "color", counterparty: PUBKEY },
			ADMIN,
		);
		assert.equal(key.publicKey, PUBKEY);
		const listed = await manager.listOutputs({ basket: BASKET }, ADMIN);
		assert.equal(listed.totalOutputs, 0);
		assert.deepEqual(
			calls.map((call) => [call.method, call.originator]),
			[
				["getPublicKey", ADMIN],
				["listOutputs", ADMIN],
			],
		);
	});

	it("refuses a spelling of the admin that is not exact", async () => {
		const { manager } = setup();
		await assert.rejects(
			manager.getPublicKey(
				{ protocolID: PROTOCOL, keyID: "color", counterparty: PUBKEY },
				"HTTPS://1SATWALLET.COM",
			),
			ColorConsentDeclinedError,
		);
	});

	it("disposes the module through the registered wrapper", () => {
		const { color } = setup();
		const module = color.module as unknown as { selected: Set<string> };
		module.selected.add(`${"b".repeat(64)}.0`);
		color.permissionModule.dispose();
		assert.equal(module.selected.size, 0);
		assert.equal(
			color.permissionModule.capabilities,
			color.module.capabilities,
		);
	});
});
