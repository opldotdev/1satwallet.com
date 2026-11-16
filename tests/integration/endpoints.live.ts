/**
 * Backend reachability gate, run before the browser tests (`bun run test:live`).
 * Named .live.ts so plain `bun test` never runs it. Read-only GETs only.
 * A failure names the host, so an outage is never read as an app bug.
 */
import { describe, test } from "node:test";
import { type Chain, endpointsOf } from "@/lib/chain-endpoints";

const TIMEOUT_MS = 15_000;

function originsOf(chain: Chain): string[] {
	const urls = Object.values(endpointsOf(chain)).filter(
		(url): url is string => typeof url === "string",
	);
	return [...new Set(urls.map((url) => new URL(url).origin))];
}

async function expectAnswers(origin: string) {
	const host = new URL(origin).host;
	let response: Response;
	try {
		response = await fetch(origin, {
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`backend down: ${host} (${reason})`, { cause: error });
	}
	await response.body?.cancel();
	// Any answer below 500 (a 404 on "/" included) means the host is serving.
	if (response.status >= 500) {
		throw new Error(`backend down: ${host} (HTTP ${response.status})`);
	}
}

for (const chain of ["test", "main"] as const) {
	describe(`${chain}net backends`, () => {
		for (const origin of originsOf(chain)) {
			test(
				`${new URL(origin).host} answers a GET`,
				{ timeout: TIMEOUT_MS + 5_000 },
				() => expectAnswers(origin),
			);
		}
	});
}
