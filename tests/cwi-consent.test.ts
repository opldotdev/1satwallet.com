import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { TransactionPrompt } from "@1sat/permission-module";
import { InMemoryPermissionStore } from "@1sat/wallet-browser";
import { assetBasket } from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import { WalletPermissionsManager } from "@bsv/wallet-toolbox-client";
import {
	bindAssetPermissionPromptHandler,
	requestAssetPermission,
} from "../lib/cwi/asset-permission-prompt";
import { createColorTokenAccessHandler } from "../lib/cwi/color-consent";
import {
	counterpartyConsentEntries,
	descriptionConflictsWithAmount,
	groupedConsentEntries,
	isPermissionRequest,
	parseCounterpartyPermissions,
	parseGroupedPermissions,
	permissionExpiry,
	selectCounterpartyPermissions,
	selectGroupedPermissions,
} from "../lib/cwi/consent";
import { CWIRelay } from "../lib/cwi/relay";
import { createSessionBase, createSessionEnvelope } from "../lib/cwi/types";
import { createWalletColorModule } from "../lib/wallet/color-module";

const key = `02${"11".repeat(32)}`;

describe("BRC-73/116 consent", () => {
	test("parses canonical grouped shapes and preserves exact selected subsets", () => {
		const parsed = parseGroupedPermissions({
			description: "Publish a BitPlan",
			spendingAuthorization: { amount: 1200, description: "Publish fee" },
			protocolPermissions: [
				{
					protocolID: [2, "bitplan"],
					counterparty: key,
					description: "Encrypt the plan",
				},
			],
			basketAccess: [{ basket: "1sat", description: "Store the plan" }],
			certificateAccess: [
				{
					type: "dGVzdA==",
					fields: ["name"],
					verifierPublicKey: key,
					description: "Prove a name",
				},
			],
		});
		assert.ok(parsed);
		const entries = groupedConsentEntries(parsed);
		assert.deepEqual(
			entries.map((entry) => entry.id),
			["protocol:0", "basket:0", "certificate:0", "spending"],
		);
		assert.deepEqual(
			selectGroupedPermissions(parsed, new Set(["basket:0", "certificate:0"])),
			{
				description: "Publish a BitPlan",
				basketAccess: [{ basket: "1sat", description: "Store the plan" }],
				certificateAccess: [
					{
						type: "dGVzdA==",
						fields: ["name"],
						verifierPublicKey: key,
						description: "Prove a name",
					},
				],
			},
		);
	});

	test("rejects privileged, overflow, reserved basket, and malformed certificate declarations", () => {
		assert.equal(
			parseGroupedPermissions({
				protocolPermissions: [
					{
						protocolID: [1, "test"],
						description: "test",
						privileged: true,
					},
				],
			}),
			null,
		);
		assert.equal(
			parseGroupedPermissions({
				spendingAuthorization: {
					amount: Number.MAX_SAFE_INTEGER + 1,
					description: "too much",
				},
			}),
			null,
		);
		assert.equal(
			parseGroupedPermissions({
				basketAccess: [{ basket: "default", description: "reserved" }],
			}),
			null,
		);
		assert.equal(
			parseGroupedPermissions({
				certificateAccess: [
					{
						type: "dGVzdA==",
						fields: ["name", "name"],
						verifierPublicKey: key,
						description: "duplicate fields",
					},
				],
			}),
			null,
		);
	});

	test("accepts only Level-2 PACT protocols and selects them independently", () => {
		const parsed = parseCounterpartyPermissions({
			description: "Collaborate",
			protocols: [
				{ protocolName: "chat", description: "Messages" },
				{ protocolID: [2, "files"], description: "Files" },
			],
		});
		assert.ok(parsed);
		assert.deepEqual(
			counterpartyConsentEntries(parsed).map((entry) => entry.detail),
			["chat", "files"],
		);
		assert.deepEqual(
			selectCounterpartyPermissions(parsed, new Set(["protocol:1"])),
			{
				description: "Collaborate",
				protocols: [
					{
						protocolName: "files",
						protocolID: [2, "files"],
						description: "Files",
					},
				],
			},
		);
		assert.equal(
			parseCounterpartyPermissions({
				protocols: [{ protocolID: [1, "not-pact"] }],
			}),
			null,
		);
	});

	test("computes explicit duration without floating point drift", () => {
		assert.equal(permissionExpiry("until-revoked", 100), 0);
		assert.equal(permissionExpiry("thirty-days", 100), 2_592_100);
	});

	test("flags descriptions that contradict structured satoshi amounts", () => {
		assert.equal(
			descriptionConflictsWithAmount("Spend 1,200 sats", 1200),
			false,
		);
		assert.equal(
			descriptionConflictsWithAmount("Spend 1,201 sats", 1200),
			true,
		);
		assert.equal(
			descriptionConflictsWithAmount("Publish this item", 1200),
			false,
		);
	});

	test("rejects malformed individual permission payloads before rendering", () => {
		assert.equal(
			isPermissionRequest({
				requestID: "spend",
				type: "spending",
				spending: {
					satoshis: 500,
					lineItems: [{ type: "fee", description: "Network fee", satoshis: 1 }],
				},
			}),
			true,
		);
		assert.equal(
			isPermissionRequest({
				requestID: "cert",
				type: "certificate",
				certificate: {
					verifier: "not-a-key",
					certType: "dGVzdA==",
					fields: ["name"],
				},
			}),
			false,
		);
	});
});

/** A BroadcastChannel stand-in that records what the relay posts. */
class FakeBroadcastChannel {
	static current: FakeBroadcastChannel;
	readonly sent: unknown[] = [];
	private listener?: (event: MessageEvent) => void;

	constructor(_name: string) {
		FakeBroadcastChannel.current = this;
	}
	addEventListener(_type: string, listener: (event: MessageEvent) => void) {
		this.listener = listener;
	}
	removeEventListener() {
		this.listener = undefined;
	}
	postMessage(message: unknown) {
		this.sent.push(structuredClone(message));
	}
	close() {}
	emit(message: unknown) {
		this.listener?.({ data: structuredClone(message) } as MessageEvent);
	}
}

const originalBroadcastChannel = globalThis.BroadcastChannel;
afterEach(() => {
	Object.defineProperty(globalThis, "BroadcastChannel", {
		configurable: true,
		writable: true,
		value: originalBroadcastChannel,
	});
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("1Color consent through the CWI relay", () => {
	const ADMIN = "1satwallet.com";
	const APP = "app.example";
	const BASKET = assetBasket(`${"a".repeat(64)}_0`, "value");

	const assetPrompts = (channel: FakeBroadcastChannel) =>
		channel.sent.filter(
			(message) =>
				(message as { type?: string }).type === "cwi-asset-permission-request",
		) as Array<{
			requestID: string;
			chain: string;
			request: {
				kind: string;
				originator: string;
				payload: Record<string, unknown>;
			};
		}>;

	test("an app's color read reaches the relay with the request's chain, once per grant", async () => {
		Object.defineProperty(globalThis, "BroadcastChannel", {
			configurable: true,
			writable: true,
			value: FakeBroadcastChannel,
		});
		const rawCalls: Array<[unknown, unknown]> = [];
		const raw = {
			async listOutputs(args: unknown, originator: unknown) {
				rawCalls.push([args, originator]);
				return { totalOutputs: 0, outputs: [] };
			},
		} as unknown as WalletInterface;
		const color = createWalletColorModule({
			wallet: raw,
			chain: "test",
			identityKey: `02${"11".repeat(32)}`,
			adminOriginator: ADMIN,
			promptHandler: requestAssetPermission,
			permissionStore: new InMemoryPermissionStore(),
		});
		assert.ok(color);
		const manager = new WalletPermissionsManager(raw, ADMIN, {
			permissionModules: { color: color.permissionModule },
		});
		const relay = new CWIRelay({
			getWallet: () => manager,
			getStatus: () => "unlocked",
			walletHost: ADMIN,
		});
		relay.start();
		const channel = FakeBroadcastChannel.current;
		// As lib/hooks/use-cwi-relay.ts binds it, with the wallet's chain.
		const unbind = bindAssetPermissionPromptHandler((request) =>
			relay.requestAssetPermission(request, "test"),
		);

		const opened = {
			sessionId: "color-consent",
			sessionToken: "color-consent-".padEnd(43, "x"),
			browserOrigin: `https://${APP}`,
			originator: APP,
		};
		channel.emit({ ...createSessionBase(opened), type: "cwi-session-open" });
		const { leaderId } = channel.sent.at(-1) as { leaderId: string };
		const session = { ...opened, leaderId };
		const call = (id: string) =>
			channel.emit({
				...createSessionEnvelope(session),
				type: "cwi-request",
				id,
				call: "listOutputs",
				args: { basket: BASKET },
			});
		const responses = () =>
			channel.sent.filter(
				(message) => (message as { type?: string }).type === "cwi-response",
			) as Array<{ id: string; status: string }>;

		try {
			call("first");
			await tick();
			await tick();
			const [prompt] = assetPrompts(channel);
			assert.ok(prompt);
			assert.equal(prompt.chain, "test");
			assert.equal(prompt.request.kind, "basketAccess");
			assert.equal(prompt.request.originator, APP);
			assert.deepEqual(prompt.request.payload.baskets, [
				{
					basket: BASKET,
					scope: "token outputs",
					description: "View the value outputs of this token",
					value: `${"a".repeat(64)}_0`,
				},
			]);
			assert.deepEqual(rawCalls, []);

			channel.emit({
				...createSessionEnvelope(session),
				type: "cwi-asset-permission-response",
				requestID: prompt.requestID,
				approved: true,
			});
			for (let i = 0; i < 4; i++) await tick();
			assert.deepEqual(
				responses().map((response) => [response.id, response.status]),
				[["first", "success"]],
			);

			// The saved basket grant answers the next read without a prompt.
			call("second");
			for (let i = 0; i < 4; i++) await tick();
			assert.equal(assetPrompts(channel).length, 1);
			assert.deepEqual(
				responses().map((response) => [response.id, response.status]),
				[
					["first", "success"],
					["second", "success"],
				],
			);
			assert.deepEqual(rawCalls, [
				[{ basket: BASKET }, APP],
				[{ basket: BASKET }, APP],
			]);
		} finally {
			unbind();
			relay.stop();
		}
	});

	test("a color send prompt carries the relay's chain and the transaction layout", async () => {
		Object.defineProperty(globalThis, "BroadcastChannel", {
			configurable: true,
			writable: true,
			value: FakeBroadcastChannel,
		});
		const handler = createColorTokenAccessHandler({
			promptHandler: requestAssetPermission,
			permissionStore: new InMemoryPermissionStore(),
			adminOriginator: ADMIN,
		});
		const send = JSON.stringify({
			type: "color_send",
			handoff: true,
			seekPermission: true,
			assets: [],
			destinations: [],
			satoshis: { inputs: 2, outputs: 1, fee: 1 },
			signatures: [],
			lockTime: 0,
		});
		// Stands in for the module's signAction, which asks during the app's call.
		const wallet = {
			signAction: async (_args: unknown, originator: string) => {
				if (!(await handler(originator, send)))
					throw new Error("BRC-207: the user declined the color_send request");
				return { txid: "signed" };
			},
		} as unknown as WalletPermissionsManager;
		const relay = new CWIRelay({
			getWallet: () => wallet,
			getStatus: () => "unlocked",
			walletHost: ADMIN,
		});
		relay.start();
		const channel = FakeBroadcastChannel.current;
		const unbind = bindAssetPermissionPromptHandler((request) =>
			relay.requestAssetPermission(request, "test"),
		);
		const opened = {
			sessionId: "color-send",
			sessionToken: "color-send-".padEnd(43, "x"),
			browserOrigin: `https://${APP}`,
			originator: APP,
		};
		channel.emit({ ...createSessionBase(opened), type: "cwi-session-open" });
		const { leaderId } = channel.sent.at(-1) as { leaderId: string };
		const session = { ...opened, leaderId };
		try {
			channel.emit({
				...createSessionEnvelope(session),
				type: "cwi-request",
				id: "sign",
				call: "signAction",
				args: { reference: "r", spends: {} },
			});
			await tick();
			await tick();
			const [prompt] = assetPrompts(channel);
			assert.ok(prompt);
			assert.equal(prompt.chain, "test");
			assert.equal(prompt.request.kind, "transaction");
			assert.equal(prompt.request.originator, APP);
			assert.equal(
				(prompt.request.payload as unknown as TransactionPrompt).title,
				"Token Handoff",
			);
			channel.emit({
				...createSessionEnvelope(session),
				type: "cwi-asset-permission-response",
				requestID: prompt.requestID,
				approved: false,
			});
			for (let i = 0; i < 4; i++) await tick();
			const response = channel.sent.find(
				(message) => (message as { type?: string }).type === "cwi-response",
			) as { id: string; status: string; description: string };
			assert.deepEqual([response.id, response.status], ["sign", "error"]);
			assert.match(response.description, /declined the color_send request/);
		} finally {
			unbind();
			relay.stop();
		}
	});
});
