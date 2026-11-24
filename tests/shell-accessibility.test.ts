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
		const layout = read("app/(main)/wallet/layout.tsx");
		assert.match(layout, /<WalletHeader\s*\/>/);
		assert.match(layout, /<WalletTabs\s*\/>/);
		assert.doesNotMatch(source, /WalletHeader|WalletTabs|PageTitle/);
		assert.match(source, /max-w-full/);
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

describe("navigation landmarks", () => {
	it("names the application link group without nesting landmarks", () => {
		const source = read("components/left-sidebar.tsx");
		assert.match(source, /<nav aria-label="Application navigation">/);
		assert.equal(source.match(/<nav/g)?.length, 1);
		assert.doesNotMatch(source, /<nav[^>]*>\s*<nav/);
	});
	it("names only the unlocked wallet link group", () => {
		const source = read("components/app-sidebar.tsx");
		assert.match(source, /<nav aria-label="Wallet navigation">/);
		assert.equal(source.match(/<nav/g)?.length, 1);
		assert.doesNotMatch(source, /<nav[^>]*>\s*<nav/);
		// Loading and no-wallet placeholders must not create labeled landmarks.
		const loadingBranch = source.slice(
			source.indexOf("if (!isWalletInitialized)"),
			source.indexOf("if (!hasWallet"),
		);
		assert.doesNotMatch(loadingBranch, /<nav/);
		const noWalletBranch = source.slice(
			source.indexOf("if (!hasWallet"),
			source.indexOf("const activeAddress"),
		);
		assert.doesNotMatch(noWalletBranch, /<nav/);
	});
});

describe("landing hero accessibility", () => {
	it("exposes one level-one heading and treats the 3D logo as decorative", () => {
		const source = read("components/landing/hero.tsx");
		assert.equal(source.match(/<h1/g)?.length, 1);
		assert.match(source, /<h1[^>]*>\s*1Sat Wallet\s*<\/h1>/);
		assert.doesNotMatch(source, /<h1 className="sr-only"/);
		assert.match(source, /aria-hidden="true"/);
	});
	it("offers the ways in as labelled buttons, with no explaining copy", () => {
		const source = read("components/landing/hero.tsx");
		assert.match(source, /data-testid="hero-cta"/);
		assert.match(source, /Create wallet/);
		assert.match(source, /Unlock wallet/);
		assert.match(source, /Open wallet/);
		assert.doesNotMatch(source, /floor-note/);
		assert.doesNotMatch(source, /\bUsers\b/);
		assert.doesNotMatch(source, /Popover/);
	});
});
