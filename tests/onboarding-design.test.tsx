import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Moon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	SettingsGroup,
	SettingsRow,
} from "../components/settings/settings-row";
import { NetworkChoice } from "../components/wallet/network-choice";
import { OnboardingStep } from "../components/wallet/onboarding-step";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const ONBOARDING_PAGES = [
	"app/(main)/wallet/create/page.tsx",
	"app/(main)/wallet/create/confirm/page.tsx",
	"app/(main)/wallet/create/encrypt/page.tsx",
	"app/(main)/wallet/import/page.tsx",
	"app/(main)/wallet/import/json/page.tsx",
	"app/(main)/wallet/import/mnemonic/page.tsx",
	"app/(main)/wallet/import/passphrase/page.tsx",
];

const D5_FILES = [
	...ONBOARDING_PAGES,
	"components/wallet/mnemonic-grid.tsx",
	"components/wallet/network-choice.tsx",
	"components/wallet/wallet-settings-form.tsx",
	"components/settings/settings-form.tsx",
	"components/wallet/wallet-connect-carousel.tsx",
	"app/(main)/wallet/cwi/authorize/page.tsx",
	"app/(embed)/wallet/cwi/page.tsx",
	"components/wallet/bap-identity-center.tsx",
	"components/wallet/certificate-center.tsx",
];

describe("onboarding step", () => {
	it("shows the step count and a sentence-case h2 title", () => {
		const html = renderToStaticMarkup(
			<OnboardingStep step={2} total={3} title="Confirm your seed phrase">
				x
			</OnboardingStep>,
		);
		assert.match(html, /Step 2 of 3/);
		assert.match(html, /<h2[^>]*>Confirm your seed phrase<\/h2>/);
		assert.match(html, /rounded-xl border/);
	});

	it("stacks actions full width on phones, primary on top, and inline from sm", () => {
		const html = renderToStaticMarkup(
			<OnboardingStep
				step={1}
				total={3}
				title="t"
				actions={<button type="button">Next</button>}
			>
				x
			</OnboardingStep>,
		);
		const classes = html.match(/data-slot="onboarding-actions"[^>]*/)?.[0];
		assert.ok(classes, "expected the actions footer");
		assert.match(classes, /flex-col-reverse/);
		// Markup escapes the selector: [&>*] reads [&amp;&gt;*].
		assert.match(classes, / \[&amp;&gt;\*\]:w-full/);
		assert.match(classes, /sm:\[&amp;&gt;\*\]:w-auto/);
		assert.match(classes, /sm:flex-row/);
	});

	it("makes content and actions one form without breaking the card spacing", () => {
		const html = renderToStaticMarkup(
			<OnboardingStep
				step={3}
				total={3}
				title="t"
				form={{ "aria-label": "Set a password" }}
				actions={<button type="submit">Save</button>}
			>
				<input aria-label="Password" />
			</OnboardingStep>,
		);
		assert.match(html, /<form aria-label="Set a password" class="contents">/);
		assert.match(html, /<form[^>]*>[\s\S]*Password[\s\S]*Save[\s\S]*<\/form>/);
	});

	it("is how every create and import step is built, with no font-mono heading", () => {
		for (const file of ONBOARDING_PAGES) {
			const source = read(file);
			assert.doesNotMatch(source, /font-mono text-xl/, file);
			assert.doesNotMatch(source, /border-2/, file);
			if (!file.endsWith("import/page.tsx")) {
				assert.match(source, /<OnboardingStep/, file);
			}
		}
	});

	it("titles every step in sentence case", () => {
		for (const title of [
			"Create New Wallet",
			"Your New Seed Phrase",
			"Confirm Seed Phrase",
			"Set Password",
			"Import Wallet",
			"Enter Mnemonic Seed",
			"Upload Backup File",
		]) {
			for (const file of ONBOARDING_PAGES) {
				assert.ok(!read(file).includes(`"${title}"`), `${file}: ${title}`);
				assert.ok(!read(file).includes(`>${title}<`), `${file}: ${title}`);
			}
		}
	});
});

describe("network choice on create and import", () => {
	it("defaults a new wallet to Mainnet", () => {
		assert.match(
			read("app/(main)/wallet/create/provider.tsx"),
			/useState<Chain>\("main"\)/,
		);
	});

	it("keeps Testnet behind collapsed Developer options on Mainnet", () => {
		const html = renderToStaticMarkup(
			<NetworkChoice value="main" onChange={() => {}} />,
		);
		assert.match(html, /aria-expanded="false"/);
		assert.match(html, /Developer options/);
		assert.doesNotMatch(html, /role="switch"/);
		assert.doesNotMatch(html, /Use testnet/);
	});

	it("opens Developer options when Testnet is already selected", () => {
		const html = renderToStaticMarkup(
			<NetworkChoice value="test" onChange={() => {}} />,
		);
		assert.match(html, /aria-expanded="true"/);
		assert.match(html, /role="switch"/);
	});

	it("gives the Developer options toggle a 44px phone target", () => {
		const html = renderToStaticMarkup(
			<NetworkChoice value="main" onChange={() => {}} />,
		);
		assert.match(html, /<button[^>]*max-md:min-h-11[^>]*>Developer options/);
	});
});

describe("mnemonic grid", () => {
	it("starts the wallet path search once all 12 words are valid", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		// No hidden flag gates the search: Next stays disabled until a path is
		// found, so the search must start on its own.
		assert.doesNotMatch(grid, /setReady/);
		assert.match(grid, /mode === "edit" &&\s*isValid &&\s*!useCustomPaths/);
	});

	it("drops detected paths when the words change", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		assert.match(
			grid,
			/handleWordChange[\s\S]*?if \(!useCustomPaths\) setPendingPaths\(undefined\)/,
		);
	});

	it("keeps the browser from completing, capitalizing or correcting seed words", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		const fields = grid.match(
			/aria-label=\{`Mnemonic word \$\{(?:idx|slot) \+ 1\}`\}[\s\S]*?\/>/g,
		);
		assert.equal(fields?.length, 2);
		for (const field of fields ?? []) {
			assert.match(field, /autoComplete="off"/);
			assert.match(field, /autoCapitalize="none"/);
			assert.match(field, /autoCorrect="off"/);
			assert.match(field, /spellCheck=\{false\}/);
		}
	});

	it("lets the spot-check fields take the full width", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		assert.doesNotMatch(grid, /max-w-48/);
		assert.match(grid, /className=\{`w-full font-mono/);
	});

	it("never logs a message that may quote the phrase", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		const calls = grid.match(/console\.error\([^)]*\)/g) ?? [];
		assert.ok(
			calls.length >= 2,
			"expected the copy and detection failures logged",
		);
		for (const call of calls) {
			assert.match(call, /name: error instanceof Error \? error\.name/, call);
			assert.doesNotMatch(call, /error\.message|[,{]\s*error\s*[,}]/, call);
		}
	});
});

describe("settings rows", () => {
	it("puts a 20px muted icon, the title and the description in a row", () => {
		const html = renderToStaticMarkup(
			<SettingsGroup title="Appearance">
				<SettingsRow
					icon={Moon}
					title="Dark mode"
					description="Use the dark theme."
					htmlFor="dark-mode"
					control={<span>switch</span>}
				/>
			</SettingsGroup>,
		);
		assert.match(html, /<h2[^>]*>Appearance<\/h2>/);
		assert.match(html, /size-5 shrink-0 text-muted-foreground/);
		assert.match(
			html,
			/<label class="[^"]*" for="dark-mode">Dark mode<\/label>/,
		);
		assert.match(html, /divide-y/);
	});

	it("gives an action the full width on phones and 160px from sm", () => {
		const html = renderToStaticMarkup(
			<SettingsRow
				icon={Moon}
				title="Sync"
				action={<button type="button">Sync now</button>}
			/>,
		);
		assert.match(
			html,
			/class="w-full shrink-0 sm:w-40 \[&amp;&gt;\*\]:w-full"/,
		);
	});

	it("is the one row pattern in both settings forms", () => {
		for (const file of [
			"components/wallet/wallet-settings-form.tsx",
			"components/settings/settings-form.tsx",
		]) {
			const source = read(file);
			assert.match(source, /<SettingsRow/, file);
			assert.doesNotMatch(source, /space-x-2/, file);
			assert.doesNotMatch(source, /text-chart-3|bg-primary\/10/, file);
		}
	});
});

describe("D5 screens", () => {
	it("use no 10px or 11px type", () => {
		for (const file of D5_FILES) {
			assert.doesNotMatch(read(file), /text-\[1[01]px\]/, file);
		}
		assert.doesNotMatch(
			read("components/wallet/wallet-connect-carousel.module.css"),
			/font-size:\s*1[01]px/,
		);
	});

	it("set the connect carousel's headings in the UI font", () => {
		const css = read("components/wallet/wallet-connect-carousel.module.css");
		assert.doesNotMatch(css, /font-mono/);
	});

	it("size the CWI prompts to the dynamic viewport", () => {
		const embed = read("app/(embed)/wallet/cwi/page.tsx");
		assert.doesNotMatch(embed, /min-h-screen/);
		assert.match(embed, /min-h-dvh/);
		// Inside the wallet layout a full-screen minimum always overflows on
		// a phone, so it applies only from sm.
		const authorize = read("app/(main)/wallet/cwi/authorize/page.tsx");
		assert.doesNotMatch(authorize, /min-h-screen|(?<!sm:)min-h-dvh/);
		assert.match(authorize, /sm:min-h-\[60dvh\]/);
	});

	it("keep the authorize decision clear of the home indicator on phones", () => {
		assert.match(
			read("app/(main)/wallet/cwi/authorize/page.tsx"),
			/max-sm:sticky max-sm:bottom-0[^"]*env\(safe-area-inset-bottom\)/,
		);
	});

	it("log authorize failures and show short fixed messages", () => {
		const page = read("app/(main)/wallet/cwi/authorize/page.tsx");
		assert.match(page, /console\.error\("\[cwi\] requested call failed"/);
		assert.match(page, /console\.error\("\[cwi\] could not send the denial"/);
		assert.match(
			page,
			/console\.error\("\[cwi\] could not load the authorization request"/,
		);
		assert.match(page, /"Couldn't send the denial\. Try again\."/);
	});

	it("keep the hidden backup file input out of the tab order", () => {
		assert.match(
			read("app/(main)/wallet/import/json/page.tsx"),
			/aria-label="Wallet backup file"[\s\S]{0,80}tabIndex=\{-1\}/,
		);
	});

	it("give native checkboxes a 44px row", () => {
		assert.match(
			read("app/(embed)/wallet/cwi/page.tsx"),
			/consentRowClassName =\s*"flex min-h-11/,
		);
		assert.match(
			read("components/wallet/certificate-center.tsx"),
			/className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border/,
		);
	});

	it("use no bare rounded-md boxes for panels in identity and certificates", () => {
		for (const file of [
			"components/wallet/bap-identity-center.tsx",
			"components/wallet/certificate-center.tsx",
		]) {
			assert.doesNotMatch(read(file), /rounded-md border/, file);
		}
	});
});
