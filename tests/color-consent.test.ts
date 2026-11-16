// Port of Yours (1color branch) src/services/colorConsent.test.ts.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PromptRequest, TransactionPrompt } from "@1sat/permission-module";
import {
	InMemoryPermissionStore,
	type IPermissionStore,
} from "@1sat/wallet-browser";
import { assetBasket } from "@bsv/color-permission-module";
import {
	ColorGrantStoreError,
	type ColorMessage,
	colorGrantLabel,
	colorPromptRequest,
	createColorTokenAccessHandler,
	sighashName,
} from "@/lib/cwi/color-consent";
import { clearDiagnostics } from "@/lib/runtime-diagnostics";

const ADMIN = "1satwallet.com";
const APP = "swap.example.com";
const ASSET = `${"a".repeat(64)}_0`;

// Declines are logged with console.error; keep the output readable.
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

const facts = {
	assets: [
		{
			assetId: ASSET,
			operations: ["transfer", "burn"],
			inputAmount: "100",
			foreignAmount: "0",
			authorityInputs: 0,
			foreignAuthorityInputs: 0,
			keptAmount: "30",
			keptAuthorities: 0,
			outgoingAmount: "60",
			outgoingAuthorities: 0,
			transferred: "90",
			burned: "10",
			minted: "0",
		},
	],
	destinations: [
		{
			outputIndex: 0,
			satoshis: 1,
			lockingScript: `76a914${"00".repeat(20)}88ac`,
			assetId: ASSET,
			role: "value",
			amount: "60",
		},
		{
			outputIndex: 1,
			satoshis: 500,
			lockingScript: `76a914${"11".repeat(20)}88ac`,
		},
	],
	satoshis: { inputs: 1000, outputs: 502, fee: 498 },
	signatures: [
		{ outpoint: `${"c".repeat(64)}.1`, inputIndex: 0, sighashType: 0x41 },
	],
	lockTime: 0,
};

const send: ColorMessage = {
	type: "color_send",
	handoff: false,
	seekPermission: true,
	...facts,
};
const relinquish = {
	type: "color_relinquish",
	assetId: ASSET,
	role: "value",
	outpoint: `${"d".repeat(64)}.0`,
	seekPermission: true,
} as const;

const payloadOf = (req: PromptRequest) =>
	req.payload as unknown as TransactionPrompt;
const rowsOf = (req: PromptRequest) => payloadOf(req).rows;
const panelsOf = (req: PromptRequest) => payloadOf(req).panels;

describe("colorPromptRequest", () => {
	test("color_send → a transaction prompt with every leg, destination, total and signature", () => {
		const req = colorPromptRequest(APP, send);
		assert.equal(req.kind, "transaction");
		assert.equal(req.originator, APP);
		assert.equal(payloadOf(req).title, "Token Transaction");
		assert.equal(payloadOf(req).subtitle, APP);
		const [leg, tokenOut, satsOut] = panelsOf(req);
		assert.equal(leg.tone, "danger"); // burns
		assert.deepEqual(
			leg.meta?.find((row) => row.key === "Asset")?.copyValue,
			ASSET,
		);
		assert.deepEqual(
			leg.meta?.find((row) => row.key === "Outgoing"),
			{ key: "Outgoing", value: "60" },
		);
		assert.deepEqual(
			leg.meta?.find((row) => row.key === "Burned"),
			{ key: "Burned", value: "10" },
		);
		assert.equal(tokenOut.title, "Output #0");
		assert.equal(tokenOut.subtitle, "60 tokens");
		assert.equal(satsOut.variant, "value");
		assert.equal(satsOut.amountSats, 500);
		const rows = rowsOf(req);
		assert.deepEqual(
			rows.find((row) => row.key === "Fee"),
			{ key: "Fee", value: "498 sats" },
		);
		assert.deepEqual(
			rows.find((row) => row.key === "Lock time"),
			{ key: "Lock time", value: "0" },
		);
		assert.match(
			rows.find((row) => row.key === "Signs input #0")?.value ?? "",
			/0x41 ALL\|FORKID/,
		);
	});

	test("a handoff is titled as one", () => {
		const req = colorPromptRequest(APP, { ...send, handoff: true });
		assert.equal(payloadOf(req).title, "Token Handoff");
		assert.deepEqual(rowsOf(req)[0], {
			key: "Handoff",
			value: "Signed now, sent by the receiver",
		});
		assert.match(req.summary, /^Hand off 1 token leg$/);
	});

	test("a deploy gets its own panel first", () => {
		const req = colorPromptRequest(APP, {
			...send,
			deploy: { operation: "deploy+mint", amount: "1000", owned: true },
		});
		assert.equal(panelsOf(req)[0].title, "New token deploy");
		assert.equal(panelsOf(req)[0].subtitle, "deploy+mint");
	});

	test("color_signature → a transaction-layout prompt naming the signed input", () => {
		const req = colorPromptRequest(APP, {
			type: "color_signature",
			inputIndex: 0,
			...facts,
		});
		assert.equal(req.kind, "transaction");
		assert.equal(payloadOf(req).title, "Token Signature");
		assert.deepEqual(rowsOf(req)[0], { key: "Signs input", value: "#0" });
	});

	test("color_access → basketAccess for the basket read", () => {
		const basket = "p color balance xyz";
		const req = colorPromptRequest(APP, {
			type: "color_access",
			basket,
			assetId: ASSET,
			role: "value",
		});
		assert.equal(req.kind, "basketAccess");
		assert.deepEqual(req.payload, {
			baskets: [
				{
					basket,
					scope: "token balance",
					description: "View the value balance of this token",
					value: ASSET,
				},
			],
		});
	});

	test("color_access → basketAccess listing the labels of a history read", () => {
		const req = colorPromptRequest(APP, {
			type: "color_access",
			labels: ["p color plan a", "p color plan b"],
		});
		assert.equal(req.kind, "basketAccess");
		assert.equal(req.summary, "Grant view to 2 token labels");
		assert.deepEqual(req.payload, {
			baskets: [
				{
					basket: "p color plan a",
					scope: "token history",
					description: "View token action history",
				},
				{
					basket: "p color plan b",
					scope: "token history",
					description: "View token action history",
				},
			],
		});
	});

	test("color_relinquish → a prompt titled as a removal", () => {
		const req = colorPromptRequest(APP, relinquish);
		assert.equal(req.kind, "transaction");
		assert.equal(payloadOf(req).title, "Remove Token Output");
		assert.match(req.summary, new RegExp("d".repeat(64)));
	});
});

describe("createColorTokenAccessHandler", () => {
	const setup = (
		answer: boolean,
		store: IPermissionStore = new InMemoryPermissionStore(),
	) => {
		const prompts: PromptRequest[] = [];
		const handler = createColorTokenAccessHandler({
			promptHandler: async (req) => {
				prompts.push(req);
				return answer;
			},
			permissionStore: store,
			adminOriginator: ADMIN,
		});
		return { prompts, store, handler };
	};

	const read = (extra: object = {}) =>
		JSON.stringify({
			type: "color_access",
			basket: "p color assets",
			seekPermission: true,
			...extra,
		});
	const grantKey = {
		type: "basket",
		originator: APP,
		basket: "p color assets",
	} as const;

	test("admin reads are approved without a prompt", async () => {
		const { prompts, handler } = setup(false);
		assert.equal(await handler(ADMIN, read()), true);
		assert.equal(prompts.length, 0);
	});

	test("admin sends, signatures and relinquishes are approved without a prompt", async () => {
		const { prompts, handler } = setup(false);
		assert.equal(await handler(ADMIN, JSON.stringify(send)), true);
		assert.equal(
			await handler(
				ADMIN,
				JSON.stringify({ type: "color_signature", inputIndex: 0, ...facts }),
			),
			true,
		);
		assert.equal(await handler(ADMIN, JSON.stringify(relinquish)), true);
		assert.equal(prompts.length, 0);
	});

	test("an originator that only normalizes to the admin is asked (exact match)", async () => {
		const { prompts, handler } = setup(false);
		for (const app of ["1SATWALLET.COM", "1satwallet.com:8443"])
			assert.equal(await handler(app, JSON.stringify(send)), false);
		assert.equal(prompts.length, 2);
	});

	test("an approved read stores a basket grant; the next read does not prompt", async () => {
		const { prompts, store, handler } = setup(true);
		assert.equal(await handler(APP, read()), true);
		const grant = await store.findGrant(grantKey);
		assert.ok(grant);
		assert.equal(grant.expiry, 0);
		assert.equal(await handler(APP, read()), true);
		assert.equal(prompts.length, 1);
	});

	test("grants are per app: another app is asked", async () => {
		const { prompts, handler } = setup(true);
		await handler(APP, read());
		await handler("other.example.com", read());
		assert.deepEqual(
			prompts.map((prompt) => prompt.originator),
			[APP, "other.example.com"],
		);
	});

	test("an existing basket grant approves", async () => {
		const { prompts, store, handler } = setup(false);
		await store.putGrant({ key: grantKey, expiry: 0, grantedAt: Date.now() });
		assert.equal(await handler(APP, read()), true);
		assert.equal(prompts.length, 0);
	});

	test("an expired basket grant prompts again", async () => {
		const { prompts, store, handler } = setup(false);
		await store.putGrant({
			key: grantKey,
			expiry: Math.floor(Date.now() / 1000) - 60,
			grantedAt: Date.now() - 120_000,
		});
		assert.equal(await handler(APP, read()), false);
		assert.equal(prompts.length, 1);
	});

	test("a declined read stores nothing", async () => {
		const { store, handler } = setup(false);
		assert.equal(await handler(APP, read()), false);
		assert.equal(await store.findGrant(grantKey), null);
	});

	test("seekPermission false with no grant declines without a prompt", async () => {
		const { prompts, handler } = setup(true);
		assert.equal(await handler(APP, read({ seekPermission: false })), false);
		assert.equal(prompts.length, 0);
	});

	test("label reads prompt every time", async () => {
		const { prompts, store, handler } = setup(true);
		const labels = JSON.stringify({
			type: "color_access",
			labels: ["p color plan x"],
			seekPermission: true,
		});
		await handler(APP, labels);
		await handler(APP, labels);
		assert.equal(prompts.length, 2);
		assert.deepEqual(await store.listGrants(), []);
	});

	test("sends, signatures and relinquishes prompt every time and resolve with the answer", async () => {
		const approve = setup(true);
		assert.equal(await approve.handler(APP, JSON.stringify(send)), true);
		assert.equal(await approve.handler(APP, JSON.stringify(send)), true);
		assert.equal(
			await approve.handler(
				APP,
				JSON.stringify({ type: "color_signature", inputIndex: 0, ...facts }),
			),
			true,
		);
		assert.equal(await approve.handler(APP, JSON.stringify(relinquish)), true);
		assert.equal(approve.prompts.length, 4);
		assert.deepEqual(await approve.store.listGrants(), []);
		assert.equal(await setup(false).handler(APP, JSON.stringify(send)), false);
	});

	test("unknown or unreadable messages are declined without a prompt, and logged", async () => {
		const { prompts, handler } = setup(true);
		assert.equal(await handler(APP, "{not json"), false);
		assert.equal(
			await handler(APP, JSON.stringify({ type: "color_other" })),
			false,
		);
		assert.equal(await handler(APP, "null"), false);
		assert.equal(prompts.length, 0);
		assert.deepEqual(
			logged
				.filter((args) => args[0] !== "[diagnostic]")
				.map((args) => args[0]),
			[
				"[wallet] 1Color consent: declined an unreadable request",
				"[wallet] 1Color consent: declined an unknown request type",
				"[wallet] 1Color consent: declined an unknown request type",
			],
		);
	});

	test("a grant store that cannot be read fails the request, logged, with no prompt", async () => {
		const broken = new InMemoryPermissionStore();
		broken.findGrant = async () => {
			throw new Error("IDB open failed");
		};
		const { prompts, handler } = setup(true, broken);
		await assert.rejects(handler(APP, read()), (error: unknown) => {
			assert.ok(error instanceof ColorGrantStoreError);
			assert.equal(error.message, "Could not read saved 1Color permissions.");
			assert.equal((error.cause as Error).message, "IDB open failed");
			return true;
		});
		assert.equal(prompts.length, 0);
		const detail = logged.find(
			(args) =>
				args[0] === "[wallet] 1Color consent: could not read saved grants",
		);
		assert.ok(detail);
		assert.equal(
			(detail[1] as { error: Error }).error.message,
			"IDB open failed",
		);
	});

	test("an approved read still goes ahead when its grant cannot be saved", async () => {
		const broken = new InMemoryPermissionStore();
		broken.putGrant = async () => {
			throw new Error("quota exceeded");
		};
		const { prompts, handler } = setup(true, broken);
		assert.equal(await handler(APP, read()), true);
		assert.equal(await handler(APP, read()), true);
		assert.equal(prompts.length, 2);
		assert.ok(
			logged.some(
				(args) => args[0] === "[wallet] 1Color consent: could not save a grant",
			),
		);
	});
});

test("sighashName", () => {
	assert.equal(sighashName(0x41), "0x41 ALL|FORKID");
	assert.equal(sighashName(0xc3), "0xc3 SINGLE|FORKID|ANYONECANPAY");
});

test("colorGrantLabel names each p color basket", () => {
	assert.equal(colorGrantLabel("p color assets"), "All tokens");
	const value = assetBasket(ASSET, "value");
	assert.match(colorGrantLabel(value), /^Outputs of a{8}…/);
	assert.match(
		colorGrantLabel(assetBasket(ASSET, "authority")),
		/^Authorities of a{8}…/,
	);
	assert.match(
		colorGrantLabel(value.replace("p color ", "p color balance ")),
		/^Balance of a{8}…/,
	);
	assert.equal(colorGrantLabel("p color nonsense x y"), "p color nonsense x y");
});
