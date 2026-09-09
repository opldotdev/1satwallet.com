import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WalletOutput } from "@1sat/actions";
import {
	LEGACY_ORDINAL_BASKETS,
	mergeWalletOutputs,
} from "@/lib/wallet/ordinal-inventory";

const output = (outpoint: string): WalletOutput =>
	({
		outpoint,
		satoshis: 1,
		spendable: true,
	}) as WalletOutput;

describe("ordinal inventory merge", () => {
	it("keeps leftover Yours and theme-token baskets after the preferred 1sat list", () => {
		assert.deepEqual(LEGACY_ORDINAL_BASKETS, ["p 1sat ordinals", "ordinals"]);
		assert.deepEqual(
			mergeWalletOutputs([
				[output("aa.0"), output("bb.0")],
				[output("aa.0"), output("cc.0")],
				[output("dd.0")],
			]).map((item) => item.outpoint),
			["aa.0", "bb.0", "cc.0", "dd.0"],
		);
	});
});
