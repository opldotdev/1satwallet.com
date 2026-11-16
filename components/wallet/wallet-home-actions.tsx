"use client";

import { sendBsv } from "@1sat/actions";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Copy, Loader2, Send } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	SoundDialog,
} from "@/components/ui/sound-dialog";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { useSound } from "@/hooks/use-sound";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { PaySuccessMark } from "./pay-success-mark";
import {
	formatSatoshisAsBsv,
	isP2pkhAddressForChain,
	parseBsvAmount,
	sendFailureMessage,
} from "./wallet-home-utils";

interface ReviewedSend {
	destination: string;
	satoshis: number;
}

type SendState =
	| { status: "idle" }
	| ({ status: "review" | "sending" } & ReviewedSend)
	| { status: "success"; txid: string; satoshis: number }
	| { status: "error"; message: string };

export function WalletHomeActions() {
	const {
		chain,
		connectionMode,
		depositAddress,
		oneSatContext,
		refreshBalance,
	} = useWalletToolbox();
	const queryClient = useQueryClient();
	const [, copy] = useCopyWithSound();
	const { play, preparePayChime } = useSound();
	const playedTxid = useRef<string | null>(null);
	const inFlightRef = useRef(false);
	const [sendOpen, setSendOpen] = useState(false);
	const [recipient, setRecipient] = useState("");
	const [amount, setAmount] = useState("");
	const [sendState, setSendState] = useState<SendState>({ status: "idle" });

	useEffect(() => {
		if (
			sendState.status === "success" &&
			playedTxid.current !== sendState.txid
		) {
			playedTxid.current = sendState.txid;
			play("payChime");
		}
	}, [sendState, play]);

	const reviewSend = () => {
		const satoshis = parseBsvAmount(amount);
		if (!satoshis) {
			setSendState({
				status: "error",
				message: "Enter a positive BSV amount with no more than 8 decimals.",
			});
			return;
		}

		const destination = recipient.trim();
		if (!destination) return;
		if (destination.includes("@")) {
			setSendState({
				status: "error",
				message: "Paymail addresses aren't supported yet. Enter a BSV address.",
			});
			return;
		}
		if (!isP2pkhAddressForChain(destination, chain)) {
			setSendState({
				status: "error",
				message: `Enter a valid ${chain === "main" ? "mainnet" : "testnet"} P2PKH address.`,
			});
			return;
		}
		setSendState({ status: "review", destination, satoshis });
	};

	const handleSend = async () => {
		if (
			!oneSatContext ||
			inFlightRef.current ||
			sendState.status !== "review"
		) {
			return;
		}
		const { destination, satoshis } = sendState;
		preparePayChime();
		inFlightRef.current = true;
		setSendState({ status: "sending", destination, satoshis });

		try {
			const result = await sendBsv.execute(oneSatContext, {
				requests: [{ address: destination, satoshis }],
			});
			if (result.error || !result.txid) {
				// reportDiagnostic keeps only a sanitised code; log the full error.
				console.error("[wallet.bsv.send]", result.error ?? "missing txid");
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.bsv.send",
					recoverable: true,
					context: { retryable: true },
				});
				setSendState({
					status: "error",
					message: sendFailureMessage(result.error ?? "missing transaction id"),
				});
				return;
			}

			setSendState({
				status: "success",
				txid: result.txid,
				satoshis,
			});
			refreshBalance();
			void queryClient.invalidateQueries({ queryKey: ["wallet-actions"] });
		} catch (error) {
			console.error("[wallet.bsv.send]", error);
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: "wallet.bsv.send",
				recoverable: true,
				context: { retryable: true },
			});
			setSendState({
				status: "error",
				message: sendFailureMessage(error),
			});
		} finally {
			inFlightRef.current = false;
		}
	};
	const receiveAvailable = !!depositAddress;

	return (
		<div className="grid grid-cols-2 gap-2 sm:flex">
			<SoundDialog>
				<DialogTrigger asChild>
					<Button
						className="sm:min-w-32"
						disabled={!receiveAvailable}
						size="lg"
						variant="tile"
					>
						<ArrowDownToLine data-icon="inline-start" /> Receive
					</Button>
				</DialogTrigger>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Receive BSV</DialogTitle>
						<DialogDescription>
							{connectionMode === "built-in"
								? "This address changes after each payment you receive."
								: "Your connected wallet manages this address."}
						</DialogDescription>
					</DialogHeader>
					<div
						aria-label="QR code for the wallet deposit address"
						className="size-56 self-center overflow-hidden rounded-lg bg-white"
						role="img"
					>
						{depositAddress && (
							<QRCodeSVG marginSize={4} size={224} value={depositAddress} />
						)}
					</div>
					<div className="flex gap-2">
						<Input
							aria-label="Deposit address"
							className="font-mono text-xs md:text-xs"
							readOnly
							value={depositAddress ?? "Unavailable"}
						/>
						<Button
							aria-label="Copy deposit address"
							disabled={!depositAddress}
							onClick={() => depositAddress && void copy(depositAddress)}
							size="icon"
							variant="outline"
						>
							<Copy />
						</Button>
					</div>
				</DialogContent>
			</SoundDialog>

			<SoundDialog
				onOpenChange={(open) => {
					if (!open && inFlightRef.current) return;
					setSendOpen(open);
					if (!open && sendState.status === "success") {
						setRecipient("");
						setAmount("");
						setSendState({ status: "idle" });
					}
				}}
				open={sendOpen}
			>
				<DialogTrigger asChild>
					<Button
						className="sm:min-w-32"
						disabled={!oneSatContext}
						size="lg"
						variant="tile"
					>
						<Send data-icon="inline-start" /> Send
					</Button>
				</DialogTrigger>
				<DialogContent
					showCloseButton={sendState.status !== "success"}
					className={
						sendState.status === "success"
							? "pay-success-card text-center"
							: undefined
					}
				>
					{sendState.status === "success" ? (
						<>
							<div
								className="flex flex-col items-center gap-(--dialog-gap)"
								role="status"
							>
								<PaySuccessMark />
								<div className="pay-success-copy flex flex-col gap-2">
									<DialogTitle className="text-2xl leading-tight">
										Payment sent
									</DialogTitle>
									<DialogDescription>
										It will confirm shortly.
									</DialogDescription>
									<p className="font-mono font-semibold text-2xl wrap-anywhere">
										{formatSatoshisAsBsv(sendState.satoshis)} BSV
									</p>
								</div>
							</div>
							<DialogClose asChild>
								<Button
									className="w-full bg-brand text-brand-foreground hover:bg-brand/90"
									size="lg"
								>
									Done
								</Button>
							</DialogClose>
							<details className="text-muted-foreground text-sm">
								<summary className="flex min-h-11 cursor-pointer items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring md:min-h-9">
									Transaction details
								</summary>
								<p className="mt-2 font-mono text-xs wrap-anywhere">
									{sendState.txid}
								</p>
							</details>
						</>
					) : (
						<DialogHeader>
							<DialogTitle>Send BSV</DialogTitle>
							<DialogDescription>
								{sendState.status === "review" || sendState.status === "sending"
									? "Check the amount and recipient."
									: "Enter a BSV address and the amount to send."}
							</DialogDescription>
						</DialogHeader>
					)}
					{sendState.status === "review" || sendState.status === "sending" ? (
						<>
							<DetailList>
								<DetailRow label="Recipient" stack>
									{sendState.destination}
								</DetailRow>
								<DetailRow label="Amount">
									{formatSatoshisAsBsv(sendState.satoshis)} BSV
								</DetailRow>
								<DetailRow label="Network fee" mono={false}>
									Added when sent
								</DetailRow>
							</DetailList>
							<DialogFooter>
								<Button
									disabled={sendState.status === "sending"}
									onClick={() => setSendState({ status: "idle" })}
									variant="outline"
								>
									Back
								</Button>
								<Button
									disabled={sendState.status === "sending"}
									onClick={() => void handleSend()}
								>
									{sendState.status === "sending" && (
										<Loader2
											className="animate-spin"
											data-icon="inline-start"
										/>
									)}
									{sendState.status === "sending"
										? "Sending…"
										: "Confirm and send"}
								</Button>
							</DialogFooter>
						</>
					) : sendState.status === "idle" || sendState.status === "error" ? (
						<>
							<div className="flex flex-col gap-2">
								<Label htmlFor="wallet-home-recipient">Recipient</Label>
								<Input
									autoComplete="off"
									id="wallet-home-recipient"
									onChange={(event) => setRecipient(event.target.value)}
									placeholder="1A1z…"
									value={recipient}
								/>
								<p className="text-muted-foreground text-xs">
									BSV addresses only. Paymail isn't supported yet.
								</p>
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="wallet-home-amount">Amount (BSV)</Label>
								<Input
									id="wallet-home-amount"
									inputMode="decimal"
									onChange={(event) => setAmount(event.target.value)}
									placeholder="0.00000000"
									type="text"
									value={amount}
								/>
							</div>
							{sendState.status === "error" && (
								<Notice tone="danger">
									<span className="wrap-anywhere">{sendState.message}</span>
								</Notice>
							)}
							<DialogFooter>
								<Button
									disabled={!recipient.trim() || !amount.trim()}
									onClick={reviewSend}
								>
									Review payment
								</Button>
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</SoundDialog>
		</div>
	);
}
