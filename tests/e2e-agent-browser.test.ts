import assert from "node:assert/strict";
import { test } from "node:test";
import {
	Browser,
	cliEnv,
	consoleProblemLines,
} from "../e2e/support/agent-browser";

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

test("reads console errors and warnings and page errors, not info or logs", () => {
	const lines = consoleProblemLines(
		{
			messages: [
				{ type: "log", text: "ready" },
				{ type: "info", text: "fyi" },
				{ type: "warning", text: "slow   storage" },
				{
					type: "error",
					text: "[wallet.peerpay.deliver] Failed to send message.",
				},
			],
		},
		{ errors: [{ message: "TypeError: x is undefined" }, "Uncaught boom"] },
		(line) => line,
	);
	assert.deepEqual(lines, [
		"[warning] slow storage",
		"[error] [wallet.peerpay.deliver] Failed to send message.",
		"[page error] TypeError: x is undefined",
		"[page error] Uncaught boom",
	]);
	// A bare list, a level field and an entry with no text all still read.
	assert.deepEqual(
		consoleProblemLines([{ level: "warn", args: [1] }], null, (line) => line),
		['[warn] {"level":"warn","args":[1]}'],
	);
	assert.deepEqual(
		consoleProblemLines(null, undefined, (line) => line),
		[],
	);
});

test("console lines never carry a secret, whole or in part", () => {
	const backup = "U2FsdGVkX1+9fJ3kQwErTy7uIoPaSdFgHjKlZxCvBnM1234567890abcdef";
	const browser = new Browser(["s3cret-pass", backup]);
	assert.equal(
		browser.redactConsoleLine("[error] bad s3cret-pass"),
		"[error] bad [redacted]",
	);
	assert.equal(
		browser.redactConsoleLine(`[error] parse failed at ${backup.slice(5, 40)}`),
		"[withheld: the line held part of a secret]",
	);
	assert.equal(
		browser.redactConsoleLine(
			`[error] Unlocked. Transaction ${"ab".repeat(32)}`,
		),
		`[error] Unlocked. Transaction ${"ab".repeat(32)}`,
	);
});

test("a secret straddling the length cut is redacted before the line is cut", () => {
	const secret = "Zq7Yx2Wv9Ut4Sr6Qp1On3Ml8Kj5Ih0Gf";
	const browser = new Browser([secret]);
	const long = `${"x".repeat(590)}${secret} tail`;
	const [line] = consoleProblemLines(
		[{ type: "error", text: long }],
		null,
		(text) => browser.redactConsoleLine(text),
	);
	assert.ok(line);
	assert.ok(!line.includes(secret.slice(0, 8)), line.slice(-40));
});
