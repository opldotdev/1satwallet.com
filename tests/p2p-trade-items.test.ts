import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseP2PTradeItem, parseP2PTradeItems } from "../lib/p2p-trade-items";

const TOKEN_ID = `${"ab".repeat(32)}_1`;

describe("P2P trade item contract", () => {
	it("accepts a canonical value-based BSV21 offer", () => {
		assert.deepEqual(
			parseP2PTradeItem({
				type: "bsv21",
				id: TOKEN_ID,
				amount: "2100000000000000",
				name: "Twenty One",
				decimals: 8,
				image: "https://api.1sat.app/content/example_0",
			}),
			{
				type: "bsv21",
				id: TOKEN_ID,
				amount: "2100000000000000",
				name: "Twenty One",
				decimals: 8,
				image: "https://api.1sat.app/content/example_0",
			},
		);
	});

	it("rejects non-canonical token ids", () => {
		for (const id of [
			TOKEN_ID.toUpperCase(),
			TOKEN_ID.replace("_", "."),
			`${"ab".repeat(32)}_01`,
			`${"ab".repeat(31)}_1`,
		]) {
			assert.throws(() =>
				parseP2PTradeItem({
					type: "bsv21",
					id,
					amount: "1",
					name: "Token",
				}),
			);
		}
	});

	it("requires positive canonical atomic amounts", () => {
		for (const amount of ["", "0", "-1", "+1", "01", "1.0", " 1", 1]) {
			assert.throws(() =>
				parseP2PTradeItem({
					type: "bsv21",
					id: TOKEN_ID,
					amount,
					name: "Token",
				}),
			);
		}
	});

	it("limits display decimals to integer values from zero through eighteen", () => {
		for (const decimals of [0, 18]) {
			const item = parseP2PTradeItem({
				type: "bsv21",
				id: TOKEN_ID,
				amount: "1",
				name: "Token",
				decimals,
			});
			assert.equal(item.type, "bsv21");
			assert.equal(item.decimals, decimals);
		}
		for (const decimals of [-1, 19, 1.5, "8"]) {
			assert.throws(() =>
				parseP2PTradeItem({
					type: "bsv21",
					id: TOKEN_ID,
					amount: "1",
					name: "Token",
					decimals,
				}),
			);
		}
	});

	it("rejects BSV21 spend tips and other undeclared fields", () => {
		for (const extra of [
			{ outpoint: `${"cd".repeat(32)}_0` },
			{ txid: "cd".repeat(32), vout: 0 },
			{ satoshis: 1 },
			{ tips: [`${"cd".repeat(32)}_0`] },
		]) {
			assert.throws(() =>
				parseP2PTradeItem({
					type: "bsv21",
					id: TOKEN_ID,
					amount: "1",
					name: "Token",
					...extra,
				}),
			);
		}
	});

	it("requires ordinal identity fields to agree with its canonical outpoint", () => {
		const id = `${"cd".repeat(32)}_2`;
		assert.deepEqual(
			parseP2PTradeItem({
				type: "ordinal",
				id,
				name: "Ordinal",
				txid: "cd".repeat(32),
				vout: 2,
				satoshis: 1,
			}),
			{
				type: "ordinal",
				id,
				name: "Ordinal",
				txid: "cd".repeat(32),
				vout: 2,
				satoshis: 1,
			},
		);
		assert.throws(() =>
			parseP2PTradeItem({
				type: "ordinal",
				id,
				name: "Ordinal",
				txid: "cd".repeat(32),
				vout: 3,
			}),
		);
	});

	it("rejects duplicate assets and oversized offers", () => {
		const item = {
			type: "bsv21",
			id: TOKEN_ID,
			amount: "1",
			name: "Token",
		};
		assert.throws(() => parseP2PTradeItems([item, item]));
		assert.throws(() =>
			parseP2PTradeItems(Array.from({ length: 25 }, () => item)),
		);
	});
});
