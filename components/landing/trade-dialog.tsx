"use client";

import { useMutation, useQuery } from "convex/react";
import {
	ArrowRightLeft,
	CheckCircle2,
	Fingerprint,
	Lock,
	Plus,
	ShieldCheck,
	Trash2,
	XCircle,
} from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	SoundDialog,
} from "@/components/ui/sound-dialog";
import { signP2PCommand } from "@/lib/p2p-auth";
import type { P2PTradeItem } from "@/lib/types/p2p";
import { formatBsv21Amount } from "@/lib/wallet/bsv21-actions";
import { validateBsv21OfferForLock } from "@/lib/wallet/bsv21-offer-validation";
import { getDisplayOutpoint } from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { api } from "../../convex/_generated/api";
import { InventorySelector } from "./inventory-selector";

interface TradeDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	peerIdentity: string;
	sessionId: string;
	myIdentity: string;
}

function shortIdentity(value: string): string {
	return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function OfferItem({
	item,
	canRemove,
	onRemove,
}: {
	item: P2PTradeItem;
	canRemove?: boolean;
	onRemove?: () => void;
}) {
	return (
		<Card className="overflow-hidden py-0">
			<CardContent className="flex items-center gap-3 p-3">
				{item.image ? (
					<div className="relative size-12 shrink-0 overflow-hidden rounded-md bg-muted">
						<Image
							alt={item.name}
							className="object-cover"
							fill
							sizes="48px"
							src={item.image}
						/>
					</div>
				) : (
					<div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary/10">
						<Fingerprint className="size-5 text-primary" />
					</div>
				)}
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium text-sm">{item.name}</p>
					{item.type === "bsv21" && (
						<p className="truncate text-muted-foreground text-xs">
							{formatBsv21Amount(item.amount, item.decimals ?? 0)} units
						</p>
					)}
					<p className="truncate font-mono text-muted-foreground text-xs">
						{item.id}
					</p>
				</div>
				{canRemove && onRemove && (
					<Button
						aria-label={`Remove ${item.name}`}
						onClick={onRemove}
						size="icon"
						variant="ghost"
					>
						<Trash2 className="size-4" />
					</Button>
				)}
			</CardContent>
		</Card>
	);
}

export function TradeDialog({
	open,
	onOpenChange,
	peerIdentity,
	sessionId,
	myIdentity,
}: TradeDialogProps) {
	const session = useQuery(api.p2p.getSession, { sessionId });
	const updateOffer = useMutation(api.p2p.updateOffer);
	const { wallet, ordinals, oneSatContext } = useWalletToolbox();
	const [inventoryOpen, setInventoryOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [verifyingAssets, setVerifyingAssets] = useState(false);
	const [lockError, setLockError] = useState<string | null>(null);

	const initiator = session?.initiatorIdentity === myIdentity;
	const myItems = ((initiator
		? session?.initiatorItems
		: session?.participantItems) ?? []) as P2PTradeItem[];
	const peerItems = ((initiator
		? session?.participantItems
		: session?.initiatorItems) ?? []) as P2PTradeItem[];
	const myLocked = Boolean(
		initiator ? session?.initiatorLocked : session?.participantLocked,
	);
	const peerLocked = Boolean(
		initiator ? session?.participantLocked : session?.initiatorLocked,
	);
	const myRevision = initiator
		? (session?.initiatorRevision ?? 0)
		: (session?.participantRevision ?? 0);
	const ownedOrdinals = new Set(
		ordinals.map((ordinal) => getDisplayOutpoint(ordinal)),
	);

	const publishOffer = async (items: P2PTradeItem[], locked: boolean) => {
		if (!wallet || !session) return;
		setLockError(null);
		setBusy(true);
		try {
			if (locked) {
				const missing = items.find(
					(item) => item.type === "ordinal" && !ownedOrdinals.has(item.id),
				);
				if (missing) {
					const message = `${missing.name} is no longer available in this wallet.`;
					setLockError(message);
					toast.error(message);
					return;
				}
				if (items.some((item) => item.type === "bsv21")) {
					setVerifyingAssets(true);
					const validation = await validateBsv21OfferForLock(
						oneSatContext,
						items,
					);
					setVerifyingAssets(false);
					if (!validation.ok) {
						setLockError(validation.message);
						toast.error(validation.message);
						return;
					}
				}
			}
			const signed = await signP2PCommand(wallet, "session.offer", {
				sessionId,
				revision: myRevision + 1,
				items,
				locked,
			});
			await updateOffer(signed);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "The offer could not be updated.";
			setLockError(message);
			toast.error(message);
		} finally {
			setVerifyingAssets(false);
			setBusy(false);
		}
	};

	if (!session) {
		return (
			<SoundDialog open={open} onOpenChange={onOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Loading trade session…</DialogTitle>
					</DialogHeader>
				</DialogContent>
			</SoundDialog>
		);
	}

	return (
		<>
			<InventorySelector
				onOpenChange={setInventoryOpen}
				onSelect={(item) => {
					if (
						!myItems.some(
							(existing) =>
								existing.type === item.type && existing.id === item.id,
						)
					) {
						void publishOffer([...myItems, item], false);
					}
				}}
				open={inventoryOpen}
			/>
			<SoundDialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="flex h-[min(650px,90dvh)] max-w-[800px] flex-col gap-0 overflow-hidden p-0 shadow-2xl">
					<DialogHeader className="border-b bg-muted/40 p-6 pr-12">
						<div className="flex items-center justify-between gap-4">
							<DialogTitle className="flex items-center gap-3 text-xl">
								<ArrowRightLeft className="size-5 text-primary" />
								P2P Trade Session
							</DialogTitle>
							<Badge variant={myLocked && peerLocked ? "default" : "secondary"}>
								{myLocked && peerLocked
									? "Ready for settlement"
									: "Negotiating"}
							</Badge>
						</div>
						<DialogDescription className="flex items-center gap-2">
							<Fingerprint className="size-4 text-primary" /> Trading with
							<span className="font-mono font-bold text-primary">
								{shortIdentity(peerIdentity)}
							</span>
							<Badge variant="outline">BRC-100 verified</Badge>
						</DialogDescription>
					</DialogHeader>

					<div className="grid min-h-0 flex-1 grid-cols-2 divide-x bg-background">
						<section
							className="flex min-h-0 flex-col p-5"
							aria-label="Your offer"
						>
							<div className="mb-4 flex items-center justify-between">
								<h3 className="font-semibold">Your offer</h3>
								{myLocked && <Lock className="size-4 text-primary" />}
							</div>
							<div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
								{myItems.map((item) => (
									<OfferItem
										canRemove={!myLocked && !busy}
										item={item}
										key={`${item.type}:${item.id}`}
										onRemove={() =>
											void publishOffer(
												myItems.filter(
													(entry) =>
														entry.type !== item.type || entry.id !== item.id,
												),
												false,
											)
										}
									/>
								))}
								{myItems.length === 0 && (
									<p className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
										No items selected.
									</p>
								)}
							</div>
							<div className="mt-4 grid gap-2">
								<Button
									disabled={myLocked || busy}
									onClick={() => setInventoryOpen(true)}
									variant="outline"
								>
									<Plus className="size-4" data-icon="inline-start" /> Add item
								</Button>
								<Button
									disabled={busy || myItems.length === 0}
									onClick={() => void publishOffer(myItems, !myLocked)}
								>
									{myLocked ? (
										<XCircle className="size-4" data-icon="inline-start" />
									) : (
										<Lock className="size-4" data-icon="inline-start" />
									)}
									{verifyingAssets
										? "Checking BSV21 assets…"
										: myLocked
											? "Unlock offer"
											: "Lock offer"}
								</Button>
								{lockError && (
									<p className="text-destructive text-xs" role="alert">
										{lockError}
									</p>
								)}
							</div>
						</section>

						<section
							className="flex min-h-0 flex-col p-5"
							aria-label="Peer offer"
						>
							<div className="mb-4 flex items-center justify-between">
								<h3 className="font-semibold">Their offer</h3>
								{peerLocked && <CheckCircle2 className="size-4 text-chart-4" />}
							</div>
							<div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
								{peerItems.map((item) => (
									<OfferItem item={item} key={`${item.type}:${item.id}`} />
								))}
								{peerItems.length === 0 && (
									<p className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
										Waiting for their offer.
									</p>
								)}
							</div>
							<div className="mt-4 rounded-md border border-primary/20 bg-primary/5 p-3 text-muted-foreground text-xs">
								<div className="mb-1 flex items-center gap-2 font-medium text-foreground">
									<ShieldCheck className="size-4 text-primary" /> Signed
									negotiation
								</div>
								Every offer change and lock is signed by its BRC-100 wallet.
								Assets do not move until atomic settlement.
							</div>
						</section>
					</div>

					<div className="flex items-center justify-between border-t bg-muted/30 px-6 py-4">
						<p className="text-muted-foreground text-xs">
							Session expires automatically. Closing cancels it for both
							parties.
						</p>
						<Button disabled variant="secondary">
							{myLocked && peerLocked
								? "Settlement handoff pending"
								: "Lock both offers to continue"}
						</Button>
					</div>
				</DialogContent>
			</SoundDialog>
		</>
	);
}
