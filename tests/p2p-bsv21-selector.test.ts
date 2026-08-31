import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Bsv21Balance } from "@1sat/actions";
import {
	createBsv21OfferItem,
	getSafeBsv21OfferImage,
	toBsv21OfferToken,
} from "../lib/p2p-bsv21-offer";

const TOKEN_ID = `${"ab".repeat(32)}_1`;

function balance(overrides: Partial<Bsv21Balance> = {}): Bsv21Balance {
	return {
		p: "bsv-20",
		id: TOKEN_ID,
		sym: "TOK",
		dec: 8,
		amt: "123456789",
		all: { confirmed: 123456789n, pending: 0n },
		listed: { confirmed: 0n, pending: 0n },
		...overrides,
	};
}

describe("P2P BSV21 inventory selection", () => {
	it("normalizes provider balances into safe display-only token metadata", () => {
		const token = toBsv21OfferToken(
			balance({
				id: TOKEN_ID.toUpperCase().replace("_", "."),
				sym: "  MY   TOKEN  ",
				icon: `${"cd".repeat(32)}.2`,
			}),
		);
		assert.ok(token);
		assert.equal(token.id, TOKEN_ID);
		assert.equal(token.name, "MY TOKEN");
		assert.equal(token.balanceDisplay, "1.23456789");
		assert.match(token.image ?? "", /^\/api\/image\?/);
	});

	it("converts display quantities to exact atomic strings", () => {
		const token = toBsv21OfferToken(balance());
		assert.ok(token);
		assert.deepEqual(createBsv21OfferItem(token, "1.00000001"), {
			ok: true,
			item: {
				type: "bsv21",
				id: TOKEN_ID,
				name: "TOK",
				amount: "100000001",
				decimals: 8,
			},
		});
	});

	it("rejects zero, negative, exponent, overprecision, and excess amounts", () => {
		const token = toBsv21OfferToken(balance());
		assert.ok(token);
		for (const amount of ["0", "-1", "1e2", "0.000000001", "1.23456790"]) {
			assert.equal(createBsv21OfferItem(token, amount).ok, false, amount);
		}
		assert.equal(createBsv21OfferItem(token, "1.23456789").ok, true);
	});

	it("filters malformed wallet metadata instead of publishing it", () => {
		assert.equal(toBsv21OfferToken(balance({ id: "not-a-token" })), null);
		assert.equal(toBsv21OfferToken(balance({ dec: 19 })), null);
		assert.equal(toBsv21OfferToken(balance({ amt: "1e8" })), null);
		assert.equal(toBsv21OfferToken(balance({ amt: "0" })), null);
		assert.equal(
			getSafeBsv21OfferImage(TOKEN_ID, "http://127.0.0.1/private.png"),
			undefined,
		);
		assert.equal(
			getSafeBsv21OfferImage(TOKEN_ID, "https://example.com/token.png"),
			undefined,
		);
		assert.equal(
			getSafeBsv21OfferImage(
				TOKEN_ID,
				"https://user:password@api.1sat.app/content/token_0",
			),
			undefined,
		);
		assert.equal(
			getSafeBsv21OfferImage(
				TOKEN_ID,
				`https://api.1sat.app/content/${"cd".repeat(32)}_0`,
			),
			`https://api.1sat.app/content/${"cd".repeat(32)}_0`,
		);
	});

	it("uses only the provider's standard BSV21 inventory beside ordinals", () => {
		const source = readFileSync(
			join(process.cwd(), "components/landing/inventory-selector.tsx"),
			"utf8",
		);
		assert.match(source, /bsv21Tokens/);
		assert.match(source, /TabsTrigger value="ordinal"/);
		assert.match(source, /TabsTrigger value="bsv21"/);
		assert.match(source, /createBsv21OfferItem/);
		assert.doesNotMatch(source, /legacy|listBsv21|permission-module/i);
	});
});
