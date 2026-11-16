import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser, cliEnv } from "../e2e/support/agent-browser";

test("redacts every secret from driver messages", () => {
	const browser = new Browser(["s3cret-pass", '{"backup":1}']);
	assert.equal(
		browser.redact('typed s3cret-pass into {"backup":1} and s3cret-pass'),
		"typed [redacted] into [redacted] and [redacted]",
	);
});

test("refuses a fixed sleep before starting agent-browser", async () => {
	await assert.rejects(
		new Browser().run(["wait", "500"]),
		/fixed sleeps are banned/,
	);
});

test("keeps the wallet settings out of agent-browser's environment", () => {
	const saved = { ...process.env };
	try {
		process.env.E2E_WALLET_PASSPHRASE = "pass";
		process.env.E2E_WALLET_A_BACKUP = "backup";
		process.env.E2E_SECRETS_FILE = "/tmp/secrets.json";
		const env = cliEnv();
		assert.equal(env.E2E_WALLET_PASSPHRASE, undefined);
		assert.equal(env.E2E_WALLET_A_BACKUP, undefined);
		assert.equal(env.E2E_SECRETS_FILE, undefined);
		assert.equal(env.AGENT_BROWSER_NO_VERSION_CHECK, "1");
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in saved)) delete process.env[key];
		}
	}
});
