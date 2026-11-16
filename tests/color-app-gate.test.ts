import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assetBasket, colorProtocolID } from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import {
	type PermissionsManagerConfig,
	WalletPermissionsManager,
} from "@bsv/wallet-toolbox-client";
import {
	clearDiagnostics,
	getDiagnosticEvents,
} from "@/lib/runtime-diagnostics";
import {
	ColorUnavailableToAppsError,
	createWalletColorModule,
} from "@/lib/wallet/color-module";
import {
	createListScanCache,
	findMisroutedModuleIdentifier,
	findRefusedAppName,
	guardModuleIdentifiers,
	LIST_SCAN_MAX,
	LIST_SCAN_PAGE,
	listActionsForApp,
	MisroutedModuleIdentifierError,
} from "@/lib/wallet/module-identifier-guard";

const ADMIN = "1satwallet.com";
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

type RawCall = { method: string; originator: unknown; args: unknown };

/**
 * A raw wallet that records every call and answers the few the manager needs;
 * a prompt of any kind is recorded and granted, so a test sees both.
 */
type Listed = { actions: Record<string, unknown>[] };

/** The wallet's listActions over `listed`: paged, labels only when asked. */
const listFrom = (listed: Listed, args: unknown) => {
	const {
		offset = 0,
		limit = 10,
		includeLabels,
	} = args as {
		offset?: number;
		limit?: number;
		includeLabels?: boolean;
	};
	return {
		totalActions: listed.actions.length,
		actions: structuredClone(listed.actions.slice(offset, offset + limit)).map(
			(action) => {
				if (!includeLabels) delete action.labels;
				return action;
			},
		),
	};
};

const setup = (listed: Listed = { actions: [] }) => {
	const calls: RawCall[] = [];
	const wallet = new Proxy(
		{},
		{
			get:
				(_target, prop: string) =>
				async (args: unknown, originator: unknown) => {
					calls.push({ method: prop, originator, args });
					if (prop === "listOutputs") return { totalOutputs: 0, outputs: [] };
					if (prop === "listActions") return listFrom(listed, args);
					if (prop === "revealSpecificKeyLinkage")
						return { encryptedLinkage: [1], encryptedLinkageProof: [1] };
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
		ADMIN,
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
				reason: "misrouted",
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
				reason: "misrouted",
				prefix: "admin",
			});
		}
	});

	it("leaves canonical reserved names and plain names alone", () => {
		for (const args of [
			{ basket: BASKET, labels: ["p color plan 0 1 ab"], tags: ["p color"] },
			{ basket: "admin foo", labels: ["admin originator x"] },
			{ protocolID: [2, "admin keys"], tags: ["my admin", "ad min"] },
			{ protocolID: PROTOCOL },
			{ basket: "Default", labels: ["Payments"], tags: [" pcolor"] },
			{ protocolID: [2] },
			{ outputs: [{ protocol: "wallet payment" }] },
			Object.assign(Object.create(null), { basket: "tokens" }),
			undefined,
		]) {
			assert.equal(findMisroutedModuleIdentifier(args), null);
		}
	});

	it("refuses args that are not a plain object", () => {
		for (const [args, value] of [
			[Object.assign([], { basket: " default" }), "an array"],
			["P color", "string"],
			[null, "null"],
			[new Map([["basket", "x"]]), "an instance of Map"],
			[new (class Args {})(), "an instance of Args"],
		] as const) {
			assert.deepEqual(findMisroutedModuleIdentifier(args), {
				field: "args",
				value,
				reason: "not-an-object",
			});
		}
		const refusal = findMisroutedModuleIdentifier(new (class Args {})());
		assert.ok(refusal);
		assert.equal(
			new MisroutedModuleIdentifierError(refusal).message,
			"Refused: args must be a plain object, not an instance of Args.",
		);
	});

	it("refuses names that are not primitive strings and lists that are not arrays", () => {
		const cases: [unknown, string, string, string][] = [
			[
				{ basket: new String("P color x") },
				"basket",
				"not-a-string",
				"an instance of String",
			],
			[{ basket: 1 }, "basket", "not-a-string", "number"],
			[{ labels: [null] }, "labels[0]", "not-a-string", "null"],
			[{ tags: "p color" }, "tags", "not-an-array", "string"],
			[
				{ labels: { 0: "P color x", length: 1 } },
				"labels",
				"not-an-array",
				"a plain object",
			],
			[
				{ protocolID: { 0: 2, 1: "P color x" } },
				"protocolID",
				"not-an-array",
				"a plain object",
			],
			[
				{ protocolID: [2, new String("P color x")] },
				"protocolID[1]",
				"not-a-string",
				"an instance of String",
			],
			[
				{ outputs: { 0: { insertionRemittance: { basket: "P color x" } } } },
				"outputs",
				"not-an-array",
				"a plain object",
			],
			[{ outputs: [null] }, "outputs[0]", "not-an-object", "null"],
			[
				{ outputs: [{ insertionRemittance: null }] },
				"outputs[0].insertionRemittance",
				"not-an-object",
				"null",
			],
			[
				{
					outputs: [
						{ insertionRemittance: { basket: "b", tags: [new String("x")] } },
					],
				},
				"outputs[0].insertionRemittance.tags[0]",
				"not-a-string",
				"an instance of String",
			],
		];
		for (const [args, field, reason, value] of cases) {
			assert.deepEqual(findMisroutedModuleIdentifier(args), {
				field,
				value,
				reason,
			});
		}
	});

	it("cuts long values to 64 characters", () => {
		const long = `P color ${"x".repeat(200)}`;
		const hit = findMisroutedModuleIdentifier({ basket: long });
		assert.equal(hit?.value, `${long.slice(0, 64)}…`);
		assert.ok(hit);
		const error = new MisroutedModuleIdentifierError(hit);
		assert.ok(!error.message.includes(long));
		assert.ok(error.message.length < 300);
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
			(args) => args[0] === "[wallet] refused a reserved or malformed name",
		);
		assert.deepEqual(detail?.[1], {
			correlationId: event.correlationId,
			method: "listOutputs",
			originator: APP,
			field: "basket",
			value: `${` ${BASKET}`.slice(0, 64)}…`,
			reason: "misrouted",
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
			(args) => args[0] === "[wallet] refused a reserved or malformed name",
		);
		assert.deepEqual(detail?.[1], {
			correlationId: getDiagnosticEvents()[0].correlationId,
			method: "listOutputs",
			originator: APP,
			field: "basket",
			value: " admin foo",
			reason: "misrouted",
			prefix: "admin",
		});
	});

	it("still routes the canonical name to the module, which refuses the app", async () => {
		const { manager, calls } = setup();
		await assert.rejects(
			manager.listOutputs({ basket: BASKET }, APP),
			ColorUnavailableToAppsError,
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
			ColorUnavailableToAppsError,
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
			ColorUnavailableToAppsError,
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
			ColorUnavailableToAppsError,
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
				ColorUnavailableToAppsError,
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
			ColorUnavailableToAppsError,
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

const SPEC_OP_CHANGE_BASKET =
	"b9184a72141e6a4d3d148c67a6d0ad92864a4d85290579ea5bef8bd62eb01b6f";

describe("apps may only send canonical names", () => {
	it("refuses padded or uppercase spellings of the admin-only baskets", async () => {
		const { manager, calls, prompts } = setup();
		for (const basket of [
			" default",
			"Default",
			"default ",
			SPEC_OP_CHANGE_BASKET.toUpperCase(),
			` ${SPEC_OP_CHANGE_BASKET}`,
		]) {
			await assert.rejects(manager.listOutputs({ basket }, APP), {
				name: "MisroutedModuleIdentifierError",
				reason: "not-canonical",
				field: "basket",
			});
		}
		assert.deepEqual(calls, []);
		assert.deepEqual(prompts, []);
	});

	it("refuses non-canonical labels, tags and protocol names from apps only", () => {
		for (const args of [
			{ labels: ["Payments"] },
			{ tags: [" invoice"] },
			{ protocolID: [2, "Todo List"] },
			{ outputs: [{ basket: "Tokens" }] },
		]) {
			assert.equal(
				findRefusedAppName("createAction", args)?.reason,
				"not-canonical",
			);
			assert.equal(findMisroutedModuleIdentifier(args), null);
		}
		assert.equal(
			findRefusedAppName("createAction", {
				labels: ["payments"],
				protocolID: [2, "todo list"],
			}),
			null,
		);
	});

	it("refuses shapes structured clone allows before the manager runs", async () => {
		const { manager, calls, prompts } = setup();
		for (const [call, reason] of [
			[
				manager.listOutputs(
					{ basket: new String("P color x") as unknown as string },
					APP,
				),
				"not-a-string",
			],
			[
				manager.getPublicKey(
					{
						protocolID: [
							PROTOCOL[0],
							new String(`P${PROTOCOL[1].slice(1)}`) as unknown as string,
						],
						keyID: "color",
						counterparty: "self",
					},
					APP,
				),
				"not-a-string",
			],
			[
				manager.internalizeAction(
					{
						tx: [1],
						description: "take it in",
						outputs: {
							0: {
								outputIndex: 0,
								protocol: "basket insertion",
								insertionRemittance: { basket: "P color x" },
							},
						} as never,
					},
					APP,
				),
				"not-an-array",
			],
		] as const) {
			await assert.rejects(call, { reason });
		}
		assert.deepEqual(calls, []);
		assert.deepEqual(prompts, []);
	});

	it("still lets the wallet itself use other spellings outside the reserved prefixes", async () => {
		const { manager, calls } = setup();
		await manager.listOutputs({ basket: "Default" }, ADMIN);
		assert.deepEqual(methods(calls), ["listOutputs"]);
	});
});

describe("apps never see admin-only module actions or outputs in listActions", () => {
	const listed: Listed = {
		actions: [
			{
				txid: "a",
				labels: ["p color plan 0 1 ab", "payments"],
				outputs: [{ outputIndex: 0, basket: BASKET }],
			},
			{
				txid: "b",
				labels: ["payments"],
				outputs: [
					{ outputIndex: 0, basket: "default" },
					{ outputIndex: 1, basket: BASKET },
					{ outputIndex: 2, basket: "p 1sat ordinals" },
				],
			},
			{ txid: "c", labels: ["p color"], outputs: [] },
			{
				txid: "d",
				labels: ["p nosend expiry never"],
				outputs: [{ outputIndex: 0, basket: "tokens" }],
			},
		],
	};

	it("hides p color actions and outputs but keeps app-usable p modules", async () => {
		const { manager } = setup(listed);
		const result = await manager.listActions(
			{ labels: [], includeOutputs: true },
			APP,
		);
		assert.deepEqual(result, {
			totalActions: 2,
			actions: [
				{
					txid: "b",
					outputs: [
						{ outputIndex: 0, basket: "default" },
						{ outputIndex: 2, basket: "p 1sat ordinals" },
					],
				},
				{
					txid: "d",
					outputs: [{ outputIndex: 0, basket: "tokens" }],
				},
			],
		});
	});

	it("keeps labels when the app asked for them", async () => {
		const { manager } = setup(listed);
		const result = await manager.listActions(
			{ labels: [], includeLabels: true },
			APP,
		);
		assert.deepEqual(
			result.actions.map((action) => [action.txid, action.labels]),
			[
				["b", ["payments"]],
				["d", ["p nosend expiry never"]],
			],
		);
	});

	it("pages and counts visible actions only", async () => {
		const { manager } = setup(listed);
		const page = async (offset: number, limit: number) => {
			const result = await manager.listActions(
				{ labels: [], offset, limit },
				APP,
			);
			return [result.totalActions, result.actions.map((action) => action.txid)];
		};
		assert.deepEqual(await page(0, 1), [2, ["b"]]);
		assert.deepEqual(await page(1, 1), [2, ["d"]]);
		assert.deepEqual(await page(2, 1), [2, []]);
		assert.deepEqual(await page(0, 10), [2, ["b", "d"]]);
	});

	it("leaves the wallet's own listing untouched", async () => {
		const { manager, calls } = setup(listed);
		const result = await manager.listActions({ labels: [] }, ADMIN);
		assert.equal(result.totalActions, 4);
		assert.equal(result.actions.length, 4);
		assert.deepEqual(methods(calls), ["listActions"]);
	});

	/** A wallet listing over `actions` that counts its calls. */
	const counted = (actions: Record<string, unknown>[]) => {
		const calls: Record<string, unknown>[] = [];
		const listActions = async (args: Record<string, unknown>) => {
			calls.push(args);
			return listFrom({ actions }, args);
		};
		return { calls, listActions };
	};
	const history = (length: number) =>
		Array.from({ length }, (_, index) => ({
			txid: String(index),
			labels: index % 2 === 0 ? ["p color plan"] : ["payments"],
		}));

	it("reads only as far as the requested page, in two calls", async () => {
		const actions = history(5_000);
		const { calls, listActions } = counted(actions);
		const result = await listActionsForApp(
			listActions,
			{ labels: [], limit: 10 },
			APP,
		);
		assert.equal(calls.length, 2);
		assert.deepEqual(
			calls.map((call) => [call.offset, call.limit]),
			[
				[0, 32],
				[1, 19],
			],
		);
		assert.deepEqual(
			result.actions.map((action) => action.txid),
			["1", "3", "5", "7", "9", "11", "13", "15", "17", "19"],
		);
		// 16 visible found in the 32 scanned, plus the 4,968 not yet scanned.
		assert.equal(result.totalActions, 16 + 4_968);
	});

	it("continues the cached scan for the next page", async () => {
		const actions = history(5_000);
		const { calls, listActions } = counted(actions);
		const cache = createListScanCache();
		const page = (offset: number) =>
			listActionsForApp(
				listActions,
				{ labels: [], offset, limit: 10 },
				APP,
				cache,
			);
		await page(0);
		const second = await page(10);
		assert.deepEqual(
			second.actions.map((action) => action.txid),
			["21", "23", "25", "27", "29", "31", "33", "35", "37", "39"],
		);
		// Page two scans on from action 32 (one call) and reads its window.
		assert.equal(calls.length, 4);
		assert.equal(calls[2].offset, 32);
		const again = await page(0);
		assert.deepEqual(
			again.actions.map((action) => action.txid),
			["1", "3", "5", "7", "9", "11", "13", "15", "17", "19"],
		);
		assert.equal(calls.length, 5);
	});

	it("rescans when the wallet's total changes", async () => {
		const actions = history(100);
		const { calls, listActions } = counted(actions);
		const cache = createListScanCache();
		const page = () =>
			listActionsForApp(listActions, { labels: [], limit: 2 }, APP, cache);
		await page();
		actions.unshift({ txid: "new", labels: ["payments"] });
		const result = await page();
		assert.deepEqual(
			result.actions.map((action) => action.txid),
			["new", "1"],
		);
		// The cached window read saw the new total, so it scanned again once.
		assert.deepEqual(
			calls.map((call) => [call.offset, call.limit]),
			[
				[0, 32],
				[1, 3],
				[1, 3],
				[0, 32],
				[0, 3],
			],
		);
	});

	it("reports an exact total once the scan reaches the end", async () => {
		const actions = history(40);
		const { listActions } = counted(actions);
		const result = await listActionsForApp(
			listActions,
			{ labels: [], offset: 15, limit: 10 },
			APP,
		);
		assert.equal(result.totalActions, 20);
		assert.deepEqual(
			result.actions.map((action) => action.txid),
			["31", "33", "35", "37", "39"],
		);
	});

	it("stops scanning at the cap and ends the total there", async () => {
		const actions = history(LIST_SCAN_MAX + 5);
		const { calls, listActions } = counted(actions);
		const result = await listActionsForApp(
			listActions,
			{ labels: [], offset: LIST_SCAN_MAX, limit: 2 },
			APP,
		);
		const scanned = calls.reduce(
			(sum, call) => sum + Math.min(Number(call.limit), actions.length),
			0,
		);
		assert.equal(scanned, LIST_SCAN_MAX);
		assert.ok(calls.every((call) => Number(call.limit) <= LIST_SCAN_PAGE));
		// Nothing past the cap can be read, so a pager stops at the cap.
		assert.equal(result.totalActions, LIST_SCAN_MAX / 2);
		assert.deepEqual(result.actions, []);
	});

	it("rescans when an action in the window is relabelled in place", async () => {
		const actions = history(100);
		const { calls, listActions } = counted(actions);
		const cache = createListScanCache();
		const page = () =>
			listActionsForApp(listActions, { labels: [], limit: 3 }, APP, cache);
		await page();
		actions[3] = { txid: "3", labels: ["p color plan"] };
		const result = await page();
		assert.deepEqual(
			result.actions.map((action) => action.txid),
			["1", "5", "7"],
		);
		assert.equal(calls.length, 5);
	});

	it("passes a spec-op label through once and only filters the result", async () => {
		const noSend =
			"ac6b20a3bb320adafecd637b25c84b792ad828d3aa510d05dc841481f664277d";
		const { calls, listActions } = counted(history(6));
		const result = await listActionsForApp(
			listActions,
			{ labels: [noSend], limit: 4 },
			APP,
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].labels, [noSend]);
		assert.deepEqual(
			result.actions.map((action) => action.txid),
			["1", "3"],
		);
		assert.equal(result.totalActions, 4);
	});

	it("rejects a bad window with the wallet's own error", async () => {
		const { manager, calls } = setup(listed);
		await assert.rejects(manager.listActions({ labels: [], limit: 0 }, APP), {
			name: "WERR_INVALID_PARAMETER",
		});
		assert.deepEqual(calls, []);
	});
});

describe("apps may not reveal key linkage for reserved protocols", () => {
	const linkage = (
		name: string,
		originator: string,
		manager: WalletPermissionsManager,
	) =>
		manager.revealSpecificKeyLinkage(
			{
				counterparty: PUBKEY,
				verifier: PUBKEY,
				protocolID: [2, name],
				keyID: "color",
			},
			originator,
		);

	for (const name of [PROTOCOL[1], "p 1sat ordinals", "admin keys"]) {
		it(`refuses ${JSON.stringify(name.slice(0, 16))} without a prompt`, async () => {
			const { manager, calls, prompts } = setup();
			await assert.rejects(linkage(name, APP, manager), {
				name: "MisroutedModuleIdentifierError",
				reason: "reserved-linkage",
				message: /not available to apps/,
			});
			assert.deepEqual(calls, []);
			assert.deepEqual(prompts, []);
		});
	}

	it("still prompts for an ordinary protocol and serves the wallet itself", async () => {
		const { manager, calls, prompts } = setup();
		await linkage("todo list", APP, manager);
		assert.deepEqual(prompts, ["onProtocolPermissionRequested"]);
		await linkage(PROTOCOL[1], ADMIN, manager);
		assert.deepEqual(
			calls
				.filter((call) => call.method === "revealSpecificKeyLinkage")
				.map((call) => call.originator),
			[APP, ADMIN],
		);
	});
});
