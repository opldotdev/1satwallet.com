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

const REQUEST_TIMEOUT_MS = 8000;

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
		const length = Number(response.headers.get("content-length") ?? "0");
		if (length > BSV20_CONTENT_MAX_BYTES) return null;
		const text = await response.text();
		return parseBsv20Content(text);
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
	const wanted = useMemo(() => outpoints.slice(0, max), [outpoints, max]);

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
					cache.set(outpoint, await fetchContent(outpoint, controller.signal));
				} catch (error) {
					if (controller.signal.aborted) return;
					console.debug("[sweep] BSV-20 content not read", outpoint, error);
					cache.set(outpoint, null);
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
