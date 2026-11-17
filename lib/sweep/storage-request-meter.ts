/**
 * Measures the requests the wallet sends to its remote storage server, as
 * they go out: the exact body bytes, how binary fields were encoded, and the
 * server's answer. The sweep sizes its batches from these, and the audit
 * record keeps them.
 *
 * @bsv/wallet-toolbox-client's StorageClient serializes each JSON-RPC call
 * and posts it with `authenticatedFetch(url, init)`; `init.body` is the exact
 * request body. Binary fields such as createAction's inputBEEF go as
 * {"$bsvBinary":"base64","data":...} when the client sends the
 * X-BSV-Binary-Request-Encoding: base64 header, and as a JSON array of byte
 * values otherwise (`requestUsesBinary`).
 */

export type StorageRequestEncoding = "base64" | "number-array";

export interface MeteredStorageRequest {
	/** JSON-RPC method, e.g. "createAction" */
	method: string;
	/** Exact request body bytes */
	bytes: number;
	encoding: StorageRequestEncoding;
	/** HTTP status, or null when the request failed before an answer */
	status: number | null;
}

export interface StorageRequestMeter {
	readonly requests: readonly MeteredStorageRequest[];
	/** How the client will encode createAction's BEEF, when it can tell */
	encoding(): StorageRequestEncoding | null;
	restore(): void;
}

const BINARY_REQUEST_HEADER = "x-bsv-binary-request-encoding";

interface StorageClientLike {
	authenticatedFetch: (url: string, init: RequestInit) => Promise<Response>;
	requestUsesBinary?: (method: string) => boolean;
}

/** The wallet's active remote store, when it has one (toolbox Wallet). */
function activeStorageClient(wallet: unknown): StorageClientLike | null {
	try {
		const storage = (wallet as { storage?: { getActive?: () => unknown } })
			.storage;
		const active = storage?.getActive?.();
		if (
			active &&
			typeof (active as StorageClientLike).authenticatedFetch === "function"
		) {
			return active as StorageClientLike;
		}
	} catch (error) {
		console.debug("[sweep] wallet storage client not reachable", error);
	}
	return null;
}

function headerValue(
	headers: RequestInit["headers"],
	name: string,
): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	const entries = Array.isArray(headers) ? headers : Object.entries(headers);
	const found = entries.find(([key]) => key.toLowerCase() === name);
	return found ? String(found[1]) : null;
}

/** UTF-8 length of a string, counted without encoding a copy of it. */
function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

function bodyBytes(body: RequestInit["body"]): number {
	if (typeof body === "string") return utf8Length(body);
	if (body instanceof Uint8Array) return body.length;
	if (body instanceof ArrayBuffer) return body.byteLength;
	return 0;
}

function rpcMethod(body: RequestInit["body"]): string {
	if (typeof body !== "string") return "unknown";
	return /"method"\s*:\s*"([^"]+)"/.exec(body.slice(0, 256))?.[1] ?? "unknown";
}

/**
 * One wrapper per client, shared by every run metering it, so runs that
 * overlap on one wallet each see every request and the last to finish puts
 * the client back as it was.
 */
interface ClientTap {
	listeners: Set<MeteredStorageRequest[]>;
	hadOwn: boolean;
	original: StorageClientLike["authenticatedFetch"];
}

const taps = new WeakMap<StorageClientLike, ClientTap>();

function tapClient(client: StorageClientLike): ClientTap {
	const existing = taps.get(client);
	if (existing) return existing;
	const tap: ClientTap = {
		listeners: new Set(),
		hadOwn: Object.hasOwn(client, "authenticatedFetch"),
		original: client.authenticatedFetch,
	};
	client.authenticatedFetch = async (url, init) => {
		const entry: MeteredStorageRequest = {
			method: rpcMethod(init?.body),
			bytes: bodyBytes(init?.body),
			encoding:
				headerValue(init?.headers, BINARY_REQUEST_HEADER) === "base64"
					? "base64"
					: "number-array",
			status: null,
		};
		for (const requests of tap.listeners) requests.push(entry);
		const response = await tap.original.call(client, url, init);
		entry.status = response.status;
		return response;
	};
	taps.set(client, tap);
	return tap;
}

function untapClient(client: StorageClientLike, tap: ClientTap): void {
	if (tap.listeners.size > 0 || taps.get(client) !== tap) return;
	taps.delete(client);
	if (tap.hadOwn) client.authenticatedFetch = tap.original;
	else delete (client as Partial<StorageClientLike>).authenticatedFetch;
}

/**
 * Start metering the wallet's storage requests. Null when the wallet has no
 * reachable remote store; the sweep then sizes for the larger encoding.
 * Call restore() when the run ends.
 */
export function meterStorageRequests(
	wallet: unknown,
): StorageRequestMeter | null {
	const client = activeStorageClient(wallet);
	if (!client) return null;
	const requests: MeteredStorageRequest[] = [];
	const tap = tapClient(client);
	tap.listeners.add(requests);
	let restored = false;
	return {
		requests,
		encoding() {
			if (typeof client.requestUsesBinary === "function") {
				try {
					return client.requestUsesBinary("createAction")
						? "base64"
						: "number-array";
				} catch (error) {
					console.debug("[sweep] requestUsesBinary failed", error);
				}
			}
			return requests.at(-1)?.encoding ?? null;
		},
		restore() {
			if (restored) return;
			restored = true;
			tap.listeners.delete(requests);
			untapClient(client, tap);
		},
	};
}
