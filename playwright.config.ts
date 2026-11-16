import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { ENV_FILE, VERCEL_AUTH_FILE } from "./e2e/support/paths";

// Local runs read the secrets file; CI gets the same names from the
// e2e-testnet environment. Nothing is required just to list tests.
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const ci = Boolean(process.env.CI);

export default defineConfig({
	testDir: "./e2e",
	// Not .test.ts or .spec.ts, so `bun test` never picks these up.
	testMatch: /.*\.e2e\.ts$/,
	globalSetup: "./e2e/global-setup.ts",
	// One wallet, one writer: tests spend wallet A's coins in order.
	fullyParallel: false,
	workers: 1,
	retries: ci ? 1 : 0,
	forbidOnly: ci,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: ci
		? [["github"], ["list"], ["html", { open: "never" }]]
		: [["list"], ["html", { open: "never" }]],
	use: {
		...devices["Desktop Chrome"],
		baseURL: process.env.E2E_BASE_URL,
		storageState: VERCEL_AUTH_FILE,
		// The wallet fixture traces by hand, after unlock, and keeps a trace
		// only for a failed test: a trace records typed values.
		trace: "off",
		video: "off",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "preflight", testMatch: /preflight\.e2e\.ts$/ },
		{
			name: "testnet-spend",
			testMatch: [/locks\.e2e\.ts$/, /profile\.e2e\.ts$/],
			dependencies: ["preflight"],
		},
	],
});
