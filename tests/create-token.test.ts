import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StandardPicker } from "../components/wallet/create-token";
import { TokenDraftFields } from "../components/wallet/token-draft-fields";
import {
	activeTokenStandard,
	EMPTY_TOKEN_DRAFT,
	parseDraftDecimals,
	tokenDetailHref,
	tokenStandardsFor,
} from "../lib/wallet/create-token";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const noop = () => {};

describe("token standards per chain", () => {
	it("offers BSV-21 alone on mainnet and both standards on testnet", () => {
		assert.deepEqual(tokenStandardsFor("main"), ["bsv21"]);
		assert.deepEqual(tokenStandardsFor("test"), ["bsv21", "1color"]);
	});

	it("never shows 1Color on a chain without it, whatever was picked", () => {
		assert.equal(activeTokenStandard("main", "1color"), "bsv21");
		assert.equal(activeTokenStandard("test", "1color"), "1color");
		assert.equal(activeTokenStandard("test", "bsv21"), "bsv21");
	});

	it("reads decimals only as a whole number", () => {
		assert.equal(parseDraftDecimals(" 8 "), 8);
		assert.equal(parseDraftDecimals("0"), 0);
		for (const text of ["", "1.5", "-1", "8a"]) {
			assert.ok(Number.isNaN(parseDraftDecimals(text)), text);
		}
	});

	it("opens each standard's own wallet page, never the market", () => {
		assert.equal(tokenDetailHref("bsv21", "ab_0"), "/wallet/bsv21/ab_0");
		assert.equal(tokenDetailHref("1color", "cd_1"), "/wallet/1color/cd_1");
	});
});

describe("Create token sheet", () => {
	it("draws the picker as two radios, the picked one checked, with its line", () => {
		const html = renderToStaticMarkup(
			createElement(StandardPicker, {
				standards: tokenStandardsFor("test"),
				value: "1color",
				onChange: noop,
				disabled: false,
			}),
		);
		assert.match(
			html,
			/role="radiogroup" aria-label="Token standard"|aria-label="Token standard"[^>]*role="radiogroup"/,
		);
		const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)];
		assert.equal(radios.length, 2);
		assert.match(html, /aria-checked="true"[^>]*>1Color</);
		assert.match(html, /aria-checked="false"[^>]*>BSV-21</);
		assert.match(html, /Sent to a handle/);
	});

	it("shows the picker only when the chain has more than one standard", () => {
		const sheet = read("components/wallet/create-token.tsx");
		assert.match(sheet, /const standards = tokenStandardsFor\(chain\);/);
		assert.match(sheet, /\{standards\.length > 1 \? \(\s*<StandardPicker/);
		assert.match(sheet, /const chain = useWalletChain\(\);/);
	});

	it("keeps the typed fields in the sheet, so a switch of standard keeps the symbol", () => {
		const sheet = read("components/wallet/create-token.tsx");
		assert.match(
			sheet,
			/const \[draft, setDraft\] = useState<TokenDraft>\(EMPTY_TOKEN_DRAFT\);/,
		);
		// Both forms get the same draft; the picker only changes `picked`.
		assert.match(sheet, /<OneColorDeployForm \{\.\.\.form\} \/>/);
		assert.match(sheet, /<Bsv21DeployForm \{\.\.\.form\} \/>/);
		assert.match(sheet, /onChange=\{setPicked\}/);
		assert.doesNotMatch(sheet, /setDraft\(EMPTY_TOKEN_DRAFT\);\s*\}, \[picked/);
		// Switching waits while a form signs or shows its review.
		assert.match(sheet, /disabled=\{status\.busy \|\| status\.reviewing\}/);
		for (const form of [
			"components/wallet/bsv21-deploy.tsx",
			"components/wallet/one-color-deploy.tsx",
		]) {
			const source = read(form);
			assert.match(source, /<TokenDraftFields/, form);
			assert.doesNotMatch(source, /<DialogContent|<Dialog\b/, form);
		}
	});

	it("renders the typed symbol in the shared fields", () => {
		const html = renderToStaticMarkup(
			createElement(TokenDraftFields, {
				draft: { ...EMPTY_TOKEN_DRAFT, symbol: "KEEP" },
				onDraftChange: noop,
				symbolMaxLength: 32,
				mintableHint: "",
			}),
		);
		assert.match(
			html,
			/id="create-token-symbol"[^>]*value="KEEP"|value="KEEP"[^>]*id="create-token-symbol"/,
		);
		const order = ["Symbol", "Decimals", "Supply type", "Supply"].map((label) =>
			html.indexOf(`>${label}</label>`),
		);
		assert.ok(
			order.every((at) => at >= 0),
			String(order),
		);
		assert.deepEqual(
			[...order].sort((a, b) => a - b),
			order,
		);
	});

	it("asks the person to check before an irreversible create, with no developer copy", () => {
		for (const form of [
			"components/wallet/bsv21-deploy.tsx",
			"components/wallet/one-color-deploy.tsx",
		]) {
			const source = read(form);
			assert.match(source, /\{review \? "Create token" : "Review"\}/, form);
			assert.doesNotMatch(
				source,
				/Authorize irreversible|Atomic supply|canonical/,
				form,
			);
		}
	});
});

describe("Tokens section", () => {
	it("links every row to the wallet's own token page, never the market", () => {
		for (const file of [
			"components/wallet/token-grid.tsx",
			"components/wallet/one-color-grid.tsx",
			"components/wallet/token-row.tsx",
			"components/wallet/tokens-section.tsx",
			"components/wallet/create-token.tsx",
		]) {
			assert.doesNotMatch(read(file), /\/market/, file);
		}
		assert.match(
			read("components/wallet/token-grid.tsx"),
			/href=\{tokenDetailHref\("bsv21", token\.id\)\}/,
		);
		assert.match(
			read("components/wallet/one-color-grid.tsx"),
			/href=\{tokenDetailHref\("1color", token\.assetId\)\}/,
		);
	});

	it("offers Retry on a failed BSV-21 read and shows one spendable amount", () => {
		const grid = read("components/wallet/token-grid.tsx");
		assert.match(grid, /<Button onClick=\{refreshBalance\} variant="outline">/);
		assert.match(grid, /state\.kind === "error"/);
		for (const file of [
			"components/wallet/token-grid.tsx",
			"components/wallet/bsv21-detail.tsx",
		]) {
			const source = read(file);
			// @1sat/actions reads spendable outputs only: nothing is pending.
			assert.doesNotMatch(source, /all\.(pending|confirmed)/, file);
			assert.match(source, /<Bsv21Unreadable state=\{bsv21State\} \/>/, file);
		}
		assert.match(grid, /const balance = bsv21Spendable\(token\);/);
		assert.match(
			read("components/wallet/bsv21-detail.tsx"),
			/balance=\{formatBsv21Amount\(bsv21Spendable\(token\), token\.dec\)\}/,
		);
	});

	it("keeps the 1Color heading through every state of its group", () => {
		const grid = read("components/wallet/one-color-grid.tsx");
		const group = grid.slice(
			grid.indexOf("export default function OneColorGrid"),
		);
		assert.match(group, /content = <TokenRowsSkeleton \/>;/);
		assert.match(group, /content = <OneColorExternalWallet \/>;/);
		assert.match(group, /<TokenGroup[\s\S]*id="tokens-1color"/);
		assert.doesNotMatch(grid, /<OneColorGate/);
	});

	it("links the market from a BSV-21 token's page on mainnet only", () => {
		const detail = read("components/wallet/bsv21-detail.tsx");
		assert.match(detail, /isRouteAvailableOn\(chain, marketHref\)/);
		assert.match(detail, /View market/);
	});

	it("shares one detail layout between the standards", () => {
		for (const file of [
			"components/wallet/bsv21-detail.tsx",
			"components/wallet/one-color-detail.tsx",
		]) {
			assert.match(read(file), /<TokenDetailLayout/, file);
		}
		const page = read("app/(main)/wallet/bsv21/[tokenId]/page.tsx");
		assert.match(page, /if \(!isBsv21TokenId\(tokenId\)\) notFound\(\);/);
	});

	it("builds the overview's Assets rows from the chain's tabs", () => {
		const status = read("components/wallet/wallet-home-status.tsx");
		assert.match(status, /walletTabsFor\(useWalletChain\(\)\)\.filter\(/);
		assert.doesNotMatch(status, /"\/wallet\/bsv21"|"BSV21"/);
	});
});
