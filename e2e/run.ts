/**
 * Runs the e2e suites with bun test, each test driving its own agent-browser
 * session.
 *
 *   bun run e2e                  testnet suite (spends testnet coins)
 *   bun run e2e:mainnet          read-only checks of a deployed site
 *   bun run e2e --list           lists the tests; needs no browser or settings
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { baseUrl, ENV_FILE, testWalletA } from "./support/env";

const SUITES = {
	// Preflight runs alone first: with an unfunded wallet the rest only fail.
	testnet: [
		["./e2e/preflight.e2e.ts"],
		[
			"./e2e/locks.e2e.ts",
			"./e2e/profile.e2e.ts",
			"./e2e/mobile-layout-wallet.e2e.ts",
			"./e2e/mobile-layout-overview.e2e.ts",
			"./e2e/mobile-lists.e2e.ts",
		],
	],
	mainnet: [
		[
			"./e2e/mainnet.e2e.ts",
			"./e2e/create-wallet.e2e.ts",
			"./e2e/mobile-layout.e2e.ts",
		],
	],
} as const;

type Suite = keyof typeof SUITES;

function parseArgs(argv: string[]) {
	let suite: Suite = "testnet";
	let list = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--list") list = true;
		else if (arg === "--suite") {
			const value = argv[++i];
			if (value !== "testnet" && value !== "mainnet") {
				throw new Error(`--suite must be testnet or mainnet, not "${value}".`);
			}
			suite = value;
		} else {
			throw new Error(
				`Unknown argument "${arg}". Usage: bun e2e/run.ts [--suite testnet|mainnet] [--list]`,
			);
		}
	}
	return { suite, list };
}

function bunTest(args: readonly string[], env: NodeJS.ProcessEnv) {
	return new Promise<number>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["test", "--timeout=300000", ...args],
			{ env, stdio: "inherit" },
		);
		child.on("error", reject);
		child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});
}

const unescapeXml = (text: string) =>
	text
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");

/** Loads the files with every test skipped and prints each test's name. */
async function listTests(files: readonly string[]) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "1sat-e2e-list-"));
	try {
		const report = path.join(dir, "junit.xml");
		const code = await bunTest(
			[`--reporter=junit`, `--reporter-outfile=${report}`, ...files],
			{ ...process.env, E2E_LIST: "1" },
		);
		if (code !== 0) return code;
		const xml = await readFile(report, "utf8");
		for (const match of xml.matchAll(
			/<testcase name="([^"]*)"[^>]*\bfile="([^"]*)"/g,
		)) {
			console.log(`${unescapeXml(match[2])}: ${unescapeXml(match[1])}`);
		}
		return 0;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function main() {
	const { suite, list } = parseArgs(process.argv.slice(2));
	if (list) return listTests(SUITES[suite].flat());

	// Only the testnet suite reads the local wallet settings.
	if (suite === "testnet" && existsSync(ENV_FILE)) {
		process.loadEnvFile(ENV_FILE);
	}
	// Fail fast, before any browser starts, with every missing setting named.
	console.log(`e2e ${suite} suite against ${baseUrl().origin}`);
	if (suite === "testnet") {
		const wallet = await testWalletA();
		console.log(`Testnet wallet A, identity key ${wallet.identityKey}`);
	}

	// The wallet settings go to bun test in a mode 600 file, not in its
	// environment, so no process the tests start can inherit them.
	const dir = await mkdtemp(path.join(os.tmpdir(), "1sat-e2e-run-"));
	try {
		const env: NodeJS.ProcessEnv = { ...process.env };
		const secrets: Record<string, string> = {};
		for (const key of Object.keys(env)) {
			if (key.startsWith("E2E_WALLET_")) {
				secrets[key] = env[key] ?? "";
				delete env[key];
			}
		}
		if (Object.keys(secrets).length > 0) {
			env.E2E_SECRETS_FILE = path.join(dir, "secrets.json");
			await writeFile(env.E2E_SECRETS_FILE, JSON.stringify(secrets), {
				mode: 0o600,
			});
		}
		for (const files of SUITES[suite]) {
			const code = await bunTest(files, env);
			if (code !== 0) return code;
		}
		return 0;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		// Message first, then the full stack and every cause.
		let current: unknown = error;
		let prefix = "";
		while (current !== undefined) {
			console.error(
				prefix + (current instanceof Error ? current.stack : String(current)),
			);
			current = current instanceof Error ? current.cause : undefined;
			prefix = "Caused by: ";
		}
		process.exit(1);
	},
);
