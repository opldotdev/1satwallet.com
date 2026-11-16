import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import { containing, type Locator } from "./support/page-query";

// A new visitor walks the create flow up to the password step and stops
// before "Encrypt & Save", so nothing is written to wallet storage. The seed
// phrase is a throwaway the app generated for this page and never saved.

const PASSWORD = "e2e-throwaway-password";

const mismatch: Locator = {
	role: "any",
	text: containing("Passwords do not match"),
};
const save: Locator = { role: "button", name: "Encrypt & Save" };

e2eTest(
	"a new visitor can reach the password step of creating a wallet",
	async () => {
		const origin = baseUrl().origin;
		return {
			url: new URL("/wallet", origin).href,
			initScript: visitorInitScript(origin),
			secrets: [],
			forbiddenHosts: TESTNET_HOSTS,
		};
	},
	async (browser) => {
		await browser.click({
			role: "link",
			name: "Create wallet",
			within: { role: "region", name: "Choose a wallet" },
		});

		const words = await (async () => {
			await browser.waitFor(
				"a 12-word seed phrase",
				() =>
					Array.from({ length: 12 }, (_, i) =>
						document.querySelector(
							`input[aria-label="Mnemonic word ${i + 1}"]`,
						),
					).every((input) => input instanceof HTMLInputElement && input.value),
				null,
			);
			return browser.evaluate(
				() =>
					Array.from(
						{ length: 12 },
						(_, i) =>
							(
								document.querySelector(
									`input[aria-label="Mnemonic word ${i + 1}"]`,
								) as HTMLInputElement
							).value,
					),
				null,
			);
		})();
		await browser.click({
			role: "button",
			name: "I have saved my seed phrase",
		});

		// The confirm step asks for three words at random positions.
		await browser.waitFor(
			"the seed phrase check",
			() => location.pathname === "/wallet/create/confirm",
			null,
		);
		const asked = await browser.evaluate(
			() =>
				Array.from(
					document.querySelectorAll('input[aria-label^="Mnemonic word "]'),
					(input) =>
						Number(input.getAttribute("aria-label")?.replace(/\D+/g, "")),
				),
			null,
		);
		if (asked.length !== 3) {
			throw new Error(
				`The seed phrase check asks for ${asked.length} words, expected 3.`,
			);
		}
		for (const position of asked) {
			await browser.fill(
				{ role: "textbox", name: `Mnemonic word ${position}` },
				words[position - 1],
			);
		}
		await browser.click({ role: "button", name: "Confirm & Continue" });

		await browser.waitFor(
			"the password step",
			() => location.pathname === "/wallet/create/encrypt",
			null,
		);
		// Mainnet needs no answer: Testnet sits behind collapsed "Developer
		// options". Open it, switch Testnet on and back off, and leave it on
		// Mainnet.
		const options: Locator = { role: "button", name: "Developer options" };
		const testnet: Locator = {
			role: "switch",
			name: "Use testnet",
			attributes: ["aria-checked"],
		};
		const collapsed = await browser.query(options, ["aria-expanded"]);
		if (collapsed.attributes["aria-expanded"] !== "false") {
			throw new Error("Developer options are open on a new wallet.");
		}
		if ((await browser.query(testnet)).count !== 0) {
			throw new Error("The Use testnet switch shows before Developer options.");
		}
		await browser.click(options);
		const switchedTo = (checked: "true" | "false") =>
			browser.waitUntil(
				`Use testnet to be ${checked === "true" ? "on" : "off"}`,
				testnet,
				(result, expected) =>
					result.count > 0 && result.attributes["aria-checked"] === expected,
				checked,
			);
		await switchedTo("false");
		await browser.click(testnet);
		await switchedTo("true");
		await browser.click(testnet);
		await switchedTo("false");

		await browser.fill({ role: "textbox", name: "Password" }, PASSWORD);
		await browser.fill(
			{ role: "textbox", name: "Confirm Password" },
			`${PASSWORD}-typo`,
		);
		await browser.waitUntil("the password mismatch message", mismatch);
		if ((await browser.query(save)).disabled !== true) {
			throw new Error("Encrypt & Save is enabled with mismatched passwords.");
		}

		await browser.fill({ role: "textbox", name: "Confirm Password" }, PASSWORD);
		await browser.waitUntil(
			"the mismatch message to clear",
			mismatch,
			(result) => result.count === 0,
		);
		await browser.waitUntil(
			"Encrypt & Save to be enabled",
			save,
			(result) => result.count > 0 && result.disabled === false,
		);

		// Stop here: nothing may have been saved.
		const stored = await browser.evaluate(
			() => localStorage.getItem("encryptedBackup"),
			null,
		);
		if (stored !== null) {
			throw new Error("A wallet was saved before Encrypt & Save was pressed.");
		}
	},
);
