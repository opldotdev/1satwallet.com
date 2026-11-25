"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type DiscoverySnapshot,
	discoverWallets,
	type ElicitOutcome,
	elicitLoopback,
	ProbeCancelled,
} from "@/lib/wallet/discovery/discovery";
import {
	type LoopbackPermission,
	readLoopbackPermission,
	watchLoopbackPermission,
} from "@/lib/wallet/discovery/loopback-permission";
import {
	type DevicePlatform,
	detectPlatform,
} from "@/lib/wallet/discovery/platform";

export type DiscoveryPhase = "scanning" | "waiting" | "idle";

export type ElicitResult = {
	outcome: ElicitOutcome;
	snapshot: DiscoverySnapshot;
};

export type WalletDiscovery = {
	platform: DevicePlatform | null;
	snapshot: DiscoverySnapshot | null;
	phase: DiscoveryPhase;
	/** Re-runs discovery without ever raising the browser's question. */
	refresh: () => void;
	/**
	 * The user said yes on the primer: the one request that may raise the
	 * browser's question. Resolves with how that question ended, or null when
	 * the user stopped waiting.
	 */
	elicit: () => Promise<ElicitResult | null>;
	/** Stops waiting on the browser's question. The question stays open. */
	stopWaiting: () => void;
};

/**
 * Wallet discovery for a connect surface (BRC-185 shaped, BRC-325 permission
 * aware). Scans on mount and whenever the page regains focus or the browser's
 * permission changes, but never raises the browser's question on its own.
 */
export function useWalletDiscovery(enabled = true): WalletDiscovery {
	const [platform, setPlatform] = useState<DevicePlatform | null>(null);
	const [snapshot, setSnapshot] = useState<DiscoverySnapshot | null>(null);
	const [phase, setPhase] = useState<DiscoveryPhase>("scanning");
	const mounted = useRef(false);
	const scanning = useRef(false);
	const rescan = useRef(false);
	const waiting = useRef<AbortController | null>(null);
	const statusRef = useRef<Partial<EventTarget> | undefined>(undefined);
	const [status, setStatus] = useState<Partial<EventTarget> | undefined>();

	const readPermission = useCallback(async (): Promise<LoopbackPermission> => {
		const read = await readLoopbackPermission();
		if (read.status && read.status !== statusRef.current) {
			statusRef.current = read.status;
			if (mounted.current) setStatus(read.status);
		}
		return read.state;
	}, []);

	const refresh = useCallback(() => {
		if (waiting.current) return;
		if (scanning.current) {
			rescan.current = true;
			return;
		}
		scanning.current = true;
		setPhase("scanning");
		const run = async () => {
			try {
				do {
					rescan.current = false;
					const current = detectPlatform();
					if (mounted.current) setPlatform(current);
					const permission = await readPermission();
					const next = await discoverWallets({ platform: current, permission });
					// A wait that started meanwhile owns the result.
					if (!mounted.current || waiting.current) return;
					setSnapshot(next);
				} while (rescan.current);
			} catch (error) {
				console.error("[wallet-discovery] scan failed", error);
			} finally {
				scanning.current = false;
				if (mounted.current && !waiting.current) setPhase("idle");
			}
		};
		void run();
	}, [readPermission]);

	const elicit = useCallback(async (): Promise<ElicitResult | null> => {
		waiting.current?.abort();
		const controller = new AbortController();
		waiting.current = controller;
		setPhase("waiting");
		try {
			const current = detectPlatform();
			const result = await elicitLoopback({
				platform: current,
				signal: controller.signal,
				readPermission,
			});
			if (mounted.current) setSnapshot(result.snapshot);
			return result;
		} catch (error) {
			if (error instanceof ProbeCancelled) return null;
			console.error(
				"[wallet-discovery] looking for a desktop wallet failed",
				error,
			);
			throw error;
		} finally {
			if (waiting.current === controller) {
				waiting.current = null;
				if (mounted.current) setPhase("idle");
			}
		}
	}, [readPermission]);

	const stopWaiting = useCallback(() => {
		const controller = waiting.current;
		if (!controller) return;
		waiting.current = null;
		controller.abort();
		setPhase("idle");
		// The question stays open in the browser; a later answer arrives as a
		// permission change and rescans.
		refresh();
	}, [refresh]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			waiting.current?.abort();
			waiting.current = null;
		};
	}, []);

	useEffect(() => {
		if (!enabled) return;
		refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [enabled, refresh]);

	// BRC-325 section 3.5: a change in site settings, or the page coming back
	// into view after a trip there, rescans without a reload.
	useEffect(() => {
		if (!enabled) return;
		return watchLoopbackPermission(refresh, status);
	}, [enabled, refresh, status]);

	return { platform, snapshot, phase, refresh, elicit, stopWaiting };
}
