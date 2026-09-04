import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("wallet loading skeleton", () => {
	it("mirrors the loaded page regions with a polite loading status", () => {
		const source = read("app/(main)/wallet/loading.tsx");
		assert.match(source, /role="status"/);
		assert.match(source, /aria-live="polite"/);
		assert.match(source, /sr-only/);
		assert.match(source, /Loading wallet/);
		// Tabs row matching the loaded WalletTabs region.
		assert.match(source, /h-9/);
		// Balance region matching the spendable-balance card.
		assert.match(source, /h-10 w-60/);
		// Five status cards matching WalletHomeStatus (ordinals, BSV21,
		// address sync, payment inbox, token inbox).
		assert.match(source, /xl:grid-cols-5/);
		const fiveCardGrid = source.match(/xl:grid-cols-5[\s\S]*?<\/div>/);
		assert.ok(fiveCardGrid);
		assert.equal(
			fiveCardGrid[0].match(/<Skeleton/g)?.length,
			5,
			"expected five status-card skeletons",
		);
		// Identity + activity regions matching the loaded two-column grid.
		assert.match(source, /lg:grid-cols-\[minmax\(0,2fr\)_minmax\(0,1fr\)\]/);
	});
});

describe("permission revoke buttons", () => {
	it("names each icon-only button with its permission label", () => {
		const source = read("app/(main)/wallet/permissions/page.tsx");
		assert.match(source, /aria-label/);
		assert.match(source, /tokenLabel\(ct\)/);
		assert.match(source, /Revoke \$\{tokenLabel\(ct\)\} permission/);
		// Disabled/busy behavior is preserved.
		assert.match(source, /disabled=\{revoking === key\}/);
		assert.match(source, /animate-spin/);
	});
});

describe("sidebar wordmark contrast", () => {
	it("keeps the Wallet wordmark legible on the sidebar surface", () => {
		const source = read("components/left-sidebar.tsx");
		assert.match(source, /text-sidebar-foreground.*Wallet/);
		assert.doesNotMatch(source, /text-secondary.*Wallet/);
	});
});

describe("landing hero accessibility", () => {
	it("exposes one level-one heading and treats the 3D logo as decorative", () => {
		const source = read("components/landing/hero.tsx");
		assert.equal(source.match(/<h1/g)?.length, 1);
		assert.match(source, /<h1 className="sr-only">/);
		assert.match(source, /aria-hidden="true"/);
		// The control keeps its own accessible name.
		assert.match(source, /aria-label="How the P2P trading floor works"/);
	});
	it("names the P2P popover dialog via its visible title and description", () => {
		const source = read("components/landing/hero.tsx");
		// PopoverContent (dialog) references the visible title and description.
		assert.match(source, /aria-labelledby="hero-p2p-popover-title"/);
		assert.match(source, /aria-describedby="hero-p2p-popover-description"/);
		// The referenced Title element exists with the matching id.
		assert.match(source, /<PopoverTitle id="hero-p2p-popover-title">/);
		assert.match(source, /P2P trading floor/);
		// The referenced Description element exists with the matching id.
		assert.match(
			source,
			/<PopoverDescription[^>]*id="hero-p2p-popover-description"/,
		);
	});
});
