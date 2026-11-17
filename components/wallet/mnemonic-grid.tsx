import { Check, Copy, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { bip39words } from "@/lib/bip39words";
import {
	AYM_ORD_PATH,
	AYM_WALLET_PATH,
	findKeysFromMnemonic,
	getKeysFromMnemonicAndPaths,
	RELAYX_ID_PATH,
	RELAYX_ORD_PATH,
	RELAYX_WALLET_PATH,
	TWETCH_WALLET_PATH,
	YOURS_ID_PATH,
	YOURS_ORD_PATH,
	YOURS_WALLET_PATH,
} from "@/lib/keys";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import type { Keys } from "@/lib/types";
import {
	canSubmitPaths,
	detectionResultApplies,
	pathsAfterCustomToggle,
	type WalletPaths,
} from "@/lib/wallet/mnemonic-paths";

interface MnemonicGridProps {
	onSubmit?: (keys: Keys) => void;
	onVerify?: (isValid: boolean) => void;
	mode?: "edit" | "view" | "prove" | "spot-check";
	mnemonic?: string;
}

export function MnemonicGrid({
	onSubmit,
	onVerify,
	mode = "edit",
	mnemonic,
}: MnemonicGridProps) {
	const [inputMnemonic, setInputMnemonic] = useState<string[]>(
		mnemonic ? mnemonic.split(" ") : Array(12).fill(""),
	);

	const [processing, setProcessing] = useState(false);
	const [useCustomPaths, setUseCustomPaths] = useState(false);
	const [detectionFailed, setDetectionFailed] = useState(false);
	const [pendingPaths, setPendingPaths] = useState<WalletPaths | undefined>();
	// The paths that last failed to derive. The notice shows only while
	// those exact paths are still picked; any edit makes a new object.
	const [invalidPaths, setInvalidPaths] = useState<WalletPaths | undefined>();
	// What the words and switch are now, for a path search that returns
	// after they changed. Set alongside the state in every handler that
	// changes them.
	const phraseRef = useRef(inputMnemonic.join(" "));
	const customRef = useRef(false);
	const updateWords = (words: string[]) => {
		phraseRef.current = words.join(" ");
		setInputMnemonic(words);
	};

	useEffect(() => {
		if (mnemonic) {
			phraseRef.current = mnemonic;
			setInputMnemonic(mnemonic.split(" "));
		}
	}, [mnemonic]);

	// Copy to clipboard state (view mode)
	const [copied, setCopied] = useState(false);
	const copyMnemonic = useCallback(async () => {
		if (!mnemonic) return;
		try {
			await navigator.clipboard.writeText(mnemonic);
		} catch (error) {
			// The error is logged without its message: it may quote the phrase.
			console.error("[mnemonic] copy to clipboard failed", {
				name: error instanceof Error ? error.name : typeof error,
			});
			toast.error("Couldn't copy the words. Write them down instead.");
			return;
		}
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [mnemonic]);

	// Prove mode state
	const [proveInput, setProveInput] = useState<string[]>(Array(12).fill(""));
	const mnemonicSlots = useMemo(
		() => Array.from({ length: 12 }, (_, slot) => slot),
		[],
	);
	const shuffledWords = useMemo(() => {
		if (mode !== "prove" || !mnemonic) return [];
		const words = mnemonic.split(" ");
		const counts = new Map<string, number>();
		const items = words.map((word) => {
			const nextCount = (counts.get(word) ?? 0) + 1;
			counts.set(word, nextCount);
			return { word, id: `${word}-${nextCount}` };
		});
		for (let i = items.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[items[i], items[j]] = [items[j], items[i]];
		}
		return items;
	}, [mode, mnemonic]);

	// Spot-check mode state: pick 3 random positions
	const spotCheckIndices = useMemo(() => {
		if (mode !== "spot-check" || !mnemonic) return [];
		const indices: number[] = [];
		const pool = Array.from({ length: 12 }, (_, i) => i);
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		indices.push(...pool.slice(0, 3));
		indices.sort((a, b) => a - b);
		return indices;
	}, [mode, mnemonic]);

	const [spotCheckInput, setSpotCheckInput] = useState<Record<number, string>>(
		{},
	);

	// Verify spot-check mode input
	useEffect(() => {
		if (mode === "spot-check" && onVerify && mnemonic) {
			const words = mnemonic.split(" ");
			const allCorrect =
				spotCheckIndices.length === 3 &&
				spotCheckIndices.every(
					(idx) =>
						spotCheckInput[idx] !== undefined &&
						spotCheckInput[idx].toLowerCase().trim() === words[idx],
				);
			onVerify(allCorrect);
		}
	}, [mode, spotCheckInput, mnemonic, onVerify, spotCheckIndices]);

	// Verify prove mode input
	useEffect(() => {
		if (mode === "prove" && onVerify && mnemonic) {
			const mnemonicWords = mnemonic.split(" ");
			const isValid = proveInput.every((word, i) => word === mnemonicWords[i]);
			const allFilled = proveInput.every((w) => w !== "");
			onVerify(isValid && allFilled);
		}
	}, [mode, proveInput, mnemonic, onVerify]);

	// Handle pasting logic from original
	const handlePaste = (e: React.ClipboardEvent, startIndex: number) => {
		if (mode === "view") return;
		e.preventDefault();
		const pastedData = e.clipboardData.getData("text");
		const words = pastedData
			.trim()
			.split(/\s+/)
			.map((w) => w.toLowerCase());

		if (words.length > 0) {
			setDetectionFailed(false);
			// Detected paths belong to the old words.
			if (!useCustomPaths) setPendingPaths(undefined);
			const newMnemonic = [...inputMnemonic];
			words.forEach((word, i) => {
				if (startIndex + i < 12) {
					newMnemonic[startIndex + i] = word;
				}
			});
			updateWords(newMnemonic);
		}
	};

	const handleWordChange = (index: number, value: string) => {
		if (mode === "view") return;
		const newMnemonic = [...inputMnemonic];
		newMnemonic[index] = value.trim().toLowerCase();
		updateWords(newMnemonic);
		setDetectionFailed(false);
		if (!useCustomPaths) setPendingPaths(undefined);
	};

	const toggleCustomPaths = () => {
		const turningOn = !useCustomPaths;
		customRef.current = turningOn;
		setUseCustomPaths(turningOn);
		setPendingPaths((paths) => pathsAfterCustomToggle(turningOn, paths));
		setDetectionFailed(false);
	};

	const hasWords = inputMnemonic.some((w) => w);
	const isValid =
		inputMnemonic.length === 12 &&
		inputMnemonic.every((w) => bip39words.includes(w));

	// Once all 12 words are valid BIP-39 words, search the wallet paths
	// automatically (edit mode only), unless custom paths are on.
	useEffect(() => {
		const process = async () => {
			const phrase = inputMnemonic.join(" ");
			if (inputMnemonic.some((w) => !w)) return;

			setProcessing(true);
			const stillApplies = () =>
				detectionResultApplies(phrase, {
					phrase: phraseRef.current,
					useCustomPaths: customRef.current,
				});
			try {
				const keys = await findKeysFromMnemonic(phrase);
				// The words or the switch changed while it ran: drop the result,
				// and the search runs again for what is there now.
				if (!stillApplies()) return;
				if (keys.ordAddressPath !== undefined) {
					setPendingPaths({
						changeAddressPath: (keys.changeAddressPath as string) || "m/0",
						ordAddressPath: keys.ordAddressPath as string,
					});
					setDetectionFailed(false);
				} else {
					setDetectionFailed(true);
				}
			} catch (error) {
				if (stillApplies()) setDetectionFailed(true);
				// Logged without its message: it may quote the phrase.
				console.error("[mnemonic] wallet path detection failed", {
					name: error instanceof Error ? error.name : typeof error,
				});
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "mnemonic.detect-paths",
					recoverable: true,
				});
			} finally {
				setProcessing(false);
			}
		};

		if (
			mode === "edit" &&
			isValid &&
			!useCustomPaths &&
			!processing &&
			!pendingPaths &&
			!detectionFailed &&
			inputMnemonic.every((w) => !!w)
		) {
			process();
		}
	}, [
		inputMnemonic,
		mode,
		isValid,
		useCustomPaths,
		processing,
		pendingPaths,
		detectionFailed,
	]);

	return (
		<div className="flex flex-col gap-4">
			{mode === "spot-check" ? (
				<div className="flex flex-col gap-3">
					{spotCheckIndices.map((idx) => {
						const words = mnemonic?.split(" ") ?? [];
						const isCorrect =
							spotCheckInput[idx]?.toLowerCase().trim() === words[idx];
						const hasInput =
							spotCheckInput[idx] !== undefined && spotCheckInput[idx] !== "";
						return (
							<div key={`spot-${idx}`} className="flex items-center gap-3">
								<span className="w-16 shrink-0 text-sm text-muted-foreground">
									Word {idx + 1}
								</span>
								<Input
									aria-label={`Mnemonic word ${idx + 1}`}
									value={spotCheckInput[idx] ?? ""}
									onChange={(e) =>
										setSpotCheckInput((prev) => ({
											...prev,
											[idx]: e.target.value,
										}))
									}
									placeholder={`Enter word #${idx + 1}`}
									className={`w-full font-mono ${
										hasInput
											? isCorrect
												? "border-success focus-visible:ring-success/50"
												: "border-destructive focus-visible:ring-destructive/50"
											: ""
									}`}
									autoComplete="off"
									autoCapitalize="none"
									autoCorrect="off"
									spellCheck={false}
								/>
								{/* The slot is always there, so the field keeps its width. */}
								<span
									role="status"
									className="flex size-4 shrink-0 items-center"
								>
									{hasInput && isCorrect && (
										<>
											<Check
												aria-hidden="true"
												className="size-4 text-success"
											/>
											<span className="sr-only">Word {idx + 1} is correct</span>
										</>
									)}
								</span>
							</div>
						);
					})}
				</div>
			) : mode === "prove" ? (
				<>
					<div className="grid grid-cols-2 md:grid-cols-3 gap-2">
						{mnemonicSlots.map((slot) => {
							const word = proveInput[slot];
							return (
								<div key={`prove-slot-${slot}`} className="relative">
									<span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground select-none">
										{slot + 1}.
									</span>
									<div
										className={`pl-8 font-mono h-11 md:h-9 flex items-center rounded-md border ${
											word ? "bg-muted" : "bg-background border-dashed"
										}`}
									>
										{word || (
											<span className="text-muted-foreground">Select word</span>
										)}
									</div>
								</div>
							);
						})}
					</div>
					<div className="flex flex-wrap gap-2 justify-center p-4 bg-muted/50 rounded-lg">
						{shuffledWords.map(({ word, id }) => {
							const isUsed = proveInput.includes(word);
							return (
								<Button
									key={id}
									variant="outline"
									size="sm"
									disabled={isUsed}
									className={isUsed ? "opacity-50" : ""}
									onClick={() => {
										const firstEmpty = proveInput.indexOf("");
										if (firstEmpty !== -1) {
											setProveInput((prev) => {
												const next = [...prev];
												next[firstEmpty] = word;
												return next;
											});
										}
									}}
								>
									{word}
								</Button>
							);
						})}
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setProveInput(Array(12).fill(""))}
					>
						<RotateCcw data-icon="inline-start" />
						Start over
					</Button>
				</>
			) : (
				<div className="grid grid-cols-2 md:grid-cols-3 gap-2">
					{mnemonicSlots.map((slot) => {
						const word = inputMnemonic[slot] ?? "";
						return (
							<div key={`word-input-${slot}`} className="relative">
								<span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground select-none">
									{slot + 1}.
								</span>
								<Input
									aria-label={`Mnemonic word ${slot + 1}`}
									value={word}
									onChange={(e) => handleWordChange(slot, e.target.value)}
									onPaste={(e) => handlePaste(e, slot)}
									readOnly={mode === "view"}
									autoComplete="off"
									autoCapitalize="none"
									autoCorrect="off"
									spellCheck={false}
									className={`pl-8 font-mono ${
										!bip39words.includes(word) && word && mode === "edit"
											? "border-destructive focus-visible:ring-destructive"
											: ""
									}`}
								/>
							</div>
						);
					})}
				</div>
			)}

			{mode === "view" && mnemonic && (
				<div className="flex justify-center">
					<Button
						variant="ghost"
						size="sm"
						className="text-muted-foreground"
						onClick={copyMnemonic}
					>
						{copied ? (
							<Check data-icon="inline-start" />
						) : (
							<Copy data-icon="inline-start" />
						)}
						{copied ? "Copied" : "Copy to clipboard"}
					</Button>
				</div>
			)}

			{mode === "edit" && (
				<div className="flex flex-col gap-3 rounded-lg border p-3">
					{!useCustomPaths && (
						<DetailList>
							<DetailRow label="Payment path">
								{pendingPaths?.changeAddressPath ?? "m/0"}
							</DetailRow>
							<DetailRow label="Ordinals path">
								{processing ? (
									<span
										role="status"
										className="flex items-center gap-2 font-sans text-muted-foreground"
									>
										<Loader2 className="size-3 animate-spin" />
										Searching wallet paths…
									</span>
								) : (
									(pendingPaths?.ordAddressPath ?? (
										<span className="font-sans text-muted-foreground">
											Found once all 12 words are in
										</span>
									))
								)}
							</DetailRow>
						</DetailList>
					)}
					<div className="flex min-h-11 items-center justify-between gap-3 md:min-h-9">
						<Label htmlFor="custom-deriv">Custom derivation paths</Label>
						<Switch
							id="custom-deriv"
							checked={useCustomPaths}
							onCheckedChange={toggleCustomPaths}
						/>
					</div>
				</div>
			)}

			{mode === "edit" && detectionFailed && !useCustomPaths && (
				<Notice role="alert" tone="danger">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p>Automatic wallet-path detection failed.</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setDetectionFailed(false)}
						>
							Try again
						</Button>
					</div>
				</Notice>
			)}

			{useCustomPaths && mode === "edit" && (
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" onClick={toggleCustomPaths}>
							1Sat
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								setPendingPaths({
									changeAddressPath: RELAYX_WALLET_PATH,
									ordAddressPath: RELAYX_ORD_PATH,
									identityAddressPath: RELAYX_ID_PATH,
								})
							}
						>
							RelayX
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								setPendingPaths({
									changeAddressPath: YOURS_WALLET_PATH,
									ordAddressPath: YOURS_ORD_PATH,
									identityAddressPath: YOURS_ID_PATH,
								})
							}
						>
							Yours
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								setPendingPaths({
									changeAddressPath: TWETCH_WALLET_PATH,
									ordAddressPath: YOURS_ORD_PATH,
								})
							}
						>
							Twetch
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								setPendingPaths({
									changeAddressPath: AYM_WALLET_PATH,
									ordAddressPath: AYM_ORD_PATH,
									identityAddressPath: AYM_ORD_PATH,
								})
							}
						>
							Aym
						</Button>
					</div>
					<div className="grid gap-2">
						<Input
							aria-label="Payment derivation path"
							placeholder={`Payment Path ${pendingPaths?.changeAddressPath || "m/0"}`}
							value={pendingPaths?.changeAddressPath || ""}
							onChange={(e) =>
								setPendingPaths((prev) => {
									const base = prev ?? {
										changeAddressPath: "",
										ordAddressPath: "",
									};
									return {
										...base,
										changeAddressPath: e.target.value,
									};
								})
							}
						/>
						<Input
							aria-label="Ordinals derivation path"
							placeholder={`Ordinals Path ${pendingPaths?.ordAddressPath || "m/0/0"}`}
							value={pendingPaths?.ordAddressPath || ""}
							onChange={(e) =>
								setPendingPaths((prev) => {
									const base = prev ?? {
										changeAddressPath: "",
										ordAddressPath: "",
									};
									return {
										...base,
										ordAddressPath: e.target.value,
									};
								})
							}
						/>
					</div>
				</div>
			)}

			{mode === "edit" &&
				invalidPaths !== undefined &&
				invalidPaths === pendingPaths && (
					<Notice role="alert" tone="danger">
						That derivation path isn't valid.
					</Notice>
				)}

			{mode === "edit" && (onSubmit || hasWords) && (
				<div
					data-slot="mnemonic-actions"
					className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center [&>*]:w-full sm:[&>*]:w-auto"
				>
					{hasWords && (
						<Button
							variant="ghost"
							onClick={() => {
								updateWords(Array(12).fill(""));
								setPendingPaths(undefined);
								setProcessing(false);
								setDetectionFailed(false);
							}}
						>
							<RotateCcw data-icon="inline-start" />
							Start over
						</Button>
					)}
					{onSubmit && (
						<Button
							className="sm:ml-auto"
							disabled={
								!canSubmitPaths({ isValid, processing, paths: pendingPaths })
							}
							onClick={() => {
								if (!onSubmit || !pendingPaths) return;
								let keys: ReturnType<typeof getKeysFromMnemonicAndPaths>;
								try {
									keys = getKeysFromMnemonicAndPaths(inputMnemonic.join(" "), {
										changeAddressPath: pendingPaths.changeAddressPath.trim(),
										ordAddressPath: pendingPaths.ordAddressPath.trim(),
										identityAddressPath:
											pendingPaths.identityAddressPath?.trim() || undefined,
									});
								} catch (error) {
									// The name only: the message can carry key material.
									console.error(
										"[mnemonic] could not derive keys from the paths",
										{
											name: error instanceof Error ? error.name : typeof error,
										},
									);
									setInvalidPaths(pendingPaths);
									return;
								}
								setInvalidPaths(undefined);
								onSubmit(keys);
							}}
						>
							Next
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
