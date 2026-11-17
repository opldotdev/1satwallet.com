"use client";

import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import {
	SweepAuditList,
	SweepAuditView,
} from "@/components/wallet/sweep-audit-view";
import {
	effectiveSweepAuditStatus,
	type SweepAuditRecord,
} from "@/lib/sweep-audit/record";
import { sweepAuditRunsHere } from "@/lib/sweep-audit/recorder";
import { type SweepAuditStore, sweepAuditStore } from "@/lib/sweep-audit/store";
import { sweepAuditIdentityKey } from "@/lib/sweep-audit/use-sweep-audit";
import { useWallet } from "@/providers/wallet-provider";

const statusOf = (record: SweepAuditRecord) =>
	effectiveSweepAuditStatus(record, sweepAuditRunsHere());

/**
 * Every sweep this wallet ran in this browser (migration and key sweeps),
 * newest first. A run opens its full record with Copy report and Download.
 */
export function SweepHistory({
	store = sweepAuditStore(),
}: {
	store?: SweepAuditStore;
}) {
	const { walletKeys, isWalletLocked } = useWallet();
	const identityKey = useMemo(
		() => (walletKeys ? sweepAuditIdentityKey(walletKeys) : null),
		[walletKeys],
	);
	const [records, setRecords] = useState<SweepAuditRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<SweepAuditRecord | null>(null);

	useEffect(() => {
		if (!identityKey) return;
		let live = true;
		setRecords(null);
		setOpen(null);
		setError(null);
		store.list(identityKey).then(
			(list) => {
				if (live) setRecords(list);
			},
			(err: unknown) => {
				console.error("[sweep-audit] could not read sweep history", err);
				if (live) setError("Couldn't read sweep history in this browser.");
			},
		);
		return () => {
			live = false;
		};
	}, [identityKey, store]);

	if (isWalletLocked || !walletKeys) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-muted-foreground">
					Unlock your wallet to see its sweep history.
				</CardContent>
			</Card>
		);
	}
	if (!identityKey) {
		return (
			<Notice tone="danger">
				Couldn't read this wallet's identity key, so its sweep history can't be
				shown.
			</Notice>
		);
	}

	if (open) {
		return (
			<div className="mx-auto flex w-full max-w-xl flex-col gap-4 pb-24">
				<div>
					<Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
						<ArrowLeft data-icon="inline-start" />
						All runs
					</Button>
				</div>
				<SweepAuditView record={open} status={statusOf(open)} />
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-4 pb-24">
			<p className="text-muted-foreground text-sm">
				Every sweep this wallet ran in this browser. Open one to copy or
				download a report for wallet support.
			</p>
			{error ? (
				<Notice tone="danger">{error}</Notice>
			) : records === null ? (
				<p className="text-muted-foreground text-sm">Loading…</p>
			) : records.length === 0 ? (
				<Card>
					<CardContent className="py-8 text-center text-muted-foreground">
						No sweeps yet.
					</CardContent>
				</Card>
			) : (
				<SweepAuditList
					records={records}
					statusOf={statusOf}
					onOpen={setOpen}
				/>
			)}
		</div>
	);
}
