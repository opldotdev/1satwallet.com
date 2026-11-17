import { normalizeOutpoint } from "@1sat/types";
import type { SweepAuditCount, SweepAuditInit } from "@/lib/sweep-audit/record";
import {
	isListedOutput,
	type ListedAsset,
} from "@/lib/wallet/migration-listings";

type Output = { outpoint: string; tags?: string[]; events?: string[] };
/** A token balance (TokenBalance, Bsv20Balance): only its outputs are read. */
type Outputs = { outputs: readonly Output[] };

/** What a scan found, as the sweep hosts hold it (LegacyAssets). */
export interface AuditScan {
	funding: readonly Output[];
	ordinals: readonly Output[];
	opnsNames: readonly Output[];
	bsv21Tokens: readonly Outputs[];
	bsv20Balances: readonly Outputs[];
	/** UnsweepableBsv20: an output left in place, and why */
	bsv20Unsweepable: readonly { output: Output; reason: string }[];
	locked: readonly Output[];
	run: readonly Output[];
	listings: readonly Output[];
}

/** What a run sends: the plan's lists (MigrationPlan), or a subset of them. */
export interface AuditPlan {
	cancel: readonly ListedAsset[];
	sweepListed: readonly Output[];
	sweepOrdinals: readonly Output[];
	sweepFunding: readonly Output[];
	sweepBsv21: readonly Outputs[];
	sweepBsv20: readonly Outputs[];
}

const canonical = (outpoint: string): string => {
	try {
		return normalizeOutpoint(outpoint);
	} catch {
		return outpoint;
	}
};

const tokenOutputs = (balances: readonly Outputs[]): Output[] =>
	balances.flatMap((balance) => [...balance.outputs]);

export const SKIPPED_BY_USER = "skipped by user";

/**
 * The scan's counts per class and every scanned output this run does not
 * send, with the reason: the user's choice, or why it stays where it is.
 * `skippedReason` names why an output the user could have sent was left out
 * (a cancel-listings-only run leaves everything else out by design).
 */
export function auditPlanFromScan(
	scan: AuditScan,
	plan: AuditPlan,
	options: { listings: readonly ListedAsset[]; skippedReason?: string },
): Pick<SweepAuditInit, "scan" | "planLeftBehind"> {
	const skippedReason = options.skippedReason ?? SKIPPED_BY_USER;
	const planned = new Set(
		[
			...plan.sweepFunding,
			...plan.sweepOrdinals,
			...plan.sweepListed,
			...tokenOutputs(plan.sweepBsv21),
			...tokenOutputs(plan.sweepBsv20),
		].map((o) => canonical(o.outpoint)),
	);
	const cancelled = new Set(plan.cancel.map((l) => canonical(l.outpoint)));

	const unlisted = (outputs: readonly Output[]) =>
		outputs.filter((o) => !isListedOutput(o));
	const selected = (outputs: readonly Output[]) =>
		outputs.filter((o) => planned.has(canonical(o.outpoint))).length;

	const bsv21 = tokenOutputs(scan.bsv21Tokens);
	const bsv20 = tokenOutputs(scan.bsv20Balances);
	const counts: SweepAuditCount[] = [
		{
			kind: "BSV funding",
			found: scan.funding.length,
			selected: selected(scan.funding),
		},
		{
			kind: "Ordinals",
			found: unlisted(scan.ordinals).length,
			selected: selected(unlisted(scan.ordinals)),
		},
		{
			kind: "OpNS names",
			found: unlisted(scan.opnsNames).length,
			selected: selected(unlisted(scan.opnsNames)),
		},
		{
			kind: "Listings",
			found: options.listings.length,
			selected: options.listings.filter(
				(l) =>
					cancelled.has(canonical(l.outpoint)) ||
					planned.has(canonical(l.outpoint)),
			).length,
		},
		{ kind: "BSV-21 outputs", found: bsv21.length, selected: selected(bsv21) },
		{
			kind: "BSV-20 outputs",
			found: bsv20.length + scan.bsv20Unsweepable.length,
			selected: selected(bsv20),
		},
		{ kind: "Time-locked outputs", found: scan.locked.length, selected: 0 },
		{ kind: "RUN outputs", found: scan.run.length, selected: 0 },
	];

	// Each scanned output once, first class wins; every one the run does not
	// send is recorded with its reason.
	const left: SweepAuditInit["planLeftBehind"] = [];
	const seen = new Set<string>();
	const leave = (
		outputs: readonly Output[],
		kind: string,
		reason: (o: Output) => string,
	) => {
		for (const o of outputs) {
			const key = canonical(o.outpoint);
			if (seen.has(key)) continue;
			seen.add(key);
			if (planned.has(key) || cancelled.has(key)) continue;
			left.push({ outpoint: o.outpoint, kind, reason: reason(o) });
		}
	};
	const listedOr = (o: Output) =>
		isListedOutput(o)
			? "listed: open listings were not included in this run"
			: skippedReason;
	leave(scan.locked, "Time-locked output", () => "time-locked; not swept");
	leave(
		scan.run,
		"RUN output",
		() => "RUN output; kept out of the sweep so its token state is not spent",
	);
	for (const item of scan.bsv20Unsweepable) {
		leave([item.output], "BSV-20 output", () => `BSV-20: ${item.reason}`);
	}
	leave(scan.funding, "BSV funding", () => skippedReason);
	leave(scan.ordinals, "Ordinal", listedOr);
	leave(scan.opnsNames, "OpNS name", listedOr);
	leave(bsv21, "BSV-21 output", listedOr);
	leave(bsv20, "BSV-20 output", listedOr);
	leave(scan.listings, "Listing", listedOr);
	// Listings held by this wallet itself (not at a scanned address)
	for (const listing of options.listings) {
		const key = canonical(listing.outpoint);
		if (seen.has(key)) continue;
		seen.add(key);
		if (cancelled.has(key) || planned.has(key)) continue;
		left.push({
			outpoint: listing.outpoint,
			kind: "Listing",
			reason: "listing left open: open listings were not included in this run",
		});
	}

	return { scan: counts, planLeftBehind: left };
}
