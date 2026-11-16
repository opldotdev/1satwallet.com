import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRewrittenUrl, isRewrite } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { NOT_ON_TESTNET_PATH, proxy } from "../proxy";

const request = (path: string, chain?: string) =>
	new NextRequest(`https://1satwallet.com${path}`, {
		headers: {
			host: "1satwallet.com",
			...(chain ? { cookie: `1sat-wallet-chain=${chain}` } : {}),
		},
	});

const MAINNET_ONLY = [
	"/market/ordinals",
	"/market/bsv21/abc_0",
	"/opns",
	"/opns/satoshi",
	"/inscribe",
	"/activity",
	"/wallet/opns",
	"/wallet/migrate",
];

describe("testnet proxy", () => {
	it("serves the static notice for mainnet-only pages on testnet", () => {
		for (const path of MAINNET_ONLY) {
			const response = proxy(request(path, "test"));
			assert.equal(isRewrite(response), true, path);
			assert.equal(
				getRewrittenUrl(response),
				`https://1satwallet.com${NOT_ON_TESTNET_PATH}`,
				path,
			);
			assert.match(response.headers.get("cache-control") ?? "", /no-store/);
			assert.match(
				response.headers.get("content-security-policy") ?? "",
				/frame-ancestors 'self'/,
			);
		}
	});

	it("leaves mainnet and other pages alone", () => {
		for (const path of MAINNET_ONLY) {
			for (const chain of [undefined, "main", "testnet", ""]) {
				assert.equal(isRewrite(proxy(request(path, chain))), false, path);
			}
		}
		for (const path of [
			"/",
			"/wallet",
			"/wallet/bsv21",
			"/marketing",
			"/settings",
		]) {
			assert.equal(isRewrite(proxy(request(path, "test"))), false, path);
		}
	});
});
