import { mkdir } from "node:fs/promises";
import path from "node:path";
import { request } from "@playwright/test";
import { baseUrl, requireEnv, testWalletA } from "./support/env";
import { VERCEL_AUTH_FILE } from "./support/paths";

/**
 * Fails fast on missing or unsafe settings, then exchanges the Vercel
 * Protection Bypass secret for a cookie once. The cookie is scoped to the
 * deployment's host; a header on every request would also reach the wallet
 * backends and leak the secret to them.
 */
export default async function globalSetup() {
	// One failure that names every missing setting.
	requireEnv(["E2E_BASE_URL", "E2E_WALLET_A_BACKUP", "E2E_WALLET_PASSPHRASE"]);
	const url = baseUrl();
	await testWalletA();

	const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
	const context = await request.newContext({ baseURL: url.origin });
	try {
		const response = await context
			.get("/", {
				headers: secret
					? {
							"x-vercel-protection-bypass": secret,
							"x-vercel-set-bypass-cookie": "samesitenone",
						}
					: {},
			})
			.catch((error: unknown) => {
				throw new Error(`Could not reach E2E_BASE_URL ${url.origin}.`, {
					cause: error,
				});
			});
		if (!response.ok()) {
			throw new Error(
				secret
					? `${url.origin} refused the Vercel protection bypass (HTTP ${response.status()}). Check VERCEL_AUTOMATION_BYPASS_SECRET against the project's Deployment Protection settings.`
					: `${url.origin} answered HTTP ${response.status()}. If it is a protected preview, set VERCEL_AUTOMATION_BYPASS_SECRET.`,
			);
		}
		await mkdir(path.dirname(VERCEL_AUTH_FILE), { recursive: true });
		await context.storageState({ path: VERCEL_AUTH_FILE });
	} finally {
		await context.dispose();
	}
}
