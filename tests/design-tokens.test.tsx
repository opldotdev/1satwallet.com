import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageTitle } from "../components/page-layout";
import { buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { DetailList, DetailRow } from "../components/ui/detail-list";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { SectionHeader } from "../components/ui/section-header";
import { cn } from "../lib/utils";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("radius token", () => {
	it("is defined once, at 0.625rem, on :root", () => {
		const css = read("app/globals.css");
		const values = [...css.matchAll(/--radius:\s*([^;]+);/g)].map((m) => m[1]);
		assert.deepEqual(values, ["0.625rem"]);
		assert.match(css, /:root\s*\{\s*--radius: 0\.625rem;/);
		assert.match(css, /--radius-sm: calc\(var\(--radius\) - 4px\)/);
		assert.match(css, /--radius-xl: calc\(var\(--radius\) \+ 4px\)/);
	});
});

describe("safe areas", () => {
	it("lets the page draw under the notch with viewport-fit=cover", () => {
		const layout = read("app/layout.tsx");
		assert.match(layout, /export const viewport: Viewport = \{/);
		assert.match(layout, /viewportFit: "cover"/);
	});

	it("pads the top bar and the page by the insets", () => {
		assert.match(
			read("components/dual-sidebar-layout.tsx"),
			/<header[^>]*pt-\[env\(safe-area-inset-top\)\]/,
		);
		const page = read("components/page-layout.tsx");
		for (const side of ["left", "right", "bottom"]) {
			assert.match(page, new RegExp(`env\\(safe-area-inset-${side}\\)`));
		}
	});
});

describe("tap targets", () => {
	it("gives every button size a 44px minimum below md", () => {
		for (const size of [
			"default",
			"sm",
			"icon",
			"icon-sm",
			"icon-lg",
		] as const) {
			assert.match(buttonVariants({ size }), /max-md:min-h-11/, size);
		}
		for (const size of ["icon", "icon-sm", "icon-lg"] as const) {
			assert.match(buttonVariants({ size }), /max-md:min-w-11/, size);
		}
		assert.match(buttonVariants({ size: "lg" }), /max-md:min-h-12/);
	});

	it("keeps the mobile minimum when a screen overrides the height", () => {
		const merged = cn(buttonVariants({ size: "sm" }), "h-7");
		assert.match(merged, /\bh-7\b/);
		assert.doesNotMatch(merged, /\bh-8\b/);
		assert.match(merged, /max-md:min-h-11/);
	});

	it("gives inputs and select triggers the same minimum", () => {
		assert.match(renderToStaticMarkup(<Input />), /max-md:min-h-11/);
		const select = read("components/ui/select.tsx");
		assert.match(select, /data-\[size=sm\]:h-8 max-md:min-h-11/);
	});
});

describe("dialogs", () => {
	const dialog = read("components/ui/dialog.tsx");

	it("are bottom sheets under sm that scroll and clear the home indicator", () => {
		for (const token of [
			"max-sm:bottom-0",
			"max-sm:top-auto",
			"max-sm:max-w-none",
			"max-sm:rounded-b-none",
			"max-sm:max-h-[calc(100dvh-3rem)]",
			"max-sm:data-[state=open]:slide-in-from-bottom",
			"max-h-[calc(100dvh-4rem)]",
			"overflow-y-auto",
			"rounded-xl",
			"env(safe-area-inset-bottom)",
		]) {
			assert.ok(dialog.includes(token), token);
		}
	});

	it("have a 44px close control and full-width footer buttons on phones", () => {
		assert.match(dialog, /absolute top-1 right-1 flex size-11/);
		assert.match(dialog, /max-sm:\*:w-full sm:flex-row/);
	});

	it("leave no per-screen height patches behind", () => {
		for (const file of [
			"components/wallet/ordinal-action-dialog.tsx",
			"components/wallet/certificate-center.tsx",
			"components/wallet/wallet-home-actions.tsx",
		]) {
			assert.doesNotMatch(
				read(file),
				/max-h-\[(85vh|90vh|calc\(100dvh-2rem\))\]/,
				file,
			);
		}
	});
});

describe("cards and titles", () => {
	it("cards are rounded and bordered, and a padding override wins", () => {
		const html = renderToStaticMarkup(
			<Card>
				<CardContent className="p-3">x</CardContent>
			</Card>,
		);
		assert.match(html, /rounded-xl border/);
		assert.match(html, /class="p-3"/);
	});

	it("page titles are sans, 24px on phones and 30px from md", () => {
		const html = renderToStaticMarkup(<PageTitle>Wallet</PageTitle>);
		assert.match(html, /^<h1 class="[^"]*text-2xl[^"]*md:text-3xl/);
		assert.doesNotMatch(html, /font-mono/);
	});
});

describe("shared building blocks", () => {
	it("SectionHeader is an 18px h2 with an optional action", () => {
		const html = renderToStaticMarkup(
			<SectionHeader
				title="Tokens"
				description="BSV-21 and 1Color"
				action={<button type="button">Create token</button>}
			/>,
		);
		assert.match(
			html,
			/<h2 class="text-lg[^"]*font-semibold[^"]*">Tokens<\/h2>/,
		);
		assert.match(html, /BSV-21 and 1Color/);
		assert.match(
			html,
			/data-slot="section-header-action"[^>]*><button type="button">Create token/,
		);
	});

	it("EmptyState shows a title, a hint and an action", () => {
		const html = renderToStaticMarkup(
			<EmptyState
				title="No tokens yet"
				description="Tokens you receive show up here."
				action={<a href="/inscribe">Inscribe</a>}
			/>,
		);
		assert.match(html, /py-12/);
		assert.match(html, /No tokens yet/);
		assert.match(html, /Tokens you receive show up here\./);
		assert.match(html, /href="\/inscribe"/);
	});

	it("Notice announces danger and stays quiet otherwise", () => {
		const danger = renderToStaticMarkup(<Notice tone="danger">Failed</Notice>);
		assert.match(danger, /role="alert"/);
		assert.match(danger, /data-tone="danger"/);
		assert.match(danger, /rounded-lg border p-3 text-sm/);
		const info = renderToStaticMarkup(<Notice>Heads up</Notice>);
		assert.doesNotMatch(info, /role=/);
		assert.match(info, /data-tone="info"/);
	});

	it("DetailList pairs muted labels with mono values", () => {
		const html = renderToStaticMarkup(
			<DetailList>
				<DetailRow label="Amount">1.5 BSV</DetailRow>
				<DetailRow label="Supply" mono={false}>
					Fixed
				</DetailRow>
				<DetailRow label="Txid" stack>
					{"ab".repeat(32)}
				</DetailRow>
			</DetailList>,
		);
		assert.match(html, /^<dl/);
		assert.match(
			html,
			/<dt class="text-muted-foreground shrink-0">Amount<\/dt>/,
		);
		assert.match(html, /<dd class="[^"]*font-mono[^"]*">1\.5 BSV<\/dd>/);
		assert.match(html, /<dd class="[^"]*text-right">Fixed<\/dd>/);
		assert.match(html, /flex flex-col gap-1/);
	});
});
