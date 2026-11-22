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

/** A failed agent-browser command, with the CLI's own error text. */
export class AgentBrowserError extends Error {
	constructor(
		message: string,
		readonly cliError: string,
	) {
		super(message);
		this.name = "AgentBrowserError";
	}
}

/** agent-browser's wait reports "Wait timed out after …" when it gives up. */
const isWaitTimeout = (error: unknown) =>
	error instanceof AgentBrowserError && /timed? ?out/i.test(error.cliError);

/** Long arguments (wait --fn expressions) shortened for error messages. */
const shorten = (arg: string) =>
	arg.length > 120 ? `${arg.slice(0, 117)}…` : arg;

/** Console levels a failed test prints; info and debug are left out. */
const CONSOLE_LEVELS = /^(error|warn|warning|assert)$/i;
/** The newest entries printed, each cut to this many characters. */
const CONSOLE_MAX_ENTRIES = 40;
const CONSOLE_MAX_CHARS = 600;
/**
 * A line sharing a run this long with a long secret (the encrypted backup)
 * is withheld whole, so not even part of a secret is printed.
 */
const SECRET_FRAGMENT = 24;

/** The entries of `console --json` or `errors --json`, whatever wraps them. */
function entriesOf(data: unknown): unknown[] {
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object") {
		for (const key of ["messages", "errors", "logs", "entries"]) {
			const value = (data as Record<string, unknown>)[key];
			if (Array.isArray(value)) return value;
		}
	}
	return [];
}

const stringField = (
	entry: Record<string, unknown>,
	keys: readonly string[],
): string | undefined => {
	for (const key of keys) {
		const value = entry[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
};

/**
 * The console errors and warnings, then the uncaught page errors, from
 * agent-browser's `console --json` and `errors --json` data, as one line each
 * ("[error] …", "[page error] …"). Not redacted: callers redact.
 */
export function consoleProblemLines(
	consoleData: unknown,
	errorsData: unknown,
): string[] {
	const lines: string[] = [];
	for (const raw of entriesOf(consoleData)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const level = stringField(entry, ["level", "type"]) ?? "log";
		if (!CONSOLE_LEVELS.test(level)) continue;
		const text =
			stringField(entry, ["text", "message"]) ?? JSON.stringify(entry);
		lines.push(`[${level.toLowerCase()}] ${text}`);
	}
	for (const raw of entriesOf(errorsData)) {
		const text =
			typeof raw === "string"
				? raw
				: raw && typeof raw === "object"
					? (stringField(raw as Record<string, unknown>, [
							"message",
							"text",
							"description",
						]) ?? JSON.stringify(raw))
					: String(raw);
		lines.push(`[page error] ${text}`);
	}
	return lines
		.map((line) => line.replace(/\s+/g, " ").trim())
		.map((line) =>
			line.length > CONSOLE_MAX_CHARS
				? `${line.slice(0, CONSOLE_MAX_CHARS - 1)}…`
				: line,
		);
}

/**
 * The environment for agent-browser, its daemon and Chrome: without the e2e
 * wallet settings, so they can't reach those processes even by accident.
 */
export function cliEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		AGENT_BROWSER_DEFAULT_TIMEOUT: String(ACTION_TIMEOUT),
		AGENT_BROWSER_NO_VERSION_CHECK: "1",
	};
	for (const key of Object.keys(env)) {
		if (key.startsWith("E2E_WALLET_") || key === "E2E_SECRETS_FILE") {
			delete env[key];
		}
	}
	return env;
}

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

	/**
	 * @param secrets redacted from every error message
	 * @param budgetEnd waits give up at this time (ms since epoch), so a
	 *   test fails with a clear message and still closes its browser before
	 *   bun's own test timeout
	 */
	constructor(
		private readonly secrets: readonly string[] = [],
		private readonly budgetEnd = Number.POSITIVE_INFINITY,
	) {}

	redact(text: string): string {
		return this.secrets
			.filter((secret) => secret.length > 0)
			.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
	}

	private secretFragments: Set<string> | null = null;

	/** True when `text` holds a SECRET_FRAGMENT-long run of a long secret. */
	private holdsSecretFragment(text: string): boolean {
		if (!this.secretFragments) {
			const fragments = new Set<string>();
			for (const secret of this.secrets) {
				for (let i = 0; i + SECRET_FRAGMENT <= secret.length; i++) {
					fragments.add(secret.slice(i, i + SECRET_FRAGMENT));
				}
			}
			this.secretFragments = fragments;
		}
		if (this.secretFragments.size === 0) return false;
		for (let i = 0; i + SECRET_FRAGMENT <= text.length; i++) {
			if (this.secretFragments.has(text.slice(i, i + SECRET_FRAGMENT))) {
				return true;
			}
		}
		return false;
	}

	/** One console line, safe to print. */
	redactConsoleLine(line: string): string {
		const redacted = this.redact(line);
		return this.holdsSecretFragment(redacted)
			? "[withheld: the line held part of a secret]"
			: redacted;
	}

	/**
	 * The page's console errors and warnings and its uncaught errors since the
	 * session started, newest last, redacted: a whole secret is replaced, and
	 * a line holding any long run of one is withheld whole.
	 */
	async consoleProblems(): Promise<string[]> {
		const lines = consoleProblemLines(
			await this.run(["console"]),
			await this.run(["errors"]),
		);
		const shown = lines
			.slice(-CONSOLE_MAX_ENTRIES)
			.map((line) => this.redactConsoleLine(line));
		const dropped = lines.length - shown.length;
		return dropped > 0
			? [`(${dropped} older lines not shown)`, ...shown]
			: shown;
	}

	/** Runs one command; throws with the CLI's own error when it fails. */
	async run(args: readonly string[], stdin?: string): Promise<unknown> {
		const label = `agent-browser ${args.map(shorten).join(" ")}`;
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
					env: cliEnv(),
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
			const cliError = this.redact(response.error ?? `exit ${code}`);
			throw new AgentBrowserError(
				this.redact(
					`${label} failed: ${cliError}${stderr.trim() ? ` (${stderr.trim()})` : ""}`,
				),
				cliError,
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
		const started = Date.now();
		const deadline = Math.min(started + timeout, this.budgetEnd);
		for (;;) {
			if (Date.now() >= this.budgetEnd) {
				throw new Error(
					`The test ran out of time while waiting for ${description}.`,
				);
			}
			try {
				await this.run(["wait", "--fn", expression]);
				return;
			} catch (error) {
				// Only agent-browser's own wait timeout means "not yet".
				if (!isWaitTimeout(error)) throw error;
				if (Date.now() >= deadline) {
					// The time actually waited: one agent-browser wait can outlast
					// a short `timeout` (with 0, exactly one wait runs).
					throw new Error(
						`Timed out after ${Date.now() - started} ms: ${description}`,
						{ cause: error },
					);
				}
			}
		}
	}

	/** Reads the element `locator` finds, or count 0. */
	query(locator: Locator, attributes?: string[]): Promise<QueryResult> {
		return this.evaluate(pageQuery, {
			locator: toPageLocator(locator),
			attributes: [...(locator.attributes ?? []), ...(attributes ?? [])],
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
		const args: QueryArgs = {
			locator: toPageLocator(locator),
			attributes: locator.attributes,
		};
		await this.waitForExpression(
			description,
			`(${check.toString()})((${pageQuery.toString()})(${JSON.stringify(args)}), ${JSON.stringify(extra ?? null)})`,
			timeout,
		);
	}

	/**
	 * Waits until the element `locator` finds is on the page and enabled,
	 * then marks it for agent-browser to act on.
	 */
	private async mark(locator: Locator, timeout?: number): Promise<string> {
		const mark = `t${++this.marks}`;
		await this.waitUntil(
			`${describe(locator)} to be on the page and enabled`,
			locator,
			(result) => result.count > 0 && result.disabled !== true,
			undefined,
			timeout,
		);
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

	/**
	 * Clicks the element `locator` finds, with agent-browser's own click.
	 *
	 * As a person would before tapping, it waits for the element to stop
	 * moving, then scrolls it just far enough to show it whole and checks that
	 * its centre is inside the window. A bottom sheet slides up from below the
	 * window (the unlock screen on phones), and scrolling can't bring a
	 * transformed element into view. agent-browser (0.43) scrolls only an
	 * element wholly off screen: one that peeks in at the bottom edge with its
	 * centre below the fold is refused as "outside the viewport".
	 */
	async click(locator: Locator, timeout?: number) {
		const target = await this.mark(locator, timeout);
		const what = describe(locator);
		await this.waitFor(
			`${what} to stop moving (no enter animation running on it or a container)`,
			(selector: string) => {
				const el = document.querySelector(selector);
				if (!el) return false;
				return !document.getAnimations().some((animation) => {
					const effect = animation.effect;
					if (!(effect instanceof KeyframeEffect)) return false;
					const { target } = effect;
					return (
						animation.playState === "running" &&
						target instanceof Element &&
						target.contains(el) &&
						// A looping animation (a pulse, a spinner) never ends.
						effect.getComputedTiming().iterations !== Number.POSITIVE_INFINITY
					);
				});
			},
			target,
		);
		await this.evaluate((selector: string) => {
			document.querySelector(selector)?.scrollIntoView({
				block: "nearest",
				inline: "nearest",
				behavior: "instant",
			});
		}, target);
		try {
			await this.waitFor(
				`${what} to have its centre inside the window`,
				(selector: string) => {
					const box = document.querySelector(selector)?.getBoundingClientRect();
					if (!box) return false;
					const x = box.left + box.width / 2;
					const y = box.top + box.height / 2;
					return (
						x >= 0 &&
						y >= 0 &&
						x <= window.innerWidth &&
						y <= window.innerHeight
					);
				},
				target,
			);
		} catch (error) {
			const box = await this.evaluate((selector: string) => {
				const rect = document.querySelector(selector)?.getBoundingClientRect();
				return rect
					? `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} in a ${window.innerWidth}x${window.innerHeight} window`
					: "gone";
			}, target).catch(
				(measureError: unknown) =>
					`(not measured: ${measureError instanceof Error ? measureError.message : String(measureError)})`,
			);
			throw new Error(`${what} is outside the window after scrolling: ${box}`, {
				cause: error,
			});
		}
		// A dialog or sheet that is closing keeps its overlay over the page
		// until its exit animation ends, and a click then lands on the overlay.
		await this.waitFor(
			"a closing dialog's overlay to go away before clicking",
			() =>
				!document.querySelector('[data-slot$="-overlay"][data-state="closed"]'),
			null,
		);
		await this.run(["click", target]);
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
