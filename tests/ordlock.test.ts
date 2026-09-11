import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OneSatContext } from "@1sat/actions";
import { executeOwnedOpnsOperation, opnsFailureMessage } from "@/lib/opns";
import {
	assertListingCreateAllowed,
	LISTING_CREATE_OFF_MESSAGE,
	listingCreateDisabledBody,
	ORDLOCK_BUY_ENABLED,
	ORDLOCK_CANCEL_ENABLED,
	ORDLOCK_LISTING_DISABLED,
	ORDLOCK_WALLET_RUNTIME,
} from "@/lib/ordlock";
import {
	executeOrdinalOperation,
	type OrdinalActionSet,
	ordinalActionFailureMessage,
} from "@/lib/wallet/ordinal-actions";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("ordlock listing create-off", () => {
	it("marks create off and keeps buy/cancel on", () => {
		assert.equal(ORDLOCK_LISTING_DISABLED, true);
		assert.equal(ORDLOCK_BUY_ENABLED, true);
		assert.equal(ORDLOCK_CANCEL_ENABLED, true);
		assert.equal(ORDLOCK_WALLET_RUNTIME, true);
	});

	it("throws a deprecation error on create", () => {
		assert.throws(assertListingCreateAllowed, /listing create is disabled/i);
		const body = listingCreateDisabledBody();
		assert.equal(body.create, false);
		assert.equal(body.buy, true);
		assert.equal(body.cancel, true);
	});

	it("blocks ordinal sell dispatch and still runs cancel", async () => {
		const calls: string[] = [];
		const actions: OrdinalActionSet = {
			send: async () => ({ txid: "send" }),
			burn: async () => ({ txid: "burn" }),
			sell: async () => {
				calls.push("sell");
				return { txid: "sell" };
			},
			cancel: async () => {
				calls.push("cancel");
				return { txid: "cancel" };
			},
		};
		const ctx = {} as OneSatContext;
		await assert.rejects(
			() =>
				executeOrdinalOperation(
					ctx,
					{ kind: "sell", id: "one", price: 123 },
					actions,
				),
			/listing create is disabled/i,
		);
		const cancel = await executeOrdinalOperation(
			ctx,
			{ kind: "cancel", id: "one" },
			actions,
		);
		assert.deepEqual(calls, ["cancel"]);
		assert.equal(cancel.txid, "cancel");
		assert.equal(
			ordinalActionFailureMessage(new Error(LISTING_CREATE_OFF_MESSAGE)),
			LISTING_CREATE_OFF_MESSAGE,
		);
	});

	it("blocks OpNS sell dispatch", async () => {
		await assert.rejects(
			() =>
				executeOwnedOpnsOperation({} as OneSatContext, {
					kind: "sell",
					id: "one",
					price: 123,
				}),
			/listing create is disabled/i,
		);
		assert.equal(
			opnsFailureMessage(new Error(LISTING_CREATE_OFF_MESSAGE)),
			LISTING_CREATE_OFF_MESSAGE,
		);
	});

	it("hides create entry points and keeps buy/cancel sources", () => {
		const source = [
			"lib/ordlock.ts",
			"lib/wallet/ordinal-actions.ts",
			"lib/opns.ts",
			"components/wallet/ordinals-grid.tsx",
			"components/wallet/ordinal-action-dialog.tsx",
			"components/opns/owned-opns.tsx",
			"components/opns/opns-action-dialog.tsx",
			"components/market/list-ordinal-dialog.tsx",
			"components/market/buy-button.tsx",
			"components/market/my-ordinal-listings.tsx",
			"components/opns/opns-buy-button.tsx",
		]
			.map(read)
			.join("\n");
		assert.match(source, /ORDLOCK_LISTING_DISABLED/);
		assert.match(source, /LISTING_CREATE_OFF_MESSAGE/);
		assert.match(source, /buyOrdinal\.execute/);
		assert.match(source, /buyOpns\.execute/);
		assert.match(source, /cancelOrdinalListing/);
		assert.match(source, /cancelOpnsListing\.execute/);
		assert.doesNotMatch(source, /setDialogKind\("sell"\)/);
		assert.doesNotMatch(source, /setAction\(\{ kind: "sell"/);
		assert.match(
			read("lib/wallet/ordinal-actions.ts"),
			/assertListingCreateAllowed/,
		);
		assert.match(read("lib/opns.ts"), /assertListingCreateAllowed/);
		assert.doesNotMatch(
			read("components/market/list-ordinal-dialog.tsx"),
			/sellOrdinal/,
		);
	});
});
