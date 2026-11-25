"use client";

import { type Bsv21Balance, getBsv21Balances } from "@1sat/actions";
import { useQueryClient } from "@tanstack/react-query";
import { Coins, KeyRound, Loader2, RefreshCw, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { DialogFooter } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	SoundDialog,
} from "@/components/ui/sound-dialog";
import { useSound } from "@/hooks/use-sound";
import { bsv21IconSrc } from "@/lib/bsv21-icon";
import type { Chain } from "@/lib/chain-endpoints";
import { useBsv21Availability } from "@/lib/hooks/use-stack-features";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	type AssetSurfaceState,
	describeAssetSurface,
} from "@/lib/wallet/asset-query-state";
import {
	bsv21ActionFailureMessage,
	executeBsv21Send,
	formatBsv21Amount,
	parseBsv21Amount,
	parseBsv21Destination,
} from "@/lib/wallet/bsv21-actions";
import { tokenDetailHref } from "@/lib/wallet/create-token";
import { shortOutpoint } from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { Bsv21AuthorityManager } from "./bsv21-authority-manager";
import {
	TokenGroup,
	TokenList,
	TokenRow,
	TokenRowsSkeleton,
} from "./token-row";

/** A BSV-21 token's ticker: its symbol, else the start of its id. */
export const bsv21Ticker = (token: { sym?: string; id: string }) =>
	token.sym || token.id.slice(0, 8);

/**
 * What the wallet can send of a BSV-21 token: its whole balance. The
 * wallet's balance read counts spendable outputs only, so nothing is pending.
 */
export const bsv21Spendable = (token: Bsv21Balance) => BigInt(token.amt);

/** Why BSV-21 balances aren't shown, with a Retry after a failed read. */
export function Bsv21Unreadable({ state }: { state: AssetSurfaceState }) {
	const { refreshBalance } = useWalletToolbox();
	return (
		<EmptyState
			action={
				state.kind === "error" ? (
					<Button onClick={refreshBalance} variant="outline">
						<RefreshCw data-icon="inline-start" /> Retry
					</Button>
				) : undefined
			}
			icon={Coins}
			title={describeAssetSurface(state, "token")}
		/>
	);
}

/**
 * A BSV-21 token's icon through OrdFS, else its deploy inscription, sized
 * for a TokenIcon tile of `size` CSS px.
 */
export const bsv21Icon = (token: Bsv21Balance, chain: Chain, size: 40 | 64) =>
	bsv21IconSrc(token.id, token.icon || token.id, size * 2, chain);

/** Says why BSV-21 sends, mints and creates are off, once the stack has answered. */
export function Bsv21UnavailableNotice() {
	const { available, checking } = useBsv21Availability();
	if (available || checking) return null;
	return (
		<Notice tone="warning">
			The wallet service isn't offering BSV-21 right now, so sending, minting
			and creating BSV-21 tokens is off until it is.
		</Notice>
	);
}

/**
 * Send a BSV-21 token to an address or identity key: enter, check the
 * amount and recipient, then send. The balance and the token's overlay
 * status are read again just before sending.
 */
export function Bsv21SendDialog({
	token,
	onSent,
}: {
	token: Bsv21Balance;
	onSent: (message: string) => void;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const { chain, oneSatContext, refreshBalance } = useWalletToolbox();
	const { available: bsv21Available } = useBsv21Availability();
	const [open, setOpen] = useState(false);
	const [recipient, setRecipient] = useState("");
	const [sendAmount, setSendAmount] = useState("");
	const [reviewAmount, setReviewAmount] = useState<bigint | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ticker = bsv21Ticker(token);
	const balance = bsv21Spendable(token);

	const refresh = useCallback(async () => {
		refreshBalance();
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["wallet-balance"] }),
			queryClient.invalidateQueries({ queryKey: ["bsv21-market"] }),
		]);
		router.refresh();
	}, [queryClient, refreshBalance, router]);

	const prepareReview = useCallback(async () => {
		if (!oneSatContext?.services || !bsv21Available) return;
		setBusy(true);
		setError(null);
		try {
			const amount = parseBsv21Amount(sendAmount, token.dec);
			if (!amount) {
				setError(`Enter a positive amount with at most ${token.dec} decimals.`);
				return;
			}
			if (!parseBsv21Destination(recipient, chain)) {
				setError(
					"Enter a valid address for this network or a compressed identity key.",
				);
				return;
			}
			oneSatContext.services.bsv21.clearCache();
			const [details, balances] = await Promise.all([
				oneSatContext.services.bsv21.getTokenDetails(token.id),
				getBsv21Balances.execute(oneSatContext, {}),
			]);
			const current = balances.find((item) => item.id === token.id);
			if (!details.status?.is_active) {
				setError("This token is not active in the overlay.");
				return;
			}
			if (!current || BigInt(current.amt) < amount) {
				setError("The wallet no longer has enough spendable tokens.");
				return;
			}
			setReviewAmount(amount);
		} catch (cause) {
			console.error(`[bsv21] send review of ${token.id} failed:`, cause);
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: "wallet.bsv21.send-review",
				recoverable: true,
				context: { retryable: true },
			});
			setReviewAmount(null);
			setError(bsv21ActionFailureMessage(cause));
		} finally {
			setBusy(false);
		}
	}, [
		bsv21Available,
		chain,
		oneSatContext,
		recipient,
		sendAmount,
		token.dec,
		token.id,
	]);

	const send = useCallback(async () => {
		if (!(oneSatContext?.services && reviewAmount && bsv21Available)) return;
		setBusy(true);
		setError(null);
		try {
			const destination = parseBsv21Destination(recipient, chain);
			const amount = parseBsv21Amount(sendAmount, token.dec);
			if (!destination || amount !== reviewAmount) {
				setReviewAmount(null);
				throw new Error("Review details changed. Review the transfer again.");
			}
			oneSatContext.services.bsv21.clearCache();
			const [details, balances] = await Promise.all([
				oneSatContext.services.bsv21.getTokenDetails(token.id),
				getBsv21Balances.execute(oneSatContext, {}),
			]);
			const current = balances.find((item) => item.id === token.id);
			if (!details.status?.is_active) {
				setReviewAmount(null);
				throw new Error("token-not-active");
			}
			if (!current || BigInt(current.amt) < amount) {
				setReviewAmount(null);
				throw new Error(
					"The indexed token balance changed. Refresh and review again.",
				);
			}
			const result = await executeBsv21Send(oneSatContext, {
				tokenId: token.id,
				amount,
				destination,
			});
			if (result.error) throw new Error(result.error);
			onSent(
				`Sent ${formatBsv21Amount(amount, token.dec)} ${ticker}${result.txid ? ` in ${result.txid}` : ""}.`,
			);
			setReviewAmount(null);
			setRecipient("");
			setSendAmount("");
			setOpen(false);
			play("success");
			await refresh();
		} catch (cause) {
			console.error(`[bsv21] send of ${token.id} failed:`, cause);
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: "wallet.bsv21.send",
				recoverable: true,
				context: { retryable: true },
			});
			setError(bsv21ActionFailureMessage(cause));
			play("error");
		} finally {
			setBusy(false);
		}
	}, [
		bsv21Available,
		chain,
		oneSatContext,
		onSent,
		play,
		recipient,
		refresh,
		reviewAmount,
		sendAmount,
		ticker,
		token.dec,
		token.id,
	]);

	return (
		<SoundDialog
			open={open}
			onOpenChange={(next) => {
				if (busy) return;
				setOpen(next);
				if (!next) {
					setReviewAmount(null);
					setError(null);
				}
			}}
		>
			<DialogTrigger asChild>
				<Button
					variant="outline"
					disabled={!(oneSatContext && bsv21Available) || balance <= 0n}
				>
					<Send data-icon="inline-start" /> Send
				</Button>
			</DialogTrigger>
			<DialogContent showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>Send {ticker}</DialogTitle>
					<DialogDescription>
						{reviewAmount
							? "Check the amount and recipient."
							: "To an address or an identity key."}
					</DialogDescription>
				</DialogHeader>
				{reviewAmount ? (
					<DetailList className="rounded-xl border p-4">
						<DetailRow label="Amount">
							{formatBsv21Amount(reviewAmount, token.dec)} {ticker}
						</DetailRow>
						<DetailRow label="Recipient" stack>
							{recipient.trim()}
						</DetailRow>
						<DetailRow label="Fee" mono={false}>
							Set by your wallet
						</DetailRow>
					</DetailList>
				) : (
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<Label htmlFor={`recipient-${token.id}`}>Recipient</Label>
							<Input
								id={`recipient-${token.id}`}
								onChange={(event) => setRecipient(event.target.value)}
								placeholder="Address or identity key"
								value={recipient}
							/>
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor={`amount-${token.id}`}>Amount</Label>
							<Input
								id={`amount-${token.id}`}
								inputMode="decimal"
								onChange={(event) => setSendAmount(event.target.value)}
								placeholder="0"
								value={sendAmount}
							/>
							<p className="text-muted-foreground text-xs">
								Available: {formatBsv21Amount(balance, token.dec)} {ticker}
							</p>
						</div>
					</div>
				)}
				{error ? (
					<p className="text-destructive text-sm" role="alert">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() =>
							reviewAmount ? setReviewAmount(null) : setOpen(false)
						}
					>
						{reviewAmount ? "Edit" : "Cancel"}
					</Button>
					<Button
						type="button"
						disabled={busy || !recipient.trim() || !sendAmount.trim()}
						onClick={() => void (reviewAmount ? send() : prepareReview())}
					>
						{busy ? (
							<Loader2 className="animate-spin" data-icon="inline-start" />
						) : null}
						{reviewAmount ? `Send ${ticker}` : "Review"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</SoundDialog>
	);
}

/**
 * The BSV-21 group of the Tokens section: one row per token, each opening
 * the token's wallet page. Minting by token ID (for an authority whose token
 * this wallet holds none of) opens from the group's heading.
 */
export default function TokenGrid() {
	const {
		bsv21Tokens: tokens,
		bsv21State,
		chain,
		isBalanceLoading,
		oneSatContext,
	} = useWalletToolbox();
	const { available } = useBsv21Availability();
	const [authorityStatus, setAuthorityStatus] = useState<string | null>(null);

	let content: ReactNode;
	if (isBalanceLoading) {
		content = <TokenRowsSkeleton />;
	} else if (bsv21State.kind !== "ready" && bsv21State.kind !== "empty") {
		content = <Bsv21Unreadable state={bsv21State} />;
	} else if (tokens.length === 0) {
		content = (
			<EmptyState
				description="Tokens you receive or create show up here."
				icon={Coins}
				title="No BSV-21 tokens yet"
			/>
		);
	} else {
		content = (
			<TokenList>
				{tokens.map((token) => (
					<TokenRow
						amount={formatBsv21Amount(bsv21Spendable(token), token.dec)}
						caption={shortOutpoint(token.id)}
						href={tokenDetailHref("bsv21", token.id)}
						icon={bsv21Icon(token, chain, 40)}
						key={token.id}
						ticker={bsv21Ticker(token)}
					/>
				))}
			</TokenList>
		);
	}

	return (
		<TokenGroup
			action={
				<Bsv21AuthorityManager
					onDone={setAuthorityStatus}
					trigger={
						<Button
							disabled={!(oneSatContext && available)}
							size="sm"
							variant="ghost"
						>
							<KeyRound data-icon="inline-start" /> Mint by token ID
						</Button>
					}
				/>
			}
			id="tokens-bsv21"
			title="BSV-21"
		>
			<Bsv21UnavailableNotice />
			{authorityStatus ? (
				<p className="text-primary text-sm wrap-anywhere" role="status">
					{authorityStatus}
				</p>
			) : null}
			{content}
		</TokenGroup>
	);
}
