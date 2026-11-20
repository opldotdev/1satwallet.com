"use client";

import { sendBsv } from "@1sat/actions";
import { useQueryClient } from "@tanstack/react-query";
import {
	ArrowDownToLine,
	ChevronDown,
	Copy,
	Loader2,
	Send,
} from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { useSound } from "@/hooks/use-sound";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	type BsvRecipient,
	checkBsvRecipient,
	runHandleSend,
} from "@/lib/wallet/bsv-send";
import {
	livePeerPayDeps,
	peerPayOutbox,
	runPeerPaySend,
} from "@/lib/wallet/peerpay-send";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { BsvPendingSends } from "./bsv-pending-sends";
import { WalletHandles } from "./one-color-receive";
import { PaySuccessMark } from "./pay-success-mark";
import {
	formatSatoshisAsBsv,
	parseBsvAmount,
	sendFailureMessage,
} from "./wallet-home-utils";

interface ReviewedSend {
	recipient: BsvRecipient;
	satoshis: number;
	/** Sent with a handle payment only. */
	memo: string;
}

type SendState =
	| { status: "idle" | "checking" }
	| ({ status: "review" | "sending" } & ReviewedSend)
	| { status: "success"; txid: string; satoshis: number; note: string }
	| { status: "undelivered"; message: string }
	| { status: "error"; message: string };

const ADDRESS_SENT_NOTE = "It will confirm shortly.";

const shortKey = (key: string) => `${key.slice(0, 10)}…${key.slice(-8)}`;

/** What review shows as the recipient. */
const recipientLabel = (recipient: BsvRecipient): string =>
	recipient.kind === "address"
		? recipient.address
		: recipient.kind === "handle"
			? recipient.handle
			: recipient.identityKey;

export function WalletHomeActions() {
	const {
		chain,
		connectionMode,
		depositAddress,
		identityKey,
		oneSatContext,
		refreshBalance,
	} = useWalletToolbox();
	const queryClient = useQueryClient();
	const { play, preparePayChime } = useSound();
	const playedTxid = useRef<string | null>(null);
	const inFlightRef = useRef(false);
	const [sendOpen, setSendOpen] = useState(false);
	const [recipient, setRecipient] = useState("");
	const [amount, setAmount] = useState("");
	const [memo, setMemo] = useState("");
	const checkRef = useRef(0);
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

	const reviewSend = async () => {
		const satoshis = parseBsvAmount(amount);
		if (!satoshis) {
			setSendState({
				status: "error",
				message: "Enter a positive BSV amount with no more than 8 decimals.",
			});
			return;
		}
		if (!recipient.trim()) return;
		const check = ++checkRef.current;
		setSendState({ status: "checking" });
		const checked = await checkBsvRecipient(recipient, chain);
		// A newer review, or an edit, replaced this one.
		if (check !== checkRef.current) return;
		if (!checked.ok) {
			setSendState({ status: "error", message: checked.message });
			return;
		}
		if (checked.recipient.kind === "identity" && !identityKey) {
			setSendState({
				status: "error",
				message:
					"PeerPay needs this wallet's identity key, which isn't available yet.",
			});
			return;
		}
		setSendState({
			status: "review",
			recipient: checked.recipient,
			satoshis,
			memo: checked.recipient.kind === "handle" ? memo.trim() : "",
		});
	};

	const afterSend = () => {
		refreshBalance();
		void queryClient.invalidateQueries({ queryKey: ["wallet-actions"] });
	};

	const handleSend = async () => {
		if (
			!oneSatContext ||
			inFlightRef.current ||
			sendState.status !== "review"
		) {
			return;
		}
		const { recipient: target, satoshis, memo: note } = sendState;
		preparePayChime();
		inFlightRef.current = true;
		setSendState({ ...sendState, status: "sending" });

		try {
			if (target.kind !== "address") {
				const outcome =
					target.kind === "handle"
						? await runHandleSend(oneSatContext, {
								handle: target.handle,
								satoshis,
								memo: note,
								reviewed: target.resolution,
								chain,
							})
						: identityKey
							? await runPeerPaySend(
									{ recipient: target.identityKey, satoshis },
									{
										...livePeerPayDeps(oneSatContext.wallet, chain),
										outbox: peerPayOutbox(
											window.localStorage,
											chain,
											identityKey,
										),
									},
								)
							: {
									kind: "failed" as const,
									message:
										"PeerPay needs this wallet's identity key, which isn't available yet.",
								};
				afterSend();
				setSendState(
					outcome.kind === "sent"
						? {
								status: "success",
								txid: outcome.txid,
								satoshis,
								note: outcome.message,
							}
						: outcome.kind === "undelivered" || outcome.kind === "unsaved"
							? { status: "undelivered", message: outcome.message }
							: { status: "error", message: outcome.message },
				);
				return;
			}
			const result = await sendBsv.execute(oneSatContext, {
				requests: [{ address: target.address, satoshis }],
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
				note: ADDRESS_SENT_NOTE,
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
								? "Share an address, one of your handles, or your PeerPay link."
								: "Your connected wallet manages this address."}
						</DialogDescription>
					</DialogHeader>
					{connectionMode === "built-in" && identityKey ? (
						<Tabs defaultValue="address">
							<TabsList className="grid h-auto w-full grid-cols-3 [&>*]:max-md:min-h-11">
								<TabsTrigger value="address">Address</TabsTrigger>
								<TabsTrigger value="handle">Handle</TabsTrigger>
								<TabsTrigger value="peerpay">PeerPay</TabsTrigger>
							</TabsList>
							<TabsContent
								className="flex flex-col gap-(--dialog-gap) pt-2"
								value="address"
							>
								<p className="text-muted-foreground text-sm">
									This address changes after each payment you receive.
								</p>
								<AddressReceive depositAddress={depositAddress} />
							</TabsContent>
							<TabsContent className="space-y-3 pt-2" value="handle">
								<p className="text-muted-foreground text-sm">
									Wallets that support handles can pay your handle directly.
								</p>
								<WalletHandles />
							</TabsContent>
							<TabsContent className="space-y-3 pt-2" value="peerpay">
								<PeerPayReceive identityKey={identityKey} />
							</TabsContent>
						</Tabs>
					) : (
						<AddressReceive depositAddress={depositAddress} />
					)}
				</DialogContent>
			</SoundDialog>

			<SoundDialog
				onOpenChange={(open) => {
					if (!open && inFlightRef.current) return;
					setSendOpen(open);
					if (
						!open &&
						(sendState.status === "success" ||
							sendState.status === "undelivered")
					) {
						setRecipient("");
						setAmount("");
						setMemo("");
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
									<DialogDescription>{sendState.note}</DialogDescription>
									<p className="font-mono font-semibold text-3xl wrap-anywhere">
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
							<details className="group text-muted-foreground text-sm">
								<summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring md:min-h-9 [&::-webkit-details-marker]:hidden">
									Transaction details
									<ChevronDown
										aria-hidden="true"
										className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
									/>
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
									: "Pay a BSV address, a handle or an identity key."}
							</DialogDescription>
						</DialogHeader>
					)}
					{sendState.status === "review" || sendState.status === "sending" ? (
						<>
							<DetailList>
								<DetailRow label="Recipient" stack>
									{recipientLabel(sendState.recipient)}
								</DetailRow>
								{sendState.recipient.kind === "handle" ? (
									<DetailRow label="Identity key">
										{shortKey(sendState.recipient.resolution.identityKey)}
									</DetailRow>
								) : null}
								{sendState.memo ? (
									<DetailRow label="Memo" mono={false} stack>
										{sendState.memo}
									</DetailRow>
								) : null}
								{sendState.recipient.kind !== "address" ? (
									<DetailRow label="Delivery" mono={false} stack>
										{sendState.recipient.kind === "handle"
											? "To the handle's mailbox. They claim it when their wallet next syncs."
											: "Through MessageBox (PeerPay). They need a PeerPay-compatible wallet."}
									</DetailRow>
								) : null}
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
					) : sendState.status === "undelivered" ? (
						<>
							<Notice tone="warning">
								<span className="wrap-anywhere">{sendState.message}</span>
							</Notice>
							<BsvPendingSends />
							<DialogFooter>
								<DialogClose asChild>
									<Button>Done</Button>
								</DialogClose>
							</DialogFooter>
						</>
					) : (
						<>
							<div className="flex flex-col gap-2">
								<Label htmlFor="wallet-home-recipient">Recipient</Label>
								<Input
									autoCapitalize="none"
									autoComplete="off"
									aria-describedby="wallet-home-recipient-hint"
									id="wallet-home-recipient"
									onChange={(event) => {
										checkRef.current += 1;
										setRecipient(event.target.value);
										if (sendState.status === "checking") {
											setSendState({ status: "idle" });
										}
									}}
									placeholder="1A1z…, @name@domain or 02…"
									spellCheck={false}
									value={recipient}
								/>
								<p
									className="text-muted-foreground text-xs"
									id="wallet-home-recipient-hint"
								>
									A BSV address, a handle like @name@domain, or an identity key
									for PeerPay. Paymail isn't supported.
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
							{recipient.includes("@") ? (
								<div className="flex flex-col gap-2">
									<Label htmlFor="wallet-home-memo">Memo (optional)</Label>
									<Input
										aria-describedby="wallet-home-memo-hint"
										autoComplete="off"
										id="wallet-home-memo"
										onChange={(event) => setMemo(event.target.value)}
										value={memo}
									/>
									<p
										className="text-muted-foreground text-xs"
										id="wallet-home-memo-hint"
									>
										Delivered with a payment to a handle.
									</p>
								</div>
							) : null}
							{sendState.status === "error" && (
								<Notice tone="danger">
									<span className="wrap-anywhere">{sendState.message}</span>
								</Notice>
							)}
							<DialogFooter>
								<Button
									disabled={
										sendState.status === "checking" ||
										!recipient.trim() ||
										!amount.trim()
									}
									onClick={() => void reviewSend()}
								>
									{sendState.status === "checking" && (
										<Loader2
											className="animate-spin"
											data-icon="inline-start"
										/>
									)}
									{sendState.status === "checking"
										? "Looking up…"
										: "Review payment"}
								</Button>
							</DialogFooter>
							<BsvPendingSends />
						</>
					)}
				</DialogContent>
			</SoundDialog>
		</div>
	);
}

/** BRC-125 `peerpay:` link of this wallet's identity key (iOS Receive > PeerPay). */
function PeerPayReceive({ identityKey }: { identityKey: string }) {
	const [, copy] = useCopyWithSound();
	const link = `peerpay:${identityKey}`;
	return (
		<>
			<p className="text-muted-foreground text-sm">
				Wallets that support PeerPay can pay this identity key. Payments arrive
				in your incoming payments.
			</p>
			<div
				aria-label="QR code for this wallet's PeerPay link"
				className="mx-auto w-fit rounded-lg bg-white p-4"
				role="img"
			>
				<QRCodeSVG size={160} value={link} />
			</div>
			<div className="flex gap-2">
				<Input
					aria-label="Identity key"
					className="font-mono text-xs md:text-xs"
					readOnly
					value={identityKey}
				/>
				<Button
					aria-label="Copy PeerPay link"
					onClick={() => void copy(link)}
					size="icon"
					variant="outline"
				>
					<Copy />
				</Button>
			</div>
		</>
	);
}

function AddressReceive({ depositAddress }: { depositAddress: string | null }) {
	const [, copy] = useCopyWithSound();
	return (
		<>
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
		</>
	);
}
