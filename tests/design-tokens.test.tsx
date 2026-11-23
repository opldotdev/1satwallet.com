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

	it("adds viewport-fit=cover with a keyboard that resizes the content", () => {
		assert.match(
			read("app/layout.tsx"),
			/interactiveWidget: "resizes-content"/,
		);
	});

	it("keeps the top bar 64px (48px collapsed) plus the top inset", () => {
		const shell = read("components/dual-sidebar-layout.tsx");
		assert.match(shell, /<header[^>]*pt-\[env\(safe-area-inset-top\)\]/);
		assert.match(
			shell,
			/<header[^>]*h-\[calc\(--spacing\(16\)\+env\(safe-area-inset-top\)\)\]/,
		);
		assert.match(
			shell,
			/sidebar-wrapper:h-\[calc\(--spacing\(12\)\+env\(safe-area-inset-top\)\)\]/,
		);
		// The border sits inside the height, as it did before the insets.
		assert.doesNotMatch(shell, /box-content/);
	});

	it("pads every page once, in the shell, not again in Page", () => {
		const shell = read("components/dual-sidebar-layout.tsx");
		const wrapper = shell.match(/<div className="([^"]*)">\s*\{children\}/);
		assert.ok(wrapper, "content wrapper");
		const classes = wrapper[1].split(/\s+/);
		for (const side of ["right", "bottom"]) {
			assert.ok(
				classes.includes(`p${side[0]}-[env(safe-area-inset-${side})]`),
				side,
			);
		}
		// From md the left icon rail takes the left inset.
		assert.ok(classes.includes("max-md:pl-[env(safe-area-inset-left)]"));
		assert.ok(!classes.includes("pl-[env(safe-area-inset-left)]"));
		assert.doesNotMatch(read("components/page-layout.tsx"), /safe-area-inset/);
	});

	it("puts the left inset on the icon rail from md, not on the page", () => {
		const shell = read("components/dual-sidebar-layout.tsx");
		assert.match(
			shell,
			/<header[^>]*pl-4 max-md:pl-\[max\(1rem,env\(safe-area-inset-left\)\)\]/,
		);
		const sidebar = read("components/ui/sidebar.tsx");
		// The rail sits beside the inset, and its gap reserves the inset.
		assert.match(
			sidebar,
			/"left-\[env\(safe-area-inset-left\)\] group-data-\[collapsible=offcanvas\]/,
		);
		assert.match(
			sidebar,
			/group-data-\[side=left\]:box-content group-data-\[side=left\]:pl-\[env\(safe-area-inset-left\)\]/,
		);
	});

	it("keeps fixed landing controls clear of the home indicator", () => {
		const hero = read("components/landing/hero.tsx");
		const presence = read("components/landing/shared-presence.tsx");
		// The floor bar sits on the bottom edge and pads itself above the
		// home indicator.
		assert.ok(presence.includes("fixed inset-x-0 bottom-0"));
		assert.ok(
			presence.includes("pb-[max(--spacing(3),env(safe-area-inset-bottom))]"),
		);
		for (const src of [hero, presence]) {
			assert.doesNotMatch(src, /[\s"]bottom-4[\s"]/);
		}
	});

	it("clears the home indicator on full-screen overlays and sheets", () => {
		for (const file of [
			"components/wallet/full-screen-unlock.tsx",
			"components/wallet/migration-wizard.tsx",
			"components/ui/sheet.tsx",
			"app/(embed)/wallet/cwi/page.tsx",
		]) {
			assert.match(read(file), /env\(safe-area-inset-bottom\)/, file);
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

	it("keep the close control pinned while a long sheet scrolls", () => {
		// Sticky top counts from inside the padding, so the anchor needs a
		// negative top of one spacing to sit at the padding edge.
		assert.match(dialog, /sticky -top-\(--dialog-spacing\) z-10 order-first/);
		assert.doesNotMatch(dialog, /sticky top-0/);
		// It has the dialog's background so scrolled content does not show
		// through; the icon is dimmed, not the button.
		assert.match(dialog, /bg-background\/80 [^"]*backdrop-blur-sm/);
		assert.doesNotMatch(
			dialog,
			/data-slot="dialog-close"\s+className="[^"]*[\s"]opacity-70/,
		);
		// Header text clears the close control.
		assert.match(
			dialog,
			/--dialog-header-pr:max\(0px,calc\(3rem-var\(--dialog-spacing\)\)\)/,
		);
		assert.match(dialog, /pr-\[var\(--dialog-header-pr,0px\)\]/);
	});

	it("change padding and gap through the variables, not p-* or gap-*", () => {
		// A p-* or gap-* override would drop the home-indicator padding and
		// misplace the close control.
		const callers = [
			"components/ui/command.tsx",
			"components/landing/trade-dialog.tsx",
			"components/landing/inventory-selector.tsx",
			"components/modal/artifact-modal.tsx",
			"components/wallet/wallet-home-actions.tsx",
			"components/wallet/one-color-send.tsx",
			"components/wallet/create-token.tsx",
		];
		for (const file of callers) {
			const src = read(file);
			const contents = [...src.matchAll(/<DialogContent[\s\S]*?>/g)].map(
				(m) => m[0],
			);
			assert.ok(contents.length > 0, file);
			for (const tag of contents) {
				assert.doesNotMatch(tag, /[\s"]p-\d|[\s"]gap-\d|sm:p-\d/, file);
			}
		}
	});

	it("AlertDialog is the same sheet, with full-width footer buttons", () => {
		const alert = read("components/ui/alert-dialog.tsx");
		assert.match(alert, /dialogSurfaceClassName/);
		assert.match(alert, /max-sm:\*:w-full sm:flex-row/);
	});

	it("artifact preview keeps its 96dvh height and its own close button", () => {
		const modal = read("components/modal/artifact-modal.tsx");
		assert.match(modal, /showCloseButton=\{false\}/);
		assert.match(modal, /h-\[96dvh\] max-h-\[96dvh\] max-sm:max-h-\[96dvh\]/);
	});

	it("leave no per-screen height patches behind", () => {
		for (const file of [
			"components/wallet/ordinal-action-dialog.tsx",
			"components/wallet/certificate-center.tsx",
			"components/wallet/wallet-home-actions.tsx",
			"components/wallet/one-color-send.tsx",
			"components/wallet/create-token.tsx",
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
		assert.match(
			renderToStaticMarkup(<SectionHeader as="h3" title="Holders" />),
			/<h3 class="text-lg[^"]*">Holders<\/h3>/,
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
		assert.match(
			html,
			/<dd class="max-w-full min-w-0 wrap-anywhere">Fixed<\/dd>/,
		);
		// Beside its label it sits at the right; wrapped, under it at the start.
		assert.match(html, /flex flex-wrap items-baseline justify-between/);
		assert.doesNotMatch(html, /text-right|ml-auto/);
		assert.match(html, /flex flex-col gap-1/);
	});
});
