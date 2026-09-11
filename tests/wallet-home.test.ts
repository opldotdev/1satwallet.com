import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PrivateKey } from "@bsv/sdk";
import {
	formatSatoshisAsBsv,
	isP2pkhAddressForChain,
	parseBsvAmount,
	sendFailureMessage,
} from "@/components/wallet/wallet-home-utils";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("wallet home amount parsing", () => {
	it("accepts exact BSV amounts and rejects unsafe inputs", () => {
		assert.equal(parseBsvAmount("0.00000001"), 1);
		assert.equal(parseBsvAmount("1.25"), 125_000_000);
		assert.equal(parseBsvAmount(" 2 "), 200_000_000);
		assert.equal(parseBsvAmount("0"), null);
		assert.equal(parseBsvAmount("1.000000001"), null);
		assert.equal(parseBsvAmount("1e-8"), null);
		assert.equal(parseBsvAmount("90071992.54740991"), Number.MAX_SAFE_INTEGER);
		assert.equal(parseBsvAmount("90071992.54740992"), null);
		assert.equal(
			formatSatoshisAsBsv(Number.MAX_SAFE_INTEGER),
			"90071992.54740991",
		);
	});

	it("accepts only P2PKH addresses for the active chain", () => {
		const publicKey = PrivateKey.fromHex("01".repeat(32)).toPublicKey();
		const mainnet = publicKey.toAddress("mainnet");
		const testnet = publicKey.toAddress("testnet");

		assert.equal(isP2pkhAddressForChain(mainnet, "main"), true);
		assert.equal(isP2pkhAddressForChain(mainnet, "test"), false);
		assert.equal(isP2pkhAddressForChain(testnet, "test"), true);
		assert.equal(isP2pkhAddressForChain(testnet, "main"), false);
		assert.equal(isP2pkhAddressForChain("not-an-address", "main"), false);
	});

	it("maps wallet failures without exposing provider payloads", () => {
		assert.match(sendFailureMessage("user rejected request"), /declined/);
		assert.match(sendFailureMessage("insufficient funds"), /enough spendable/);
		assert.match(
			sendFailureMessage({ secret: "do not display" }),
			/connection/,
		);
		assert.doesNotMatch(
			sendFailureMessage({ secret: "do not display" }),
			/secret|do not display/,
		);
	});

	it("does not collapse asset rows into a generic Unavailable label", () => {
		const status = read("components/wallet/wallet-home-status.tsx");
		assert.match(status, /describeAssetSurface/);
		assert.doesNotMatch(status, /balanceError\s*\n\s*\? "Unavailable"/);
		assert.match(read("components/nav-user.tsx"), /switchWallet/);
		assert.match(read("components/wallet/token-grid.tsx"), /bsv21State/);
		assert.match(read("components/wallet/token-grid.tsx"), /isBalanceLoading/);
	});

	it("keeps the provider-neutral action path isolated and invalidates history", () => {
		const source = read("components/wallet/wallet-home-actions.tsx");
		assert.doesNotMatch(
			source,
			/@\/providers\/wallet-provider|@\/lib\/wallet-(?:storage|backup|migration)|\bindexedDB\b|\bwalletKeys\b|\brootKey\b/,
		);
		assert.match(source, /sendBsv\.execute\(oneSatContext/);
		assert.match(source, /queryKey: \["wallet-actions"\]/);
		assert.match(source, /refreshBalance\(\)/);
		assert.match(source, /OPL-4014/);
		assert.match(source, /OPL-4015/);
	});
});

describe("payment success presentation", () => {
	it("mounts the decorative SVG with a drawn check, ten dashes and a reduced-motion final frame", async () => {
		const { PAY_SUCCESS_SVG } = await import(
			"@/components/wallet/pay-success-mark"
		);
		assert.match(PAY_SUCCESS_SVG, /aria-hidden="true"/);
		assert.match(PAY_SUCCESS_SVG, /viewBox="0 0 220 220"/);
		assert.equal(PAY_SUCCESS_SVG.match(/class="tick"/g)?.length, 10);
		assert.match(PAY_SUCCESS_SVG, /M88 110 L103 125 L133 95/);
		assert.match(PAY_SUCCESS_SVG, /prefers-reduced-motion: reduce/);
		assert.match(PAY_SUCCESS_SVG, /animation: none/);
		assert.doesNotMatch(
			PAY_SUCCESS_SVG,
			/<image|<script|<foreignObject|@import/,
		);
		const source = read("components/wallet/wallet-home-actions.tsx");
		assert.match(source, /<PaySuccessMark/);
		assert.doesNotMatch(source, /text-emerald-500|<Check\b/);
		assert.match(source, /bg-primary[^\n]*text-primary-foreground/);
		assert.match(source, /<DialogClose asChild>[\s\S]*?Done/);
		assert.match(source, /formatSatoshisAsBsv\(sendState.satoshis\)/);
	});

	it("unlocks before awaiting the send and only chimes for a new successful txid", () => {
		const source = read("components/wallet/wallet-home-actions.tsx");
		assert.ok(
			source.indexOf("preparePayChime();") <
				source.indexOf("await sendBsv.execute"),
		);
		assert.match(
			source,
			/sendState.status === "success"\s*&&\s*playedTxid.current !== sendState.txid/,
		);
		assert.equal(source.match(/play\("payChime"\)/g)?.length, 1);
		assert.match(source, /if \(result.error \|\| !result.txid\)/);
		const failedResult = source.slice(
			source.indexOf("if (result.error"),
			source.indexOf("txid: result.txid"),
		);
		assert.match(failedResult, /status: "error"[\s\S]*return;/);
	});
});
