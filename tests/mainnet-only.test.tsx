import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MainnetOnly } from "../components/mainnet-only";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("mainnet-only guard", () => {
	it("server-renders the page so mainnet keeps its SEO", () => {
		assert.equal(
			renderToString(
				<MainnetOnly>
					<p>market page</p>
				</MainnetOnly>,
			),
			"<p>market page</p>",
		);
	});

	it("switches to the notice by the client's network after hydration", () => {
		const source = read("components/mainnet-only.tsx");
		assert.match(
			source,
			/useWalletChain\(\) === "main" \? children : fallback/,
		);
		assert.match(
			read("components/not-on-testnet.tsx"),
			/Not available on testnet/,
		);
	});

	it("hides the outpoint buy button on testnet", () => {
		assert.match(
			read("app/(main)/outpoint/[outpoint]/page.tsx"),
			/<MainnetOnly fallback=\{null\}>\s*<BuyButton/,
		);
	});
});
