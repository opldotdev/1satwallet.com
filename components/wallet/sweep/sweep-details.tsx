"use client";

import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import type { SweepResult } from "@/lib/sweep-migration";
import { cn } from "@/lib/utils";
import type { Bsv20Group } from "@/lib/wallet/bsv20-content";
import {
	BSV20_STAYS_DETAIL,
	formatTokenAmount,
	type StayRow,
} from "@/lib/wallet/sweep-summary";
import { unreadableReasonsLine } from "./sweep-bsv20-stays";
import { SWEEP_SHEET_LAYER } from "./sweep-layers";

/** A claimed amount as written, digits grouped; never verified or summed. */
const formatClaimed = (amt: string) => {
	const [int, frac] = amt.split(".");
	return `${formatTokenAmount(int, 0)}${frac ? `.${frac}` : ""}`;
};

export interface SweepAddress {
	label: string;
	address: string;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={failed ? `Couldn't copy ${label}` : `Copy ${label}`}
			title={failed ? "Couldn't copy" : "Copy"}
			onClick={() => {
				navigator.clipboard.writeText(value).then(
					() => {
						setFailed(false);
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1500);
					},
					(error: unknown) => {
						console.error("[sweep] copy failed", error);
						setFailed(true);
					},
				);
			}}
		>
			{copied ? (
				<Check aria-hidden="true" className="text-success" />
			) : (
				<Copy aria-hidden="true" />
			)}
		</Button>
	);
}

/** A mono value with a copy control, wrapping anywhere at 375px. */
function CopyValue({ value, label }: { value: string; label: string }) {
	return (
		<span className="flex min-w-0 items-center gap-1">
			<span className="min-w-0 flex-1 wrap-anywhere text-xs">{value}</span>
			<CopyButton value={value} label={label} />
		</span>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{title}
			</h3>
			{children}
		</section>
	);
}

const TX_GROUPS: [keyof SweepResult, string][] = [
	["transferTxids", "Moved to identity key"],
	["cancelTxids", "Listing cancelled"],
	["bsvTxids", "BSV"],
	["ordinalTxids", "Ordinals"],
	["bsv21Txids", "Tokens"],
	["bsv20Txids", "BSV-20 tokens"],
];

function resultTxids(result: SweepResult): { label: string; txid: string }[] {
	return TX_GROUPS.flatMap(([key, label]) => {
		const txids = result[key];
		return Array.isArray(txids)
			? txids.map((txid) => ({ label, txid: String(txid) }))
			: [];
	});
}

/**
 * Everything the main sweep screens leave out: the old addresses, where
 * things go, how it works, every transaction id, what stays behind and the
 * full text of every error. A bottom sheet on phones, a side sheet above.
 */
export function SweepDetails({
	open,
	onOpenChange,
	addresses,
	destination,
	result,
	stays = [],
	bsv20Groups = [],
	errors = [],
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	addresses: SweepAddress[];
	/** Where assets go, in words or as an address. */
	destination: string;
	result?: SweepResult | null;
	/** What stays at the old addresses, with outpoints. */
	stays?: StayRow[];
	/** BSV-20 inscriptions read so far, with what each claims. */
	bsv20Groups?: Bsv20Group[];
	/** Raw error strings, shown in full. */
	errors?: string[];
}) {
	const isMobile = useIsMobile();
	const txs = result ? resultTxids(result) : [];
	const allErrors = [...new Set([...(result?.errors ?? []), ...errors])];

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={isMobile ? "bottom" : "right"}
				overlayClassName={SWEEP_SHEET_LAYER}
				className={cn(
					SWEEP_SHEET_LAYER,
					isMobile ? "max-h-[85dvh] rounded-t-xl" : "w-full sm:max-w-md",
				)}
			>
				<SheetHeader className="pr-12">
					<SheetTitle>How the sweep works</SheetTitle>
					<SheetDescription>
						Your old 1Sat wallet kept coins and collectibles at separate
						addresses. A sweep signs with those old keys and moves everything
						into this wallet.
					</SheetDescription>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
					<Section title="Addresses">
						<DetailList>
							{addresses.map((a) => (
								<DetailRow key={a.label} label={a.label} stack>
									<CopyValue value={a.address} label={a.label} />
								</DetailRow>
							))}
							<DetailRow label="Destination" mono={false} stack>
								{destination}
							</DetailRow>
						</DetailList>
					</Section>

					<Section title="Under the hood">
						<p className="text-muted-foreground text-sm">
							This wallet is a BRC-100 wallet rooted in an identity key derived
							from your old pay and ordinals keys; the first sweep sets that up
							and re-encrypts your backup. Plain BSV moves as P2PKH coins,
							ordinals and OpNS names as 1Sat ordinals, and BSV-21 tokens after
							the token overlay validates them. Open OrdLock listings are
							cancelled first. Each kind moves in its own batched transactions,
							so one failure doesn't stop the rest.
						</p>
					</Section>

					{txs.length > 0 && (
						<Section title={`Transactions (${txs.length})`}>
							<DetailList>
								{txs.map((tx) => (
									<DetailRow
										key={`${tx.label}:${tx.txid}`}
										label={tx.label}
										stack
									>
										<CopyValue value={tx.txid} label={`${tx.label} txid`} />
									</DetailRow>
								))}
							</DetailList>
						</Section>
					)}

					{stays.length > 0 && (
						<Section title="Staying behind">
							{stays.map((row) => (
								<div key={row.key} className="flex flex-col gap-2">
									<p className="font-medium text-sm">
										{row.kind === "bsv20"
											? `BSV-20 inscriptions (${row.count})`
											: row.label}
									</p>
									<p className="text-muted-foreground text-xs">
										{row.kind === "bsv20" ? BSV20_STAYS_DETAIL : row.detail}
									</p>
									{row.kind === "bsv20" && bsv20Groups.length > 0 ? (
										<ul className="flex max-h-60 flex-col gap-2 overflow-y-auto rounded-md bg-muted/50 p-2">
											{bsv20Groups.map((group) => (
												<li key={group.tick} className="flex flex-col gap-1">
													<p className="text-xs">
														{group.tick} · {group.outputs}{" "}
														{group.outputs === 1 ? "output" : "outputs"}
													</p>
													{group.reasons && group.reasons.length > 0 && (
														<p className="text-muted-foreground text-xs">
															{unreadableReasonsLine(group.reasons)}
														</p>
													)}
													{group.entries.map((entry) => (
														<p
															key={entry.outpoint}
															className="wrap-anywhere font-mono text-[11px] text-muted-foreground"
														>
															{entry.outpoint}
															{entry.amt
																? ` · ${entry.op || "inscription"}, claimed ${formatClaimed(entry.amt)}`
																: ""}
														</p>
													))}
												</li>
											))}
										</ul>
									) : (
										row.outpoints.length > 0 && (
											<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md bg-muted/50 p-2">
												{row.outpoints.map((outpoint) => (
													<li
														key={outpoint}
														className="wrap-anywhere font-mono text-[11px] text-muted-foreground"
													>
														{outpoint}
													</li>
												))}
											</ul>
										)
									)}
								</div>
							))}
						</Section>
					)}

					{allErrors.length > 0 && (
						<Section title={`Errors (${allErrors.length})`}>
							<ul className="flex flex-col gap-2">
								{allErrors.map((error) => (
									<li
										key={error}
										className="wrap-anywhere rounded-md bg-destructive/10 p-2 font-mono text-[11px] text-destructive"
									>
										{error}
									</li>
								))}
							</ul>
						</Section>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
