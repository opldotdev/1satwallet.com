"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import {
	type ChangeEvent,
	useCallback,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useSound } from "@/hooks/use-sound";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	formatOneColorAmount,
	ONE_COLOR_MAX_ICON_BYTES,
	ONE_COLOR_MAX_SYMBOL_LENGTH,
	type OneColorDeployInput,
	type OneColorIcon,
	oneColorDeployFailureMessage,
	oneColorDeployInputError,
	oneColorSupplyError,
	parseOneColorAmount,
	runOneColorDeploy,
} from "@/lib/wallet/one-color-actions";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

type SupplyKind = "fixed" | "authority";

type SelectedIcon = OneColorIcon & { name: string; bytes: Uint8Array };

const noSubscription = () => () => {};

const formatBytes = (bytes: number): string =>
	bytes < 1_000 ? `${bytes} B` : `${(bytes / 1_000).toFixed(1)} KB`;

function logDeployFailure(operation: string, cause: unknown) {
	console.error(`[1color] ${operation} failed:`, cause);
	reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.1color.${operation}`,
		recoverable: true,
		context: { retryable: true },
	});
}

/** Deploy a 1Color token. Testnet only; writes through `colorContext`. */
export function OneColorDeploy() {
	const queryClient = useQueryClient();
	const { play } = useSound();
	const { chain, colorContext, refreshBalance } = useWalletToolbox();
	const mounted = useSyncExternalStore(
		noSubscription,
		() => true,
		() => false,
	);
	const [open, setOpen] = useState(false);
	const [supplyKind, setSupplyKind] = useState<SupplyKind>("fixed");
	const [symbol, setSymbol] = useState("");
	const [amount, setAmount] = useState("");
	const [decimalsText, setDecimalsText] = useState("0");
	const [icon, setIcon] = useState<SelectedIcon | null>(null);
	const [review, setReview] = useState<OneColorDeployInput | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [createdAssetId, setCreatedAssetId] = useState<string | null>(null);

	const chooseIcon = useCallback(
		async (event: ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			event.target.value = "";
			setError(null);
			if (!file) return;
			if (file.size > ONE_COLOR_MAX_ICON_BYTES) {
				setError(
					`The icon is ${formatBytes(file.size)}. Use one of at most ${ONE_COLOR_MAX_ICON_BYTES / 1_000} KB.`,
				);
				return;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const selected = { name: file.name, mediaType: file.type, bytes };
				const invalid = oneColorDeployInputError({
					amount: 0n,
					decimals: 0,
					icon: selected,
				});
				if (invalid) {
					setError(oneColorDeployFailureMessage(invalid));
					return;
				}
				setIcon(selected);
			} catch (cause) {
				logDeployFailure("icon-read", cause);
				setError("The icon file could not be read. Choose it again.");
			}
		},
		[],
	);

	const prepareReview = useCallback(() => {
		setError(null);
		const decimals = /^\d+$/.test(decimalsText.trim())
			? Number.parseInt(decimalsText.trim(), 10)
			: Number.NaN;
		const trimmedSymbol = symbol.trim();
		let atomic = 0n;
		if (supplyKind === "fixed") {
			const parsed = parseOneColorAmount(amount, decimals);
			if (parsed === null) {
				setError(oneColorSupplyError(amount, decimals));
				return;
			}
			atomic = parsed;
		}
		const input: OneColorDeployInput = {
			amount: atomic,
			decimals,
			...(trimmedSymbol ? { symbol: trimmedSymbol } : {}),
			...(icon ? { icon } : {}),
		};
		const invalid = oneColorDeployInputError(input);
		if (invalid) {
			setError(oneColorDeployFailureMessage(invalid));
			return;
		}
		setReview(input);
	}, [amount, decimalsText, icon, supplyKind, symbol]);

	const resetForm = useCallback(() => {
		setSupplyKind("fixed");
		setSymbol("");
		setAmount("");
		setDecimalsText("0");
		setIcon(null);
		setReview(null);
		setError(null);
	}, []);

	const changeOpen = useCallback(
		(next: boolean) => {
			if (busy) return;
			setOpen(next);
			if (!next) resetForm();
		},
		[busy, resetForm],
	);

	const deploy = useCallback(async () => {
		if (!(colorContext && review)) return;
		setBusy(true);
		setError(null);
		// Holdings are re-read before `busy` clears, so Authorize stays disabled
		// until the wallet's own read shows whether a deploy landed.
		const outcome = await runOneColorDeploy(colorContext, review, {
			log: logDeployFailure,
			refresh: async () => {
				refreshBalance();
				await queryClient.invalidateQueries({ queryKey: ["one-color"] });
			},
		});
		if (outcome.ok) {
			setCreatedAssetId(outcome.assetId);
			setOpen(false);
			resetForm();
			play("success");
		} else {
			// A failure after signing may have deployed: never leave Authorize
			// one tap away from a second deploy.
			if (outcome.mayHaveBeenSent) setReview(null);
			setError(outcome.message);
			play("error");
		}
		setBusy(false);
	}, [colorContext, play, queryClient, refreshBalance, resetForm, review]);

	if (!(mounted && isOneColorAvailable(chain) && colorContext)) return null;

	return (
		<section
			aria-labelledby="deploy-1color-title"
			className="space-y-4 rounded-lg border p-4"
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h2 id="deploy-1color-title" className="text-lg font-semibold">
						Create a 1Color token
					</h2>
					<p className="text-sm text-muted-foreground">
						Deploy a fixed supply or a mint authority through this wallet's
						color module. Testnet only.
					</p>
				</div>
				<Dialog open={open} onOpenChange={changeOpen}>
					<DialogTrigger asChild>
						<Button>
							<Plus className="size-4" data-icon="inline-start" />
							Deploy token
						</Button>
					</DialogTrigger>
					<DialogContent showCloseButton={!busy}>
						<DialogHeader>
							<DialogTitle>Deploy 1Color token</DialogTitle>
							<DialogDescription>
								Choose a fixed supply or a mint authority. Deployment is
								irreversible.
							</DialogDescription>
						</DialogHeader>
						{review ? (
							<div className="space-y-4">
								<dl className="grid grid-cols-[auto_1fr] gap-2 rounded-md border p-3 text-sm">
									<dt>Symbol</dt>
									<dd className="text-right font-mono">
										{review.symbol ?? "None"}
									</dd>
									<dt>Supply model</dt>
									<dd className="text-right">
										{review.amount > 0n ? "Fixed" : "Mint authority"}
									</dd>
									{review.amount > 0n ? (
										<>
											<dt>Supply</dt>
											<dd className="break-all text-right font-mono">
												{formatOneColorAmount(review.amount, review.decimals)}
											</dd>
											<dt>Atomic supply</dt>
											<dd className="break-all text-right font-mono">
												{review.amount.toString()}
											</dd>
										</>
									) : null}
									<dt>Decimals</dt>
									<dd className="text-right font-mono">{review.decimals}</dd>
									<dt>Icon</dt>
									<dd className="break-all text-right">
										{review.icon
											? `${formatBytes(review.icon.bytes.length)} ${review.icon.mediaType}`
											: "None"}
									</dd>
									<dt>Token output</dt>
									<dd className="text-right font-mono">1 sat</dd>
									<dt>Network fee</dt>
									<dd className="text-right text-muted-foreground">
										Set by the wallet; not quoted here
									</dd>
								</dl>
								<div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
									<AlertTriangle className="mt-0.5 size-4 shrink-0" />
									<p>
										{review.amount > 0n
											? "This creates the entire supply permanently. There is no mint authority or undo action."
											: "This creates zero supply and one mint authority controlled by this wallet. Anyone controlling that authority can mint."}
									</p>
								</div>
							</div>
						) : (
							<div className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="one-color-supply-model">Supply model</Label>
									<Select
										value={supplyKind}
										onValueChange={(value: SupplyKind) => setSupplyKind(value)}
									>
										<SelectTrigger id="one-color-supply-model">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="fixed">Fixed supply</SelectItem>
											<SelectItem value="authority">Mint authority</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-2">
									<Label htmlFor="one-color-symbol">Symbol (optional)</Label>
									<Input
										id="one-color-symbol"
										maxLength={ONE_COLOR_MAX_SYMBOL_LENGTH}
										value={symbol}
										onChange={(event) => setSymbol(event.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="one-color-decimals">Decimals</Label>
									<Input
										id="one-color-decimals"
										inputMode="numeric"
										value={decimalsText}
										onChange={(event) => setDecimalsText(event.target.value)}
									/>
								</div>
								{supplyKind === "fixed" ? (
									<div className="space-y-2">
										<Label htmlFor="one-color-supply">Fixed supply</Label>
										<Input
											id="one-color-supply"
											inputMode="decimal"
											value={amount}
											onChange={(event) => setAmount(event.target.value)}
										/>
									</div>
								) : (
									<p className="text-sm text-muted-foreground">
										Initial supply is zero. The deploy is a mint authority kept
										by this wallet.
									</p>
								)}
								<div className="space-y-2">
									<Label htmlFor="one-color-icon">Icon (optional)</Label>
									<Input
										id="one-color-icon"
										type="file"
										accept="image/*"
										onChange={(event) => void chooseIcon(event)}
									/>
									{icon ? (
										<div className="flex items-center gap-2 text-sm text-muted-foreground">
											<span className="min-w-0 truncate">{icon.name}</span>
											<span className="shrink-0">
												{formatBytes(icon.bytes.length)}
											</span>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="ml-auto shrink-0"
												onClick={() => setIcon(null)}
											>
												Remove
											</Button>
										</div>
									) : (
										<p className="text-sm text-muted-foreground">
											Embedded in the deploy, so it is paid for there: at most{" "}
											{ONE_COLOR_MAX_ICON_BYTES / 1_000} KB.
										</p>
									)}
								</div>
							</div>
						)}
						{error ? (
							<p className="text-sm text-destructive" role="alert">
								{error}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={() => (review ? setReview(null) : changeOpen(false))}
							>
								{review ? "Edit" : "Cancel"}
							</Button>
							<Button
								type="button"
								disabled={busy}
								onClick={() => void (review ? deploy() : prepareReview())}
							>
								{busy ? (
									<Loader2
										className="size-4 animate-spin"
										data-icon="inline-start"
									/>
								) : null}
								{review
									? "Authorize irreversible deployment"
									: "Review deployment"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
			{createdAssetId ? (
				<p className="break-all text-sm text-primary" role="status">
					Deployed token {createdAssetId}. The 1Color overlay must admit it
					before it can be sent.
				</p>
			) : null}
		</section>
	);
}
