import { rm } from "node:fs/promises";
import {
	type BrowserContext,
	test as base,
	expect,
	type TestInfo,
} from "@playwright/test";
import { WALLET_STORAGE_KEY } from "@/lib/constants";
import { INSTALLATION_ID_KEY } from "@/lib/wallet-storage-identity";
import {
	E2E_INSTALLATION_ID,
	MAINNET_ONLY_HOSTS,
	testWalletA,
} from "../support/env";
import { unlockWallet, waitForWalletReady } from "../support/waits";

/**
 * Tracing never covers the passphrase: it starts after unlock, pauses around
 * any later unlock, and is kept only when the test fails (the repo is public,
 * so report artifacts are too).
 */
class TraceRecorder {
	private parts: string[] = [];
	private recording = false;

	constructor(
		private readonly context: BrowserContext,
		private readonly testInfo: TestInfo,
	) {}

	async start() {
		await this.context.tracing.start({ screenshots: true, snapshots: true });
		this.recording = true;
	}

	async pause() {
		if (!this.recording) return;
		const part = this.testInfo.outputPath(`trace-${this.parts.length}.zip`);
		await this.context.tracing.stopChunk({ path: part });
		this.parts.push(part);
		this.recording = false;
	}

	async resume() {
		await this.context.tracing.startChunk();
		this.recording = true;
	}

	async finish() {
		const failed = this.testInfo.status !== this.testInfo.expectedStatus;
		if (this.recording && failed) {
			const part = this.testInfo.outputPath(`trace-${this.parts.length}.zip`);
			await this.context.tracing.stop({ path: part });
			this.parts.push(part);
		} else {
			await this.context.tracing.stop();
		}
		for (const [index, part] of this.parts.entries()) {
			if (failed) {
				await this.testInfo.attach(`trace-${index}`, {
					path: part,
					contentType: "application/zip",
				});
			} else {
				await rm(part);
			}
		}
	}
}

export interface WalletSession {
	identityKey: string;
	/** Unlocks again after a reload, with tracing paused meanwhile. */
	unlock: () => Promise<void>;
}

/**
 * Every test starts on /wallet with wallet A seeded into a fresh context,
 * unlocked with the passphrase from the runner's environment, and synced.
 */
export const test = base.extend<{
	requestHosts: Set<string>;
	wallet: WalletSession;
}>({
	requestHosts: async ({ context }, use) => {
		const hosts = new Set<string>();
		context.on("request", (request) => {
			hosts.add(new URL(request.url()).host);
		});
		await use(hosts);
	},
	wallet: [
		async ({ baseURL, context, page, requestHosts }, use, testInfo) => {
			if (!baseURL) throw new Error("Missing e2e settings: E2E_BASE_URL.");
			const wallet = await testWalletA();

			await context.addInitScript(
				(seed) => {
					// Only the site under test, and only once per tab, so a test
					// that deletes the wallet is not re-seeded on reload.
					if (location.origin !== seed.origin) return;
					if (sessionStorage.getItem(seed.seededKey)) return;
					localStorage.setItem(seed.walletKey, seed.backup);
					localStorage.setItem(seed.installationKey, seed.installationId);
					sessionStorage.setItem(seed.seededKey, "1");
				},
				{
					origin: new URL(baseURL).origin,
					seededKey: "1sat-e2e-seeded",
					walletKey: WALLET_STORAGE_KEY,
					backup: wallet.backup,
					installationKey: INSTALLATION_ID_KEY,
					installationId: E2E_INSTALLATION_ID,
				},
			);

			await page.goto("/wallet");
			await unlockWallet(page, wallet.passphrase);
			await waitForWalletReady(page);

			const trace = new TraceRecorder(context, testInfo);
			await trace.start();
			await use({
				identityKey: wallet.identityKey,
				unlock: async () => {
					await trace.pause();
					await unlockWallet(page, wallet.passphrase);
					await trace.resume();
				},
			});
			await trace.finish();

			const reached = MAINNET_ONLY_HOSTS.filter((host) =>
				requestHosts.has(host),
			);
			expect(reached, "a testnet account called mainnet backends").toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };
