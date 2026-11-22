/**
 * Retries a wallet-server call that the server turned away with HTTP 429
 * (too many requests), after a growing pause. Any other error, and a 429 that
 * outlasts the retries, is thrown as it came.
 */

/** Pauses before each retry: 2, 4 and 8 seconds. */
export const RATE_LIMIT_DELAYS_MS = [2_000, 4_000, 8_000] as const;

/** True for an error carrying an HTTP 429, as the SDK's auth transport reports one. */
export function isRateLimited(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const details = (error as { details?: { status?: unknown } }).details;
	if (details?.status === 429) return true;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && /\bHTTP 429\b/.test(message);
}

export async function withRateLimitRetry<T>(
	operation: string,
	run: () => Promise<T>,
	deps: {
		delays?: readonly number[];
		sleep?: (ms: number) => Promise<void>;
		log?: (message: string) => void;
	} = {},
): Promise<T> {
	const delays = deps.delays ?? RATE_LIMIT_DELAYS_MS;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = deps.log ?? ((message: string) => console.warn(message));
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			const delay = delays[attempt];
			if (delay === undefined || !isRateLimited(error)) throw error;
			log(
				`[${operation}] The server answered HTTP 429 (too many requests); retry ${attempt + 1} of ${delays.length} in ${delay / 1000} s.`,
			);
			await sleep(delay);
		}
	}
}
