"use client";

import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import type { Bsv20StaysData } from "@/components/wallet/sweep/sweep-bsv20-stays";
import {
	type SweepAddress,
	SweepDetails,
} from "@/components/wallet/sweep/sweep-details";
import { SweepOrdinalSheet } from "@/components/wallet/sweep/sweep-ordinal-sheet";
import { SweepOutcome } from "@/components/wallet/sweep/sweep-outcome";
import { SweepRouteDiagram } from "@/components/wallet/sweep/sweep-route-diagram";
import { SweepFooterRow } from "@/components/wallet/sweep/sweep-shell";
import { SweepStepBsv } from "@/components/wallet/sweep/sweep-step-bsv";
import { SweepStepCollectibles } from "@/components/wallet/sweep/sweep-step-collectibles";
import { SweepStepLine } from "@/components/wallet/sweep/sweep-step-line";
import { SweepStepReview } from "@/components/wallet/sweep/sweep-step-review";
import { SweepStepStays } from "@/components/wallet/sweep/sweep-step-stays";
import { SweepStepTokens } from "@/components/wallet/sweep/sweep-step-tokens";
import { SweepWizard } from "@/components/wallet/sweep/sweep-wizard";
import type { SweepProgress, SweepResult } from "@/lib/sweep-migration";
import type { AssetType } from "@/lib/wallet/migration-listings";
import {
	bsv20StaysLine,
	buildWizardSteps,
	currentStepLine,
	reviewLines,
	type SweepOrdinal,
	type SweepScreen,
	type SweepSummary,
	shortError,
	staysCount,
	staysRows,
	summarizeOutcome,
	type WizardStepId,
} from "@/lib/wallet/sweep-summary";

const SCAN_ROWS = ["scan-1", "scan-2", "scan-3"] as const;

export interface FooterAction {
	label: string;
	onClick: () => void;
}

export interface MigrationSweepFlowProps {
	variant: "page" | "dialog";
	screen: SweepScreen;
	/** First run: the sweep also upgrades the wallet to its identity key. */
	firstRun: boolean;
	/** Legacy keys are present; without them only listings can be cancelled. */
	canSweep: boolean;

	scanDetail: string | null;
	scanError: string | null;
	onRetryScan: () => void;

	summary: SweepSummary;
	/** Unlisted ordinals, for the chooser. */
	ordinals: SweepOrdinal[];
	selectedOrdinals: ReadonlySet<string>;
	onToggleOrdinal: (outpoint: string) => void;
	onSelectAllOrdinals: () => void;
	onDeselectAllOrdinals: () => void;
	selectedTypes: ReadonlySet<AssetType>;
	onToggleType: (type: AssetType) => void;
	/** Everything the plan sends (plannedCount). */
	plannedTotal: number;
	onSweep: () => void;
	onCancelListingsOnly: () => void;
	/** First-run wizard only: put the upgrade off. */
	onLater?: () => void;

	progressMessage: string;
	progressPercent: number;
	sweepProgress: SweepProgress | null;

	sweepResult: SweepResult | null;
	/** What a finished rescan still finds at the old addresses. */
	remaining: number;
	doneLabel: (remaining: number) => string;
	onDone: () => void;
	doneSecondary?: FooterAction;

	error: string | null;
	onTryAgain: () => void;
	errorSecondary?: FooterAction;

	addresses: SweepAddress[];
	destination: string;
	bsv20: Bsv20StaysData;
	/** The choice step on screen, or null on scan, progress and done. */
	onStepChange?: (step: WizardStepId | null) => void;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The legacy sweep as a short wizard, shared by the migrate page and the
 * first-run dialog. Each host keeps its own state, scan gate and handlers
 * and passes plain data in; this decides only what is on screen.
 */
export function MigrationSweepFlow(props: MigrationSweepFlowProps) {
	const {
		variant,
		screen,
		firstRun,
		canSweep,
		summary,
		selectedTypes,
		onToggleType,
		onStepChange,
	} = props;
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [ordinalsOpen, setOrdinalsOpen] = useState(false);
	const [index, setIndex] = useState(0);
	const [direction, setDirection] = useState<"forward" | "back">("forward");

	const steps: WizardStepId[] = useMemo(
		() => (canSweep ? buildWizardSteps(summary) : ["stays"]),
		[canSweep, summary],
	);
	const stepIndex = Math.min(index, steps.length - 1);
	const step = steps[stepIndex];

	// A new pass through the choices starts at the first step.
	const lastScreen = useRef(screen);
	useEffect(() => {
		if (screen === "steps" && lastScreen.current !== "steps") {
			setIndex(0);
			setDirection("forward");
		}
		lastScreen.current = screen;
	}, [screen]);

	useEffect(() => {
		onStepChange?.(screen === "steps" ? step : null);
	}, [onStepChange, screen, step]);

	const go = (to: number) => {
		setDirection(to < stepIndex ? "back" : "forward");
		setIndex(Math.max(0, Math.min(to, steps.length - 1)));
	};
	const setType = (type: AssetType, on: boolean) => {
		if (selectedTypes.has(type) !== on) onToggleType(type);
	};

	const selectedOrdinalCount = props.ordinals.filter((o) =>
		props.selectedOrdinals.has(o.outpoint),
	).length;
	const rows = staysRows(summary);
	const bsv20Line = bsv20StaysLine(summary.bsv20Unconfirmed.length);
	const otherStays = staysCount(summary) - summary.bsv20Unconfirmed.length;
	const stayNotes = [
		otherStays > 0
			? `${plural(otherStays, "other item")} ${otherStays === 1 ? "stays where it is" : "stay where they are"}`
			: null,
		bsv20Line,
	].filter((line): line is string => line !== null);
	const cancelListingsOnlyLabel = `Cancel listings only (${summary.listings})`;

	const details = (
		<SweepDetails
			open={detailsOpen}
			onOpenChange={setDetailsOpen}
			addresses={props.addresses}
			destination={props.destination}
			result={props.sweepResult}
			stays={rows.filter((r) => r.kind !== "listings")}
			bsv20Groups={props.bsv20.groups}
			errors={[props.error, props.scanError].filter((e): e is string => !!e)}
		/>
	);
	const openDetails = () => setDetailsOpen(true);
	const wizard = (
		frame: Omit<
			Parameters<typeof SweepWizard>[0],
			"variant" | "onInfo" | "children"
		>,
		body: ReactNode,
	) => (
		<>
			<SweepWizard variant={variant} onInfo={openDetails} {...frame}>
				{body}
			</SweepWizard>
			{details}
			<SweepOrdinalSheet
				open={ordinalsOpen}
				onOpenChange={setOrdinalsOpen}
				ordinals={props.ordinals}
				selected={props.selectedOrdinals}
				onToggle={props.onToggleOrdinal}
				onSelectAll={props.onSelectAllOrdinals}
				onDeselectAll={props.onDeselectAllOrdinals}
			/>
		</>
	);

	// -- Scan ----------------------------------------------------------------
	if (screen === "scan") {
		if (props.scanError) {
			return wizard(
				{
					stepKey: "scan-error",
					title: "Couldn't check your old addresses",
					onEnter: props.onRetryScan,
					footer: (
						<Button className="w-full" onClick={props.onRetryScan}>
							<RefreshCw data-icon="inline-start" />
							Retry scan
						</Button>
					),
				},
				<Notice tone="danger">{shortError(props.scanError)}</Notice>,
			);
		}
		return wizard(
			{
				stepKey: "scan",
				title: "Checking your old addresses",
				description: (
					<span className="motion-safe:animate-pulse">
						{props.scanDetail ??
							"Looking for BSV, ordinals and tokens at your old 1Sat addresses."}
					</span>
				),
				footer: (
					<Button className="w-full" disabled>
						<Loader2
							className="motion-safe:animate-spin"
							data-icon="inline-start"
						/>
						Scanning…
					</Button>
				),
			},
			<div className="flex flex-col gap-2" aria-hidden="true">
				{SCAN_ROWS.map((key) => (
					<Skeleton key={key} className="h-14 w-full rounded-xl" />
				))}
			</div>,
		);
	}

	// -- Progress ------------------------------------------------------------
	if (screen === "progress") {
		return wizard(
			{
				stepKey: "progress",
				title: "Moving your assets",
				description: "Keep this page open.",
				footer: (
					<Button className="w-full" disabled>
						<Loader2
							className="motion-safe:animate-spin"
							data-icon="inline-start"
						/>
						Sweeping…
					</Button>
				),
			},
			<>
				<SweepRouteDiagram state="moving" />
				<SweepStepLine
					line={currentStepLine(props.sweepProgress, props.progressMessage)}
					percent={props.progressPercent}
				/>
			</>,
		);
	}

	// -- Done and error ------------------------------------------------------
	if (screen === "done" || screen === "error") {
		const outcome = summarizeOutcome(
			props.sweepResult,
			props.remaining,
			props.sweepProgress?.steps,
		);
		const stayLines = [
			...rows
				.filter((r) => r.kind !== "listings" && r.kind !== "bsv20")
				.map((r) => r.label),
			...(bsv20Line ? [bsv20Line] : []),
		];
		if (screen === "error") {
			const secondary = props.errorSecondary ?? {
				label: "Details",
				onClick: openDetails,
			};
			return wizard(
				{
					stepKey: "error",
					title: "The sweep didn't finish",
					description:
						"Anything already moved is safe in this wallet. You can try again.",
					onEnter: props.onTryAgain,
					footer: (
						<SweepFooterRow>
							<Button
								variant="outline"
								className="flex-1"
								onClick={secondary.onClick}
							>
								{secondary.label}
							</Button>
							<Button className="flex-1" onClick={props.onTryAgain}>
								Try again
							</Button>
						</SweepFooterRow>
					),
				},
				<>
					<Notice tone="danger">
						{shortError(props.error ?? "")}{" "}
						<button
							type="button"
							className="underline underline-offset-4"
							onClick={openDetails}
						>
							Details
						</button>
					</Notice>
					{props.sweepResult && outcome.rows.length > 0 && (
						<SweepOutcome outcome={{ ...outcome, notes: [], remaining: 0 }} />
					)}
				</>,
			);
		}
		const description =
			outcome.kind === "all-moved"
				? "Everything is in this wallet now."
				: outcome.kind === "nothing"
					? stayLines.length > 0
						? "Nothing can be moved right now. These stay where they are, and they're still yours."
						: "A fresh scan found nothing at your old addresses."
					: undefined;
		return wizard(
			{
				stepKey: "done",
				title: outcome.headline,
				description,
				onEnter: props.onDone,
				footer: (
					<SweepFooterRow stack>
						{props.doneSecondary && (
							<Button variant="outline" onClick={props.doneSecondary.onClick}>
								{props.doneSecondary.label}
							</Button>
						)}
						<Button onClick={props.onDone}>
							{props.doneLabel(props.remaining)}
						</Button>
					</SweepFooterRow>
				),
			},
			<SweepOutcome outcome={outcome} stayLines={stayLines} />,
		);
	}

	// -- Choice steps --------------------------------------------------------
	const isLast = stepIndex === steps.length - 1;
	const next = () => go(stepIndex + 1);
	const back = () => go(stepIndex - 1);
	const sweepDisabled = !firstRun && props.plannedTotal === 0;
	const sweepLabel = firstRun
		? props.plannedTotal > 0
			? "Upgrade wallet & sweep"
			: "Upgrade wallet"
		: `Sweep ${plural(props.plannedTotal, "item")}`;

	let primary: ReactNode;
	let onEnter: (() => void) | undefined;
	if (!canSweep) {
		primary = (
			<Button className="flex-1" onClick={props.onCancelListingsOnly}>
				{cancelListingsOnlyLabel}
			</Button>
		);
		onEnter = props.onCancelListingsOnly;
	} else if (isLast) {
		primary = (
			<Button
				className="flex-1"
				onClick={props.onSweep}
				disabled={sweepDisabled}
			>
				{sweepLabel}
			</Button>
		);
		onEnter = sweepDisabled ? undefined : props.onSweep;
	} else {
		primary = (
			<Button className="flex-1" onClick={next}>
				Next
			</Button>
		);
		onEnter = next;
	}
	const footer = (
		<>
			<SweepFooterRow>
				{stepIndex > 0 && (
					<Button variant="outline" onClick={back}>
						<ArrowLeft data-icon="inline-start" />
						Back
					</Button>
				)}
				{primary}
			</SweepFooterRow>
			{props.onLater && (stepIndex === 0 || isLast) && (
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
					onClick={props.onLater}
				>
					Migrate later
				</Button>
			)}
		</>
	);

	const indicator =
		steps.length > 1 ? { index: stepIndex, total: steps.length } : undefined;
	const frame = { stepKey: step, direction, indicator, onEnter, footer };

	switch (step) {
		case "bsv":
			return wizard(
				{
					...frame,
					title: "Move your BSV",
					description: summary.bsv
						? `${summary.bsv.bsv} BSV moves from your old 1Sat addresses into this wallet.`
						: undefined,
				},
				summary.bsv && (
					<SweepStepBsv
						bsv={summary.bsv}
						included={selectedTypes.has("bsv")}
						onIncludedChange={(on) => setType("bsv", on)}
					/>
				),
			);
		case "collectibles": {
			const parts = [
				summary.ordinals.count > 0
					? plural(summary.ordinals.count, "ordinal")
					: null,
				summary.names.count > 0 ? plural(summary.names.count, "name") : null,
			].filter(Boolean);
			return wizard(
				{
					...frame,
					title: "Move your ordinals",
					description: `${parts.join(" and ")}, all selected.`,
				},
				<SweepStepCollectibles
					ordinals={summary.ordinals}
					names={summary.names}
					selectedCount={selectedOrdinalCount}
					included={selectedTypes.has("ordinals")}
					onIncludedChange={(on) => setType("ordinals", on)}
					onReview={() => setOrdinalsOpen(true)}
				/>,
			);
		}
		case "tokens": {
			const n = summary.tokens.length;
			return wizard(
				{
					...frame,
					title: "Move your tokens",
					description: `${plural(n, "token")} ${n === 1 ? "moves with its" : "move with their"} full balance.`,
				},
				<SweepStepTokens
					tokens={summary.tokens}
					includeBsv21={selectedTypes.has("bsv21")}
					includeBsv20={selectedTypes.has("bsv20")}
					onToggle={(kind, on) => setType(kind, on)}
				/>,
			);
		}
		case "stays": {
			const onlyListings = rows.every((r) => r.kind === "listings");
			return wizard(
				{
					...frame,
					title: onlyListings ? "Open listings" : "Some items stay put",
					description: onlyListings
						? "These listings are being retired. Cancelling returns each ordinal to your wallet."
						: "Still yours, at your old address. This wallet keeps the keys.",
				},
				<SweepStepStays
					rows={rows}
					bsv20={props.bsv20}
					listingsIncluded={selectedTypes.has("listings")}
					onListingsIncludedChange={
						canSweep ? (on) => setType("listings", on) : undefined
					}
					onCancelListingsOnly={
						canSweep ? props.onCancelListingsOnly : undefined
					}
					cancelListingsOnlyLabel={cancelListingsOnlyLabel}
				/>,
			);
		}
		default:
			return wizard(
				{
					...frame,
					title: "Ready to sweep",
					description:
						props.plannedTotal > 0
							? "This moves everything below into this wallet."
							: firstRun
								? "Nothing to move. Upgrading still sets up your wallet's identity key."
								: "Nothing is selected. Go back to include something.",
				},
				<SweepStepReview
					lines={reviewLines(summary, selectedTypes, selectedOrdinalCount)}
					itemCount={props.plannedTotal}
					notes={stayNotes}
					onJump={(target) => {
						const to = steps.indexOf(target);
						if (to >= 0) go(to);
					}}
				/>,
			);
	}
}
