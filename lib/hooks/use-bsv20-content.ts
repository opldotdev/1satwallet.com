"use client";

import { useEffect, useMemo, useState } from "react";
import { stackContentUrl } from "@/lib/stack";
import {
	BSV20_CONTENT_MAX_BYTES,
	BSV20_UNREADABLE,
	type Bsv20Group,
	type Bsv20Read,
	groupUnconfirmedBsv20,
	isBsv20ContentType,
	parseBsv20Content,
} from "@/lib/wallet/bsv20-content";

/** outpoint -> what reading its content gave. */
const cache = new Map<string, Bsv20Read>();
/**
 * The cache keeps at least this many outpoints (more while a longer list is
 * on screen), dropping the oldest first.
 */
const CACHE_MIN_ENTRIES = 1000;

function remember(outpoint: string, read: Bsv20Read, keep: number) {
	cache.delete(outpoint);
	cache.set(outpoint, read);
	while (cache.size > Math.max(CACHE_MIN_ENTRIES, keep)) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Reads at most `max` bytes of the body, cancelling the stream past that, so
 * a large or mislabelled inscription is never downloaded in full.
 */
async function readCapped(
	response: Response,
	max: number,
): Promise<string | null> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > max) {
		await response.body?.cancel();
		return null;
	}
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/** Read one output's content as BSV-20, or say why it can't be. */
export async function readBsv20Content(
	outpoint: string,
	parent: AbortSignal,
	fetchFn: typeof fetch = fetch,
): Promise<Bsv20Read> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	parent.addEventListener("abort", abort);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort();
	}, REQUEST_TIMEOUT_MS);
	try {
		let response: Response;
		try {
			response = await fetchFn(stackContentUrl(outpoint), {
				signal: controller.signal,
			});
		} catch (error) {
			if (parent.aborted) throw error;
			return {
				content: null,
				reason: timedOut ? BSV20_UNREADABLE.timeout : BSV20_UNREADABLE.network,
			};
		}
		if (!response.ok) {
			await response.body?.cancel();
			return { content: null, reason: BSV20_UNREADABLE.http(response.status) };
		}
		const contentType = response.headers.get("content-type");
		if (!isBsv20ContentType(contentType)) {
			await response.body?.cancel();
			return {
				content: null,
				reason: BSV20_UNREADABLE.contentType(
					(contentType ?? "").split(";")[0].trim(),
				),
			};
		}
		const text = await readCapped(response, BSV20_CONTENT_MAX_BYTES);
		if (text === null) {
			return { content: null, reason: BSV20_UNREADABLE.tooLarge };
		}
		const content = parseBsv20Content(text);
		return content
			? { content }
			: { content: null, reason: BSV20_UNREADABLE.notBsv20 };
	} finally {
		clearTimeout(timer);
		parent.removeEventListener("abort", abort);
	}
}

/**
 * Read every outpoint's content, `concurrency` at a time, calling `onRead`
 * as each finishes. Stops taking new ones once `signal` aborts. Every
 * outpoint given is read: the limit is on requests in flight, not coverage.
 */
export async function readBsv20Contents(
	outpoints: readonly string[],
	{
		concurrency,
		signal,
		onRead,
		read = (outpoint) => readBsv20Content(outpoint, signal),
	}: {
		concurrency: number;
		signal: AbortSignal;
		onRead: (outpoint: string, result: Bsv20Read) => void;
		read?: (outpoint: string) => Promise<Bsv20Read>;
	},
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < outpoints.length && !signal.aborted) {
			const outpoint = outpoints[next++];
			let result: Bsv20Read;
			try {
				result = await read(outpoint);
			} catch (error) {
				if (signal.aborted) return;
				console.debug("[sweep] BSV-20 content not read", outpoint, error);
				result = { content: null, reason: BSV20_UNREADABLE.network };
			}
			if (signal.aborted) return;
			onRead(outpoint, result);
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(Math.max(1, concurrency), outpoints.length) },
			worker,
		),
	);
}

export interface Bsv20ContentLabels {
	groups: Bsv20Group[];
	/** Every unconfirmed BSV-20 output. */
	total: number;
	/** How many of them have been read (or failed). */
	checked: number;
	loading: boolean;
}

/**
 * Reads what each unconfirmed BSV-20 inscription claims (ticker, amount) so
 * the screen can name it. Display only: nothing here reaches the sweep.
 * Fetches every output while `enabled`, `concurrency` at a time, each with a
 * timeout; unmount aborts. Outputs that can't be read are grouped as
 * "Unreadable", with the reason.
 */
export function useBsv20ContentLabels(
	outpoints: string[],
	{ enabled, concurrency = 6 }: { enabled: boolean; concurrency?: number },
): Bsv20ContentLabels {
	const [version, setVersion] = useState(0);
	const [loading, setLoading] = useState(false);
	// Keyed on the outpoints themselves, so a list rebuilt on each render
	// neither restarts nor aborts the fetches.
	const wantedKey = outpoints.join("|");
	const wanted = useMemo(
		() => (wantedKey ? wantedKey.split("|") : []),
		[wantedKey],
	);

	useEffect(() => {
		if (!enabled) return;
		const todo = wanted.filter((outpoint) => !cache.has(outpoint));
		if (todo.length === 0) return;
		const controller = new AbortController();
		setLoading(true);
		void readBsv20Contents(todo, {
			concurrency,
			signal: controller.signal,
			onRead: (outpoint, read) => {
				remember(outpoint, read, wanted.length);
				setVersion((v) => v + 1);
			},
		}).finally(() => {
			if (!controller.signal.aborted) setLoading(false);
		});
		return () => {
			controller.abort();
			setLoading(false);
		};
	}, [enabled, wanted, concurrency]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: version marks cache writes
	return useMemo(() => {
		const read = wanted.filter((outpoint) => cache.has(outpoint));
		return {
			groups: groupUnconfirmedBsv20(
				read.map((outpoint) => ({
					outpoint,
					read: cache.get(outpoint) as Bsv20Read,
				})),
			),
			total: outpoints.length,
			checked: read.length,
			loading,
		};
	}, [wanted, outpoints.length, loading, version]);
}
