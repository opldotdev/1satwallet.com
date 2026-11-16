import { spawn } from "node:child_process";
import path from "node:path";
import {
	type Locator,
	pageQuery,
	type QueryArgs,
	type QueryResult,
	toPageLocator,
} from "./page-query";

/** The CLI from node_modules (the npm `agent-browser` package). */
const AGENT_BROWSER = path.join(
	__dirname,
	"..",
	"..",
	"node_modules",
	".bin",
	"agent-browser",
);

/** One action or `wait` call; longer waits poll until their own deadline. */
export const ACTION_TIMEOUT = 15_000;

interface CliResponse {
	success: boolean;
	data: unknown;
	error: string | null;
}

let sessionCount = 0;

/** "button "Unlock" in dialog "Unlock wallet"", for error messages. */
export function describe(locator: Locator): string {
	const self = [
		locator.role,
		locator.name && `"${locator.name}"`,
		locator.text && `with text /${locator.text.source}/`,
		locator.index !== undefined && `#${locator.index}`,
	]
		.filter(Boolean)
		.join(" ");
	return locator.within ? `${self} in ${describe(locator.within)}` : self;
}

/**
 * One isolated agent-browser session (its own daemon and Chrome), driven
 * through the CLI with `--json`. Secrets never go on a command line: values
 * the page needs come from an init script, and every message this class
 * builds from CLI output is redacted against `secrets` as well.
 */
export class Browser {
	readonly session = `e2e-${process.pid}-${++sessionCount}`;
	private marks = 0;

	constructor(private readonly secrets: readonly string[] = []) {}

	redact(text: string): string {
		return this.secrets
			.filter((secret) => secret.length > 0)
			.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
	}

	/** Runs one command; throws with the CLI's own error when it fails. */
	async run(args: readonly string[], stdin?: string): Promise<unknown> {
		const label = `agent-browser ${args.join(" ")}`;
		if (args[0] === "wait" && /^\d+$/.test(args[1] ?? "")) {
			throw new Error(
				`${label}: fixed sleeps are banned in e2e tests; wait on app state.`,
			);
		}
		const { code, stdout, stderr } = await new Promise<{
			code: number | null;
			stdout: string;
			stderr: string;
		}>((resolve, reject) => {
			const child = spawn(
				AGENT_BROWSER,
				["--session", this.session, "--json", ...args],
				{
					env: {
						...process.env,
						AGENT_BROWSER_DEFAULT_TIMEOUT: String(ACTION_TIMEOUT),
						AGENT_BROWSER_NO_VERSION_CHECK: "1",
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let out = "";
			let err = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				out += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				err += chunk;
			});
			child.on("error", (error) => {
				reject(
					new Error(
						`${label} could not start. Run "bun install", then "bunx agent-browser install".`,
						{ cause: error },
					),
				);
			});
			child.on("close", (exitCode) =>
				resolve({ code: exitCode, stdout: out, stderr: err }),
			);
			child.stdin.end(stdin ?? "");
		});

		let response: CliResponse;
		try {
			response = JSON.parse(stdout.trim()) as CliResponse;
		} catch (error) {
			throw new Error(
				this.redact(
					`${label} returned no JSON (exit ${code}). stdout: ${stdout.trim()} stderr: ${stderr.trim()}`,
				),
				{ cause: error },
			);
		}
		if (!response.success || code !== 0) {
			throw new Error(
				this.redact(
					`${label} failed: ${response.error ?? `exit ${code}`}${stderr.trim() ? ` (${stderr.trim()})` : ""}`,
				),
			);
		}
		return response.data;
	}

	/** Launches Chrome with the init script registered, then opens `url`. */
	async launch(url: string, initScript: string) {
		await this.run(["--init-script", initScript, "open", url]);
	}

	async setViewport(width: number, height: number) {
		await this.run(["set", "viewport", String(width), String(height)]);
	}

	async open(url: string) {
		await this.run(["open", url]);
	}

	async reload() {
		await this.run(["reload"]);
	}

	/**
	 * Runs `fn(arg)` in the page and returns its JSON result. The script goes
	 * over stdin; `fn` must be self-contained (it is sent as source).
	 */
	async evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R> {
		const data = (await this.run(
			["eval", "--stdin"],
			`(${fn.toString()})(${JSON.stringify(arg)})`,
		)) as { result: R } | null;
		return data?.result as R;
	}

	/**
	 * Waits until `fn(arg)` is truthy in the page, using agent-browser's own
	 * `wait --fn` and repeating it until `timeout`. No fixed sleeps.
	 */
	async waitFor<A>(
		description: string,
		fn: (arg: A) => unknown,
		arg: A,
		timeout = ACTION_TIMEOUT,
	) {
		await this.waitForExpression(
			description,
			`(${fn.toString()})(${JSON.stringify(arg)})`,
			timeout,
		);
	}

	private async waitForExpression(
		description: string,
		expression: string,
		timeout: number,
	) {
		const deadline = Date.now() + timeout;
		for (;;) {
			try {
				await this.run(["wait", "--fn", expression]);
				return;
			} catch (error) {
				if (Date.now() >= deadline) {
					throw new Error(`Timed out after ${timeout} ms: ${description}`, {
						cause: error,
					});
				}
			}
		}
	}

	/** Reads the element `locator` finds, or count 0. */
	query(locator: Locator, attributes?: string[]): Promise<QueryResult> {
		return this.evaluate(pageQuery, {
			locator: toPageLocator(locator),
			attributes,
		});
	}

	/**
	 * Waits until `check(result, extra)` holds for `locator`; by default, until
	 * it is visible. `check` runs in the page, so it must be self-contained.
	 */
	async waitUntil<E = undefined>(
		description: string,
		locator: Locator,
		check: (result: QueryResult, extra: E) => boolean = (result) =>
			result.count > 0,
		extra?: E,
		timeout = ACTION_TIMEOUT,
	) {
		// Composed here, not with eval in the page: the app's CSP may forbid it.
		const args: QueryArgs = { locator: toPageLocator(locator) };
		await this.waitForExpression(
			description,
			`(${check.toString()})((${pageQuery.toString()})(${JSON.stringify(args)}), ${JSON.stringify(extra ?? null)})`,
			timeout,
		);
	}

	/** Waits for exactly the element `locator` finds, then marks it. */
	private async mark(locator: Locator): Promise<string> {
		const mark = `t${++this.marks}`;
		await this.waitUntil(`${describe(locator)} to be on the page`, locator);
		const found = await this.evaluate(pageQuery, {
			locator: toPageLocator(locator),
			mark,
		});
		if (found.count === 0) {
			throw new Error(`${describe(locator)} went away before it could be used`);
		}
		if (found.count > 1 && locator.index === undefined) {
			throw new Error(
				`${describe(locator)} matches ${found.count} elements; narrow it or give an index`,
			);
		}
		return `[data-e2e-target="${mark}"]`;
	}

	/** Clicks the element `locator` finds, with agent-browser's own click. */
	async click(locator: Locator) {
		await this.run(["click", await this.mark(locator)]);
	}

	/** Fills the field `locator` finds. Never use this for a secret. */
	async fill(locator: Locator, value: string) {
		await this.run(["fill", await this.mark(locator), value]);
	}

	async press(key: string) {
		await this.run(["press", key]);
	}

	async screenshot(file: string) {
		await this.run(["screenshot", file]);
	}

	async close() {
		await this.run(["close"]);
	}
}
