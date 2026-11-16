import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import { containing } from "./support/page-query";
import { TESTNET_BADGE_LABEL } from "./support/wallet";

// Read-only checks against a deployed site, as a first-time visitor: no
// wallet, no secrets, nothing signed or broadcast.

e2eTest(
	"a new visitor is offered a mainnet wallet",
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
		await browser.waitUntil("the wallet choice", {
			role: "region",
			name: "Choose a wallet",
		});
		for (const name of ["Create wallet", "Import wallet"]) {
			await browser.waitUntil(`the "${name}" link`, {
				role: "any",
				text: containing(name),
				within: { role: "region", name: "Choose a wallet" },
			});
		}
		const badges = await browser.evaluate(
			(label: string) =>
				document.querySelectorAll(`[aria-label="${label}"]`).length,
			TESTNET_BADGE_LABEL,
		);
		if (badges > 0) {
			throw new Error("A new visitor sees the Testnet badge on production.");
		}
	},
);
