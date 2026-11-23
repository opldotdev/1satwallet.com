import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { Browser } from "./agent-browser";
import { ARTIFACTS_DIR } from "./env";
import { HOSTS_KEY } from "./init-script";

/** `bun run e2e --list` registers every test as skipped: no browser, no settings. */
export const LIST_ONLY = process.env.E2E_LIST === "1";

/** bun's limit per test: covers a wallet sync plus a broadcast or two. */
const TEST_TIMEOUT = 300_000;

/**
 * Waits give up after this, leaving a minute of bun's limit to clear the
 * page, take the failure screenshot, close the browser and remove the init
 * script.
 */
const BODY_BUDGET = 240_000;

export interface Session {
	/** First page to open. */
	url: string;
	/** Source registered before the first navigation. */
	initScript: string;
	/** Redacted from every error message. */
	secrets: readonly string[];
	/** The test fails if the app requested any of these. */
	forbiddenHosts: readonly string[];
	/** Clears anything secret on screen before a failure screenshot. */
	beforeScreenshot?: (browser: Browser) => Promise<void>;
}

const slug = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

async function assertNoForbiddenHosts(
	browser: Browser,
	forbidden: readonly string[],
) {
	const hosts = await browser.evaluate(
		(key: string) =>
			JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[],
		HOSTS_KEY,
	);
	const hit = hosts.filter((host) => forbidden.includes(host));
	if (hit.length > 0) {
		throw new Error(
			`The app requested hosts of the wrong network: ${hit.join(", ")}`,
		);
	}
}

/**
 * One test in its own agent-browser session. On failure it prints the page's
 * console errors and warnings (redacted), clears secrets from the page, saves
 * a screenshot to e2e-artifacts/, and always closes the session. Every error
 * is kept: several are thrown as one AggregateError.
 */
export function e2eTest(
	name: string,
	start: () => Promise<Session>,
	body: (browser: Browser, t: TestContext) => Promise<void>,
) {
	if (LIST_ONLY) {
		test.skip(name);
		return;
	}
	test(name, { timeout: TEST_TIMEOUT }, async (t) => {
		const session = await start();
		const browser = new Browser(session.secrets, Date.now() + BODY_BUDGET);
		const dir = await mkdtemp(path.join(os.tmpdir(), "1sat-e2e-"));
		const scriptPath = path.join(dir, "init.js");

		const errors: unknown[] = [];
		const attempt = async (step: () => Promise<void>) => {
			try {
				await step();
			} catch (error) {
				errors.push(error);
			}
		};

		let launched = false;
		await attempt(async () => {
			await writeFile(scriptPath, session.initScript, { mode: 0o600 });
			await browser.launch(session.url, scriptPath);
			launched = true;
			await browser.setViewport(1440, 900);
			await body(browser, t);
		});
		// With no browser there is no page to check, clear or capture.
		if (launched && errors.length === 0) {
			await attempt(() =>
				assertNoForbiddenHosts(browser, session.forbiddenHosts),
			);
		}
		if (launched && errors.length > 0) {
			// What the app logged: the reason behind a short message on the page
			// goes to console.error. Redacted, and read before anything else
			// touches the page.
			await attempt(async () => {
				const lines = await browser.consoleProblems();
				console.error(
					lines.length > 0
						? `Browser console errors and warnings for "${name}":\n  ${lines.join("\n  ")}`
						: `Browser console for "${name}": no errors or warnings.`,
				);
			});
			const before = errors.length;
			const { beforeScreenshot } = session;
			if (beforeScreenshot) await attempt(() => beforeScreenshot(browser));
			// Only screenshot a page whose secrets were cleared without error.
			if (errors.length === before) {
				await attempt(async () => {
					await mkdir(ARTIFACTS_DIR, { recursive: true });
					await browser.screenshot(
						path.join(ARTIFACTS_DIR, `${slug(name)}.png`),
					);
				});
			}
		}
		await attempt(() => browser.close());
		await attempt(() => rm(dir, { recursive: true, force: true }));

		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) {
			const messages = errors.map(
				(error, i) =>
					`${i + 1}. ${error instanceof Error ? error.message : String(error)}`,
			);
			throw new AggregateError(
				errors,
				`${errors.length} errors:\n${messages.join("\n")}`,
			);
		}
	});
}
