"use client";

import { sendBsv } from "@1sat/actions";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Copy, Loader2, Send, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	DialogClose,
	DialogContent,
	DialogDescription,
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
import styles from "./wallet-home.module.css";
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
				message:
					"Paymail sends are blocked on OPL-4014 and OPL-4015 while payment outputs and delivery failures are hardened.",
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
						className={styles.action}
						disabled={!receiveAvailable}
						size="lg"
						variant="ghost"
					>
						<ArrowDownToLine data-icon="inline-start" /> Receive
					</Button>
				</DialogTrigger>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Receive BSV</DialogTitle>
						<DialogDescription>
							{connectionMode === "built-in"
								? "This address rotates after an incoming payment is detected."
								: "This address is derived through the connected wallet; that provider controls discovery and rotation."}
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col items-center gap-4 py-2">
						<div
							aria-label="QR code for the wallet deposit address"
							className="rounded-lg bg-white p-4"
							role="img"
						>
							{depositAddress && (
								<QRCodeSVG size={192} value={depositAddress} />
							)}
						</div>
						<div className="flex w-full gap-2">
							<Input
								aria-label="Deposit address"
								className="font-mono text-xs"
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
						className={styles.action}
						disabled={!oneSatContext}
						size="lg"
						variant="ghost"
					>
						<Send data-icon="inline-start" /> Send
					</Button>
				</DialogTrigger>
				<DialogContent
					className={
						sendState.status === "success"
							? "pay-success-card rounded-3xl bg-popover text-center [--primary:var(--chart-1)] [--primary-foreground:var(--foreground)] dark:[--primary:var(--ring)] dark:[--primary-foreground:var(--background)]"
							: undefined
					}
				>
					<DialogHeader
						className={sendState.status === "success" ? "sr-only" : undefined}
					>
						<DialogTitle>Send BSV</DialogTitle>
						<DialogDescription>
							Enter a BSV address and the amount to send.
						</DialogDescription>
					</DialogHeader>
					{sendState.status === "success" ? (
						<div className="space-y-5 text-center" role="status">
							<PaySuccessMark />
							<div className="pay-success-copy space-y-2">
								<p className="font-bold text-2xl text-foreground">
									Payment sent
								</p>
								<p className="text-muted-foreground text-sm">
									Your BSV is on its way.
								</p>
								<p className="pt-2 font-bold text-3xl text-foreground break-all">
									{formatSatoshisAsBsv(sendState.satoshis)} BSV
								</p>
							</div>
							<p className="break-all font-mono text-muted-foreground text-xs">
								{sendState.txid}
							</p>
							<DialogClose asChild>
								<Button className="h-14 w-full rounded-full bg-primary font-bold text-primary-foreground">
									Done
								</Button>
							</DialogClose>
						</div>
					) : sendState.status === "review" ||
						sendState.status === "sending" ? (
						<div className="space-y-4">
							<dl className="space-y-3 rounded-lg border p-4 text-sm">
								<div className="space-y-1">
									<dt className="text-muted-foreground">Destination</dt>
									<dd className="break-all font-mono">
										{sendState.destination}
									</dd>
								</div>
								<div className="flex justify-between gap-4">
									<dt className="text-muted-foreground">Amount</dt>
									<dd className="font-mono">
										{formatSatoshisAsBsv(sendState.satoshis)} BSV
									</dd>
								</div>
								<div className="flex justify-between gap-4">
									<dt className="text-muted-foreground">Network fee</dt>
									<dd>Calculated by wallet</dd>
								</div>
								<div className="flex justify-between gap-4 border-t pt-3 font-medium">
									<dt>Total</dt>
									<dd className="text-right font-mono">
										{formatSatoshisAsBsv(sendState.satoshis)} BSV + fee
									</dd>
								</div>
							</dl>
							<p className="text-muted-foreground text-xs">
								The installed standard payment action does not expose a fee
								quote before it broadcasts.
							</p>
							<div className="grid grid-cols-2 gap-2">
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
							</div>
						</div>
					) : (
						<div className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="wallet-home-recipient">Recipient</Label>
								<Input
									autoComplete="off"
									id="wallet-home-recipient"
									onChange={(event) => setRecipient(event.target.value)}
									placeholder="1A1z…"
									value={recipient}
								/>
							</div>
							<div className="space-y-2">
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
								<div
									className="flex gap-2 text-destructive text-sm"
									role="alert"
								>
									<X className="mt-0.5 size-4 shrink-0" />
									<span className="break-all">{sendState.message}</span>
								</div>
							)}
							<p className="text-muted-foreground text-xs">
								P2PKH addresses only. Paymail is blocked on OPL-4014 and
								OPL-4015; the installed SDK has no identity-to-payment
								resolution contract.
							</p>
							<Button
								className="w-full"
								disabled={!recipient.trim() || !amount.trim()}
								onClick={reviewSend}
							>
								Review payment
							</Button>
						</div>
					)}
				</DialogContent>
			</SoundDialog>
		</div>
	);
}
