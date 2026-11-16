"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, LockOpen, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { SectionHeader } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	SoundDialog,
} from "@/components/ui/sound-dialog";
import { useSound } from "@/hooks/use-sound";
import { PRIVACY_MODE_KEY } from "@/lib/constants";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	approximateBlockDuration,
	BLOCKS_PER_DAY,
	executeLock,
	executeUnlock,
	type LockedCoin,
	type LockHeightMode,
	listLockedCoins,
	lockActionFailureMessage,
	lockRequestProblem,
	resolveLockUntil,
} from "@/lib/wallet/lock-actions";
import { useSettingsStorage } from "@/lib/wallet-storage";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { formatSatoshisAsBsv, parseBsvAmount } from "./wallet-home-utils";

interface ReviewedLock {
	satoshis: number;
	until: number;
	currentHeight: number;
}

type LockState =
	| { status: "idle" }
	| ({ status: "review" | "locking" } & ReviewedLock)
	| { status: "success"; txid: string; satoshis: number; until: number }
	| { status: "error"; message: string };

function errorCode(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function reportLockFailure(operation: string, cause: unknown) {
	// reportDiagnostic keeps only a sanitised code; keep the full error in the log.
	console.error(`[${operation}]`, cause);
	reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation,
		recoverable: true,
		context: { status: errorCode(cause), retryable: true },
	});
}

function LockDialog({
	currentHeight,
	onLocked,
}: {
	currentHeight: number | null;
	onLocked: () => Promise<void>;
}) {
	const { balance, oneSatContext } = useWalletToolbox();
	const { play } = useSound();
	const inFlightRef = useRef(false);
	const [open, setOpen] = useState(false);
	const [amount, setAmount] = useState("");
	const [mode, setMode] = useState<LockHeightMode>("blocks");
	const [heightValue, setHeightValue] = useState(String(BLOCKS_PER_DAY));
	const [state, setState] = useState<LockState>({ status: "idle" });
	const services = oneSatContext?.services;

	const review = async () => {
		if (!services) return;
		try {
			const height = await services.chaintracks.currentHeight();
			const satoshis = parseBsvAmount(amount);
			const until = resolveLockUntil(mode, heightValue, height);
			const problem = lockRequestProblem({
				satoshis,
				until,
				currentHeight: height,
				spendable: balance?.total ?? null,
			});
			if (problem || satoshis === null || until === null) {
				setState({
					status: "error",
					message: problem ?? "Check the amount and unlock block.",
				});
				return;
			}
			setState({ status: "review", satoshis, until, currentHeight: height });
		} catch (cause) {
			reportLockFailure("wallet.locks.height", cause);
			setState({
				status: "error",
				message: "The current block height could not be read. Try again.",
			});
		}
	};

	const confirm = async () => {
		if (!oneSatContext || inFlightRef.current || state.status !== "review") {
			return;
		}
		const reviewed = state;
		inFlightRef.current = true;
		setState({ ...reviewed, status: "locking" });
		try {
			const height =
				(await oneSatContext.services?.chaintracks.currentHeight()) ??
				reviewed.currentHeight;
			if (reviewed.until <= height) {
				setState({
					status: "error",
					message: `Block ${reviewed.until} has been reached. Review the lock again.`,
				});
				return;
			}
			const txid = await executeLock(oneSatContext, {
				satoshis: reviewed.satoshis,
				until: reviewed.until,
				currentHeight: height,
			});
			setState({
				status: "success",
				txid,
				satoshis: reviewed.satoshis,
				until: reviewed.until,
			});
			play("success");
			inFlightRef.current = false;
			void onLocked();
		} catch (cause) {
			reportLockFailure("wallet.locks.lock", cause);
			setState({ status: "error", message: lockActionFailureMessage(cause) });
			play("error");
		} finally {
			inFlightRef.current = false;
		}
	};

	const reviewing = state.status === "review" || state.status === "locking";

	const close = () => {
		if (inFlightRef.current) return;
		setOpen(false);
		if (state.status === "success") setAmount("");
		setState({ status: "idle" });
	};

	return (
		<SoundDialog
			open={open}
			onOpenChange={(next) => (next ? setOpen(true) : close())}
		>
			<DialogTrigger asChild>
				<Button disabled={!services} size="sm" variant="outline">
					<Lock data-icon="inline-start" /> Lock BSV
				</Button>
			</DialogTrigger>
			<DialogContent showCloseButton={state.status !== "locking"}>
				<DialogHeader>
					<DialogTitle>
						{state.status === "success" ? "BSV locked" : "Lock BSV"}
					</DialogTitle>
					<DialogDescription>
						{state.status === "success"
							? `It unlocks at block ${state.until.toLocaleString("en-US")}.`
							: "Locked coins stay in your wallet but can't be spent until the unlock block."}
					</DialogDescription>
				</DialogHeader>
				{state.status === "success" ? (
					<>
						<p className="font-mono font-semibold text-2xl" role="status">
							{formatSatoshisAsBsv(state.satoshis)} BSV
						</p>
						<details className="text-muted-foreground text-sm">
							<summary className="flex min-h-11 cursor-pointer items-center md:min-h-9">
								Transaction details
							</summary>
							<p className="mt-2 font-mono text-xs wrap-anywhere">
								{state.txid}
							</p>
						</details>
						<DialogFooter>
							<Button onClick={close}>Done</Button>
						</DialogFooter>
					</>
				) : reviewing ? (
					<>
						<DetailList>
							<DetailRow label="Amount">
								{formatSatoshisAsBsv(state.satoshis)} BSV
							</DetailRow>
							<DetailRow label="Unlocks at block">
								{state.until.toLocaleString("en-US")}
							</DetailRow>
							<DetailRow label="Locked for" mono={false}>
								{(state.until - state.currentHeight).toLocaleString("en-US")}{" "}
								blocks,{" "}
								{approximateBlockDuration(state.until - state.currentHeight)}
							</DetailRow>
							<DetailRow label="Network fee" mono={false}>
								Paid on top of the amount
							</DetailRow>
						</DetailList>
						<Notice tone="warning">
							You can't spend these coins or cancel the lock before block{" "}
							{state.until.toLocaleString("en-US")}.
						</Notice>
						<DialogFooter>
							<Button
								disabled={state.status === "locking"}
								onClick={() => setState({ status: "idle" })}
								variant="outline"
							>
								Back
							</Button>
							<Button
								disabled={state.status === "locking"}
								onClick={() => void confirm()}
							>
								{state.status === "locking" && (
									<Loader2 className="animate-spin" data-icon="inline-start" />
								)}
								{state.status === "locking" ? "Locking…" : "Confirm and lock"}
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<div className="flex flex-col gap-2">
							<Label htmlFor="wallet-lock-amount">Amount (BSV)</Label>
							<Input
								id="wallet-lock-amount"
								inputMode="decimal"
								onChange={(event) => setAmount(event.target.value)}
								placeholder="0.00000000"
								value={amount}
							/>
						</div>
						<fieldset className="flex flex-col gap-2">
							<legend className="mb-2 font-medium text-sm">Unlock</legend>
							<div className="grid grid-cols-2 gap-2">
								{(
									[
										["blocks", "After blocks"],
										["height", "At block height"],
									] as const
								).map(([value, label]) => (
									<Button
										aria-pressed={mode === value}
										key={value}
										onClick={() => {
											setMode(value);
											setHeightValue(
												value === "blocks"
													? String(BLOCKS_PER_DAY)
													: currentHeight
														? String(currentHeight + BLOCKS_PER_DAY)
														: "",
											);
										}}
										size="sm"
										type="button"
										variant={mode === value ? "default" : "outline"}
									>
										{label}
									</Button>
								))}
							</div>
							<Input
								aria-label={
									mode === "blocks" ? "Blocks from now" : "Unlock block height"
								}
								inputMode="numeric"
								onChange={(event) => setHeightValue(event.target.value)}
								value={heightValue}
							/>
							<p className="text-muted-foreground text-xs">
								{currentHeight
									? `Current block ${currentHeight.toLocaleString("en-US")}. `
									: ""}
								{BLOCKS_PER_DAY} blocks is about one day.
							</p>
						</fieldset>
						{state.status === "error" && (
							<Notice tone="danger">{state.message}</Notice>
						)}
						<DialogFooter>
							<Button
								disabled={!amount.trim() || !heightValue.trim()}
								onClick={() => void review()}
							>
								Review lock
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</SoundDialog>
	);
}

export function WalletLocks() {
	const { chain, identityKey, oneSatContext, refreshBalance } =
		useWalletToolbox();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const [privacyMode] = useSettingsStorage<boolean>(PRIVACY_MODE_KEY, false);
	const [unlocking, setUnlocking] = useState<string | null>(null);
	const [unlockError, setUnlockError] = useState<string | null>(null);
	const [unlockTxid, setUnlockTxid] = useState<string | null>(null);
	const services = oneSatContext?.services;

	const locksQuery = useQuery({
		queryKey: ["wallet-locks", chain, identityKey],
		queryFn: async () => {
			if (!oneSatContext?.services) throw new Error("services-required");
			try {
				const currentHeight =
					await oneSatContext.services.chaintracks.currentHeight();
				const coins = await listLockedCoins(oneSatContext, currentHeight);
				return { currentHeight, coins };
			} catch (cause) {
				reportLockFailure("wallet.locks.list", cause);
				throw cause;
			}
		},
		enabled: Boolean(services && identityKey),
		staleTime: 60_000,
		// Re-reads the block height too, so "blocks left" and Spendable stay current.
		refetchInterval: 60_000,
	});

	const clearUnlockResult = () => {
		setUnlockError(null);
		setUnlockTxid(null);
	};

	const refresh = async () => {
		refreshBalance();
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["wallet-locks"] }),
			queryClient.invalidateQueries({ queryKey: ["wallet-actions"] }),
		]);
	};

	const unlock = async (key: string, coins: LockedCoin[]) => {
		if (!oneSatContext || unlocking) return;
		setUnlocking(key);
		clearUnlockResult();
		try {
			setUnlockTxid(await executeUnlock(oneSatContext, coins));
			play("success");
			await refresh();
		} catch (cause) {
			reportLockFailure("wallet.locks.unlock", cause);
			setUnlockError(lockActionFailureMessage(cause));
			play("error");
		} finally {
			setUnlocking(null);
		}
	};

	const coins = locksQuery.data?.coins ?? [];
	const ready = coins.filter((coin) => coin.spendable && coin.id);
	const total = coins.reduce((sum, coin) => sum + coin.satoshis, 0);
	const amount = (satoshis: number) =>
		privacyMode ? "••••••••" : `${formatSatoshisAsBsv(satoshis)} BSV`;

	return (
		<section
			aria-labelledby="wallet-locks-heading"
			className="flex flex-col gap-4 border-border border-t pt-6"
		>
			<SectionHeader
				action={
					<>
						<Button
							aria-label="Refresh locks"
							disabled={!services || locksQuery.isFetching}
							onClick={() => {
								clearUnlockResult();
								void locksQuery.refetch();
							}}
							size="icon"
							variant="ghost"
						>
							<RefreshCw
								className={
									locksQuery.isFetching ? "motion-safe:animate-spin" : ""
								}
							/>
						</Button>
						<LockDialog
							currentHeight={locksQuery.data?.currentHeight ?? null}
							onLocked={async () => {
								clearUnlockResult();
								await refresh();
							}}
						/>
					</>
				}
				description={
					locksQuery.data
						? `${amount(total)} locked in ${coins.length} coin${coins.length === 1 ? "" : "s"} · block ${locksQuery.data.currentHeight.toLocaleString("en-US")}`
						: "BSV time-locked until a block height."
				}
				title={<span id="wallet-locks-heading">Locks</span>}
			/>

			{!services ? (
				<p className="text-muted-foreground text-sm">
					Locks aren't available for this wallet connection.
				</p>
			) : locksQuery.isPending ? (
				<div role="status">
					<span className="sr-only">Loading locks…</span>
					<ul aria-hidden="true" className="divide-y divide-border">
						{[0, 1].map((row) => (
							<li
								className="flex min-h-14 items-center justify-between py-3"
								key={row}
							>
								<div className="flex flex-col gap-2">
									<Skeleton className="h-4 w-32" />
									<Skeleton className="h-3 w-24" />
								</div>
								<Skeleton className="h-3 w-28" />
							</li>
						))}
					</ul>
				</div>
			) : locksQuery.isError ? (
				<Notice tone="danger">Locks could not be loaded. Try again.</Notice>
			) : coins.length === 0 ? (
				<p className="text-muted-foreground text-sm">No locked coins.</p>
			) : (
				<>
					{ready.length > 1 && (
						<div className="flex items-center justify-between gap-3">
							<p className="text-muted-foreground text-sm">
								{ready.length} locks are ready to unlock.
							</p>
							<Button
								disabled={unlocking !== null}
								onClick={() => void unlock("all", ready)}
								size="sm"
								variant="outline"
							>
								{unlocking === "all" ? (
									<Loader2 className="animate-spin" data-icon="inline-start" />
								) : (
									<LockOpen data-icon="inline-start" />
								)}
								Unlock all ({ready.length})
							</Button>
						</div>
					)}
					<ul className="divide-y divide-border">
						{coins.map((coin) => {
							const blocksLeft = coin.until - locksQuery.data.currentHeight;
							return (
								<li
									className="flex min-h-14 items-center justify-between gap-3 py-3"
									key={coin.outpoint}
								>
									<div className="flex min-w-0 flex-col gap-1">
										<p className="font-mono text-sm">{amount(coin.satoshis)}</p>
										<p className="text-muted-foreground text-xs">
											Unlock block {coin.until.toLocaleString("en-US")}
										</p>
										{coin.spendable && !coin.id && (
											<p className="text-muted-foreground text-xs">
												Can't unlock here: no wallet tracking record.
											</p>
										)}
									</div>
									{coin.spendable ? (
										<div className="flex shrink-0 items-center gap-3">
											<span className="font-medium text-success text-xs">
												Spendable
											</span>
											<Button
												disabled={unlocking !== null || !coin.id}
												onClick={() => void unlock(coin.outpoint, [coin])}
												size="sm"
											>
												{unlocking === coin.outpoint ? (
													<Loader2
														className="animate-spin"
														data-icon="inline-start"
													/>
												) : (
													<LockOpen data-icon="inline-start" />
												)}
												Unlock
											</Button>
										</div>
									) : (
										<span className="shrink-0 text-right text-warning text-xs">
											{blocksLeft.toLocaleString("en-US")} block
											{blocksLeft === 1 ? "" : "s"} left,{" "}
											{approximateBlockDuration(blocksLeft)}
										</span>
									)}
								</li>
							);
						})}
					</ul>
				</>
			)}
			{unlockError && <Notice tone="danger">{unlockError}</Notice>}
			{unlockTxid && (
				<p
					className="text-muted-foreground text-xs wrap-anywhere"
					role="status"
				>
					Unlocked. Transaction <span className="font-mono">{unlockTxid}</span>
				</p>
			)}
		</section>
	);
}
