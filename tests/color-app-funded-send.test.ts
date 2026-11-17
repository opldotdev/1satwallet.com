// An app's token send through the permissions manager where the 1Color module
// funds the token inputs from the wallet. The manager's spending prompt is not
// the gate for those inputs (toolbox 2.17.0 computes an app's spend from the
// args after the module changed them, so module-added inputs are subtracted
// from it), so the color_send consent must be asked before anything is signed.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PromptRequest } from "@1sat/permission-module";
import { OneColor } from "@1sat/templates";
import { InMemoryPermissionStore } from "@1sat/wallet-browser";
import {
	assetBasket,
	ColorConsentDeclinedError,
	createColorModule,
} from "@bsv/color-permission-module";
import {
	Beef,
	Hash,
	LockingScript,
	P2PKH,
	PrivateKey,
	Transaction,
	Utils,
	type WalletInterface,
} from "@bsv/sdk";
import { WalletPermissionsManager } from "@bsv/wallet-toolbox-client";
import { createColorTokenAccessHandler } from "@/lib/cwi/color-consent";
import { clearDiagnostics } from "@/lib/runtime-diagnostics";
import { appGatedColorModule } from "@/lib/wallet/color-module";
import { guardModuleIdentifiers } from "@/lib/wallet/module-identifier-guard";
import { oneColorSendPlanLabels } from "@/lib/wallet/one-color-actions";
import { PERMISSIONS_CONFIG } from "@/lib/wallet/permissions-config";

const ADMIN = "1satwallet.com";
const APP = "app.example.com";
const OWN_KEY = PrivateKey.fromRandom().toPublicKey().toString();
const pkh = (publicKey: string) =>
	Hash.hash160(Utils.toArray(publicKey, "hex"));

const originalError = console.error;
beforeEach(() => {
	console.error = () => {};
});
afterEach(() => {
	console.error = originalError;
	clearDiagnostics();
});

/** The asset's deploy, and a transaction holding 100 of it for this wallet. */
const holding = () => {
	const deploy = new Transaction();
	deploy.addOutput({
		satoshis: 1,
		lockingScript: OneColor.deployValue(1000n, { lock: pkh(OWN_KEY) }).lock(),
	});
	const assetId = `${deploy.id("hex")}_0`;
	const held = new Transaction();
	held.addInput({
		sourceTransaction: deploy,
		sourceOutputIndex: 0,
		unlockingScript: new LockingScript(),
	});
	held.addOutput({
		satoshis: 1,
		lockingScript: OneColor.value(assetId, 100n, {
			lock: pkh(OWN_KEY),
		}).lock(),
	});
	return { deploy, assetId, held };
};

type Call = { method: string; args: Record<string, unknown> };

const setup = () => {
	const { deploy, assetId: ASSET, held } = holding();
	const deployOutpoint = `${deploy.id("hex")}.0`;
	const outpoint = `${held.id("hex")}.0`;
	const suffixTag = `p color ${"cd".repeat(32)}`;
	const custody = JSON.stringify({
		version: 1,
		assetId: ASSET,
		derivationPrefix: "cHJlZml4",
		derivationSuffix: "c3VmZml4",
		senderIdentityKey: OWN_KEY,
	});
	const heldOutput = {
		outpoint,
		satoshis: 1,
		spendable: true,
		lockingScript: held.outputs[0].lockingScript.toHex(),
		customInstructions: custody,
		tags: [suffixTag],
	};
	const calls: Call[] = [];
	// The raw wallet the manager wraps: it holds the token output above.
	const wallet = new Proxy(
		{},
		{
			get: (_target, prop: string) => async (args: Record<string, unknown>) => {
				calls.push({ method: prop, args });
				switch (prop) {
					case "getPublicKey":
						return { publicKey: OWN_KEY };
					case "encrypt":
						return { ciphertext: [1, 2, 3] };
					case "listOutputs":
						if (args.basket !== assetBasket(ASSET, "value"))
							return { totalOutputs: 0, outputs: [] };
						if (args.include === "entire transactions") {
							const beef = new Beef();
							beef.mergeTransaction(held);
							return {
								totalOutputs: 1,
								outputs: [heldOutput],
								BEEF: beef.toBinary(),
							};
						}
						return { totalOutputs: 1, outputs: [heldOutput] };
					case "createAction": {
						// Builds the action as the wallet would, from the funded args.
						const beef = Beef.fromBinary(args.inputBEEF as number[]);
						const tx = new Transaction();
						for (const input of args.inputs as { outpoint: string }[]) {
							const [txid, vout] = input.outpoint.split(".");
							const source = beef.findTransactionForSigning(txid);
							assert.ok(source);
							tx.addInput({
								sourceTransaction: source,
								sourceOutputIndex: Number(vout),
								unlockingScript: new LockingScript(),
							});
						}
						// The wallet's own satoshis pay the fee, with change back.
						const fee = new Transaction();
						fee.addOutput({
							satoshis: 10,
							lockingScript: new P2PKH().lock(pkh(OWN_KEY)),
						});
						tx.addInput({
							sourceTransaction: fee,
							sourceOutputIndex: 0,
							unlockingScript: new LockingScript(),
						});
						for (const output of args.outputs as {
							lockingScript: string;
							satoshis: number;
						}[])
							tx.addOutput({
								satoshis: output.satoshis,
								lockingScript: LockingScript.fromHex(output.lockingScript),
							});
						tx.addOutput({
							satoshis: 8,
							lockingScript: new P2PKH().lock(pkh(OWN_KEY)),
						});
						return {
							signableTransaction: {
								reference: "cmVmZXJlbmNl",
								tx: tx.toAtomicBEEF(),
							},
						};
					}
					case "abortAction":
						return { aborted: true };
					default:
						throw new Error(`raw ${prop} not faked`);
				}
			},
		},
	) as WalletInterface;
	// The asset's overlay: the held output is admitted and unspent.
	const provider = {
		spendability: async (_assetId: string, outpoints: string[]) => ({
			type: "output-list" as const,
			outputs: outpoints.includes(outpoint)
				? [{ beef: held.toBEEF(), txid: held.id("hex"), outputIndex: 0 }]
				: [],
		}),
		admission: async (_assetId: string, outpoints: string[]) => ({
			type: "output-list" as const,
			outputs: outpoints.includes(deployOutpoint)
				? [{ beef: deploy.toBEEF(), txid: deploy.id("hex"), outputIndex: 0 }]
				: [],
		}),
		submit: async () => ({}),
	};
	const colorPrompts: PromptRequest[] = [];
	// The provider's wiring (lib/wallet/color-module.ts), with this overlay.
	const module = createColorModule({
		wallet,
		provider: provider as unknown as Parameters<
			typeof createColorModule
		>[0]["provider"],
		requestTokenAccess: createColorTokenAccessHandler({
			promptHandler: async (request) => {
				colorPrompts.push(request);
				return false;
			},
			permissionStore: new InMemoryPermissionStore(),
			adminOriginator: ADMIN,
		}),
	});
	const manager = guardModuleIdentifiers(
		new WalletPermissionsManager(wallet, ADMIN, {
			...PERMISSIONS_CONFIG,
			permissionModules: { color: appGatedColorModule(module, ADMIN) },
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
	return { manager, calls, colorPrompts, prompts, outpoint, asset: ASSET };
};

describe("an app's token send funded by the color module", () => {
	it("asks the color_send consent before anything is signed", async () => {
		const { manager, calls, colorPrompts, outpoint, asset } = setup();
		const recipient = PrivateKey.fromRandom().toPublicKey().toString();
		await assert.rejects(
			manager.createAction(
				{
					description: "send tokens",
					labels: oneColorSendPlanLabels(asset),
					outputs: [
						{
							satoshis: 1,
							lockingScript: OneColor.value(asset, 40n, {
								lock: pkh(recipient),
							})
								.lock()
								.toHex(),
							outputDescription: "tokens to a friend",
						},
					],
					options: { randomizeOutputs: false },
				},
				APP,
			),
			ColorConsentDeclinedError,
		);
		// The module funded the send from the wallet's own token output...
		const created = calls.find((call) => call.method === "createAction");
		assert.ok(created);
		assert.deepEqual(
			(created.args.inputs as { outpoint: string }[]).map(
				(input) => input.outpoint,
			),
			[outpoint],
		);
		// ...and the user was asked about the token move, which they declined,
		// so nothing was signed and the action was aborted.
		assert.equal(colorPrompts.length, 1);
		assert.equal(colorPrompts[0].kind, "transaction");
		assert.equal(colorPrompts[0].originator, APP);
		assert.match(colorPrompts[0].summary ?? "", /^Send 1 token leg$/);
		// The prompt shows the module-funded input the app never named.
		const payload = colorPrompts[0].payload as {
			panels: { meta?: { key: string; value: string }[] }[];
		};
		const leg = payload.panels[0].meta ?? [];
		assert.deepEqual(
			["Your inputs", "Kept", "Outgoing"].map(
				(key) => leg.find((row) => row.key === key)?.value,
			),
			["100", "60", "40"],
		);
		const methods = calls.map((call) => call.method);
		assert.ok(!methods.includes("signAction"));
		assert.ok(!methods.includes("createSignature"));
		assert.ok(methods.includes("abortAction"));
	});
});
