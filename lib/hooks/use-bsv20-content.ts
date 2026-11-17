"use client";

import { useEffect, useMemo, useState } from "react";
import { stackContentUrl } from "@/lib/stack";
import {
	BSV20_CONTENT_MAX_BYTES,
	type Bsv20Content,
	type Bsv20Group,
	groupUnconfirmedBsv20,
	parseBsv20Content,
} from "@/lib/wallet/bsv20-content";

/** outpoint -> parsed content (null: unreadable, not BSV-20 or failed). */
const cache = new Map<string, Bsv20Content | null>();
/** The cache keeps at most this many outpoints, dropping the oldest first. */
const CACHE_MAX_ENTRIES = 1000;

function remember(outpoint: string, content: Bsv20Content | null) {
	cache.delete(outpoint);
	cache.set(outpoint, content);
	while (cache.size > CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

const REQUEST_TIMEOUT_MS = 8000;

/** BSV-20 inscriptions are JSON; anything else is not worth reading. */
const isTextual = (contentType: string | null) =>
	!contentType || /json|text\/plain/i.test(contentType);

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

async function fetchContent(
	outpoint: string,
	parent: AbortSignal,
): Promise<Bsv20Content | null> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	parent.addEventListener("abort", abort);
	const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(stackContentUrl(outpoint), {
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		if (!isTextual(response.headers.get("content-type"))) {
			await response.body?.cancel();
			return null;
		}
		const text = await readCapped(response, BSV20_CONTENT_MAX_BYTES);
		return text === null ? null : parseBsv20Content(text);
	} finally {
		clearTimeout(timer);
		parent.removeEventListener("abort", abort);
	}
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
 * Fetches only while `enabled`, at most `max` outputs, `concurrency` at a
 * time, each with a timeout; unmount aborts. Failures read as "Unknown".
 */
export function useBsv20ContentLabels(
	outpoints: string[],
	{
		enabled,
		max = 200,
		concurrency = 6,
	}: { enabled: boolean; max?: number; concurrency?: number },
): Bsv20ContentLabels {
	const [version, setVersion] = useState(0);
	const [loading, setLoading] = useState(false);
	// Keyed on the outpoints themselves, so a list rebuilt on each render
	// neither restarts nor aborts the fetches.
	const wantedKey = outpoints.slice(0, max).join("|");
	const wanted = useMemo(
		() => (wantedKey ? wantedKey.split("|") : []),
		[wantedKey],
	);

	useEffect(() => {
		if (!enabled) return;
		const todo = wanted.filter((outpoint) => !cache.has(outpoint));
		if (todo.length === 0) return;
		const controller = new AbortController();
		let next = 0;
		setLoading(true);
		const worker = async () => {
			while (next < todo.length && !controller.signal.aborted) {
				const outpoint = todo[next++];
				try {
					remember(outpoint, await fetchContent(outpoint, controller.signal));
				} catch (error) {
					if (controller.signal.aborted) return;
					console.debug("[sweep] BSV-20 content not read", outpoint, error);
					remember(outpoint, null);
				}
				setVersion((v) => v + 1);
			}
		};
		void Promise.all(
			Array.from({ length: Math.min(concurrency, todo.length) }, worker),
		).finally(() => {
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
					content: cache.get(outpoint) ?? null,
				})),
			),
			total: outpoints.length,
			checked: read.length,
			loading,
		};
	}, [wanted, outpoints.length, loading, version]);
}
