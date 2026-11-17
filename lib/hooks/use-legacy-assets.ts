"use client";

import {
	type Bsv20Balance,
	type ScanProgress,
	type ScanResult,
	scanAddresses,
	type TokenBalance,
} from "@1sat/actions";
import type { IndexedOutput } from "@1sat/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createStackServices, stackContentUrl } from "@/lib/stack";
import { legacyAddressKey } from "@/lib/wallet/legacy-scan-state";
import {
	excludeUnsweepableTokens,
	splitBsv20Outputs,
	type UnsweepableBsv20,
} from "@/lib/wallet/migration-listings";

export type { Bsv20Balance, TokenBalance };

// IndexedOutput enriched with display metadata resolved from its events
export interface EnrichedOrdinal extends IndexedOutput {
	origin?: string;
	contentType?: string;
	name?: string;
	contentUrl: string;
}

export interface LegacyAssets {
	loading: boolean;
	/**
	 * A scan of the current legacy addresses has finished (with a result or an
	 * error). False before the first scan starts and after the addresses change.
	 */
	scanned: boolean;
	error: string | null;
	funding: IndexedOutput[];
	ordinals: EnrichedOrdinal[];
	opnsNames: EnrichedOrdinal[];
	bsv21Tokens: TokenBalance[];
	/** Every BSV-20 output the scan found */
	bsv20Tokens: IndexedOutput[];
	/** BSV-20 outputs grouped by ticker: the ones the sweep can move */
	bsv20Balances: Bsv20Balance[];
	/** BSV-20 outputs with no readable tick or amount: left in place */
	/** BSV-20 outputs left at their address, each with the reason */
	bsv20Unsweepable: UnsweepableBsv20[];
	/** OrdLock v2 listings at the scanned addresses, in every class */
	listings: IndexedOutput[];
	locked: IndexedOutput[];
	run: IndexedOutput[];
	totalBsv: number;
	rescan: () => void;
}

const getEvent = (events: string[], prefix: string): string | undefined => {
	const e = events.find((ev) => ev.startsWith(prefix));
	return e ? e.slice(prefix.length) : undefined;
};

const enrichOrdinal = (out: IndexedOutput): EnrichedOrdinal => {
	const events = out.events ?? [];
	const origin = getEvent(events, "origin:");
	const types = events
		.filter((e) => e.startsWith("type:"))
		.map((e) => e.slice(5));
	const contentType = types.find((t) => t.includes("/")) ?? types[0];
	const name = getEvent(events, "name:");
	const contentUrl = stackContentUrl(origin ?? out.outpoint);
	return { ...out, origin, contentType, name, contentUrl };
};

const resolveIconUrl = (tokenId: string, icon?: string): string => {
	if (!icon) return "";
	let outpoint = icon;
	if (icon.startsWith("_")) {
		outpoint = `${tokenId.split("_")[0]}${icon}`;
	}
	return stackContentUrl(outpoint);
};

/**
 * Scan legacy addresses via the 1sat stack (@1sat/actions scanAddresses):
 * forced indexer re-sync, event-tag categorization (funding vs ordinals vs
 * OPNS vs BSV-21 vs locked vs RUN), and overlay-validated BSV-21 amounts —
 * the same scan the yours-wallet sweep tool uses.
 */
export function useLegacyAssets(
	legacyPayAddress: string | null,
	legacyOrdAddress: string | null,
	legacyIdentityAddress?: string | null,
	onScanProgress?: (p: ScanProgress) => void,
): LegacyAssets {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ScanResult | null>(null);
	const [scannedKey, setScannedKey] = useState<string | null>(null);
	const addressKey = legacyAddressKey([
		legacyPayAddress,
		legacyOrdAddress,
		legacyIdentityAddress,
	]);

	// Scanning needs services only (no wallet) — a standalone instance so the
	// banner works even when the BRC-100 wallet failed to initialize
	const [services] = useState(() => createStackServices());

	const [scanTrigger, setScanTrigger] = useState(0);
	const rescan = useCallback(() => {
		setScanTrigger((prev) => prev + 1);
	}, []);

	const progressRef = useRef(onScanProgress);
	useEffect(() => {
		progressRef.current = onScanProgress;
	}, [onScanProgress]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scanTrigger is an intentional rescan signal
	useEffect(() => {
		if (!legacyPayAddress && !legacyOrdAddress && !legacyIdentityAddress) {
			return;
		}

		let cancelled = false;
		const scanKey = legacyAddressKey([
			legacyPayAddress,
			legacyOrdAddress,
			legacyIdentityAddress,
		]);

		async function scan() {
			setLoading(true);
			setError(null);
			setScannedKey(null);
			try {
				const addresses = [
					...new Set(
						[legacyPayAddress, legacyOrdAddress, legacyIdentityAddress].filter(
							(a): a is string => !!a,
						),
					),
				];
				const scanResult = await scanAddresses(services, addresses, (p) =>
					progressRef.current?.(p),
				);
				if (cancelled) return;
				setResult(scanResult);
				setScannedKey(scanKey);
			} catch (err) {
				if (cancelled) return;
				console.error("Legacy address scan failed", err);
				setError(
					err instanceof Error
						? err.message
						: "Failed to scan legacy addresses",
				);
				setScannedKey(scanKey);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}

		scan();
		return () => {
			cancelled = true;
		};
	}, [legacyPayAddress, legacyOrdAddress, legacyIdentityAddress, scanTrigger]);

	const bsv20 = useMemo(
		() => splitBsv20Outputs(result?.bsv20Tokens ?? []),
		[result],
	);

	const scanned = addressKey !== null && scannedKey === addressKey;

	return {
		// Before the scan effect has started, an address set with no finished
		// scan still counts as loading, so nothing reads "no assets" too early.
		loading: loading || (addressKey !== null && !scanned),
		scanned,
		error,
		funding: result?.funding ?? [],
		ordinals: (result?.ordinals ?? []).map(enrichOrdinal),
		opnsNames: (result?.opnsNames ?? []).map(enrichOrdinal),
		bsv21Tokens: excludeUnsweepableTokens(result?.bsv21Tokens ?? []).map(
			(t) => ({
				...t,
				icon: resolveIconUrl(t.tokenId, t.icon),
			}),
		),
		bsv20Tokens: result?.bsv20Tokens ?? [],
		bsv20Balances: bsv20.balances,
		bsv20Unsweepable: bsv20.unsweepable,
		listings: result?.listings ?? [],
		locked: result?.locked ?? [],
		run: result?.run ?? [],
		totalBsv: result?.totalFundingSats ?? 0,
		rescan,
	};
}
