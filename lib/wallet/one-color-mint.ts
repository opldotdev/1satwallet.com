/**
 * 1Color (BRC-162) mint from an authority this wallet holds, through the
 * wallet's BRC-207 `color` module. Written like `@1sat/actions` `deploy1Color`
 * so it can move there as `mint1Color`; `@1sat/actions` 0.1.6 has no mint.
 *
 * The reference is the module's own test, "mints with a selected authority
 * and keeps a replacement authority" (`ColorPermissionModule.operations.test.ts`).
 * One `createAction` on `colorContext.wallet`: each kept output gets a fresh
 * custody, the outputs are a value output of `amount` (when > 0) then a
 * continuing authority (unless `endMinting`), and the labels carry the plan
 * `[mint, authority-transfer]`, `[mint, authority-end]` or `[authority-end]`.
 * No inputs are passed: the module selects one authority from the asset's
 * authority basket, signs it and submits the mint to `tm_color_<assetId>`.
 */

import type { Action, OneSatContext } from "@1sat/actions";
import { ONE_COLOR_MAX_AMOUNT, OneColor } from "@1sat/templates";
import {
	COLOR_KEY_ID,
	type ColorOperation,
	ColorPlan,
	type ColorRemittance,
	colorProtocolID,
} from "@bsv/color-permission-module";
import { type CreateActionOutput, PublicKey, Utils } from "@bsv/sdk";

export interface Mint1ColorInput {
	/** The asset, `<txid>_<vout>` */
	assetId: string;
	/** Units to mint: > 0, or 0 together with `endMinting` */
	amount: string | bigint;
	/** Spend the authority without a replacement: no more can ever be minted from it */
	endMinting?: boolean;
}

export interface Mint1ColorResponse {
	txid?: string;
	/** AtomicBEEF of the mint transaction */
	tx?: number[];
	assetId?: string;
	/** `<txid>.<vout>` of the continuing authority; absent when minting ended */
	authorityOutpoint?: string;
	error?: string;
}

const ASSET_ID = /^[0-9a-f]{64}_\d+$/;

/** A BRC-207 remittance string: base64 of 16 random bytes (`randomBase64` in `@1sat/actions`). */
const randomBase64 = (): string =>
	Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(16))));

/** A new output of this wallet for `assetId`, with the custody the module checks. */
async function keptOutput(
	ctx: OneSatContext,
	assetId: string,
	identityKey: string,
	outputIndex: number,
): Promise<{ remittance: ColorRemittance; lock: number[] }> {
	const remittance: ColorRemittance = {
		outputIndex,
		assetId,
		derivationPrefix: randomBase64(),
		derivationSuffix: randomBase64(),
		senderIdentityKey: identityKey,
	};
	const { publicKey } = await ctx.wallet.getPublicKey({
		protocolID: colorProtocolID(
			assetId,
			remittance.derivationPrefix,
			remittance.derivationSuffix,
		),
		keyID: COLOR_KEY_ID,
		counterparty: "self",
		forSelf: true,
	});
	return {
		remittance,
		lock: PublicKey.fromString(publicKey).toHash() as number[],
	};
}

/** Mints to this wallet from an authority it holds; see the module comment. */
export async function mintOneColor(
	ctx: OneSatContext,
	input: Mint1ColorInput,
): Promise<Mint1ColorResponse> {
	try {
		if (!ASSET_ID.test(input.assetId)) {
			return { error: "invalid-asset-id: expected <txid>_<vout>" };
		}
		const amount =
			typeof input.amount === "string" ? BigInt(input.amount) : input.amount;
		const endMinting = input.endMinting === true;
		if (amount < 0n || amount > ONE_COLOR_MAX_AMOUNT) {
			return { error: "amount-out-of-range" };
		}
		if (amount === 0n && !endMinting) {
			return { error: "amount-must-be-positive" };
		}
		const { assetId } = input;

		const { publicKey: identityKey } = await ctx.wallet.getPublicKey({
			identityKey: true,
		});
		const outputs: CreateActionOutput[] = [];
		const ownedOutputs: ColorRemittance[] = [];
		const operations: ColorOperation[] = [];
		if (amount > 0n) {
			const value = await keptOutput(ctx, assetId, identityKey, outputs.length);
			outputs.push({
				lockingScript: OneColor.value(assetId, amount, { lock: value.lock })
					.lock()
					.toHex(),
				satoshis: 1,
				outputDescription: "Minted 1Color tokens",
			});
			ownedOutputs.push(value.remittance);
			operations.push({ assetId, operation: "mint" });
		}
		let authorityIndex: number | undefined;
		if (!endMinting) {
			authorityIndex = outputs.length;
			const authority = await keptOutput(
				ctx,
				assetId,
				identityKey,
				authorityIndex,
			);
			outputs.push({
				lockingScript: OneColor.authority(assetId, { lock: authority.lock })
					.lock()
					.toHex(),
				satoshis: 1,
				outputDescription: "1Color mint authority",
			});
			ownedOutputs.push(authority.remittance);
		}
		operations.push({
			assetId,
			operation: endMinting ? "authority-end" : "authority-transfer",
		});

		const created = await ctx.wallet.createAction({
			description:
				amount === 0n
					? "End 1Color minting"
					: endMinting
						? `Mint ${amount} 1Color tokens and end minting`
						: `Mint ${amount} 1Color tokens`,
			outputs,
			labels: ColorPlan.toLabels({
				version: 1,
				assets: [assetId],
				ownedOutputs,
				operations,
				inputPositions: [],
				changePositions: [],
				sighashTypes: [],
			}),
			options: { randomizeOutputs: false },
		});
		if (!created.txid || !created.tx) return { error: "no-transaction" };
		return {
			txid: created.txid,
			tx: Array.from(created.tx),
			assetId,
			...(authorityIndex === undefined
				? {}
				: { authorityOutpoint: `${created.txid}.${authorityIndex}` }),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export const mint1Color: Action<Mint1ColorInput, Mint1ColorResponse> = {
	meta: {
		name: "mint1Color",
		description:
			"Mint 1Color (BRC-162) units to this wallet from a mint authority it holds, through the wallet's BRC-207 color module. The authority continues in a new output unless endMinting is set.",
		category: "tokens",
		inputSchema: {
			type: "object",
			properties: {
				assetId: { type: "string", description: "Asset id, <txid>_<vout>" },
				amount: {
					type: "string",
					description:
						"Units to mint as a string for bigint: > 0, or 0 with endMinting",
				},
				endMinting: {
					type: "boolean",
					description:
						"Spend the authority without a replacement: minting ends for good",
				},
			},
			required: ["assetId", "amount"],
		},
	},
	execute: mintOneColor,
};
