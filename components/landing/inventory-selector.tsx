"use client";

import { Coins, Search } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	DialogContent,
	DialogHeader,
	DialogTitle,
	SoundDialog,
} from "@/components/ui/sound-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	formatSatoshisAsBsv,
	parseBsvAmount,
} from "@/components/wallet/wallet-home-utils";
import { useSound } from "@/hooks/use-sound";
import { getOrdinalThumbnail } from "@/lib/image-utils";
import { createBsv21OfferItem, toBsv21OfferToken } from "@/lib/p2p-bsv21-offer";
import type { P2PTradeItem } from "@/lib/types/p2p";
import {
	getContentType,
	getDisplayOutpoint,
	getName,
	parseWalletOutpoint,
} from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

interface InventorySelectorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (item: P2PTradeItem) => void;
}

type InventoryKind = "ordinal" | "bsv21" | "bsv";

export function InventorySelector({
	open,
	onOpenChange,
	onSelect,
}: InventorySelectorProps) {
	const { play } = useSound();
	const { bsv21Tokens, ordinals, isInitialized, balance } = useWalletToolbox();
	const [kind, setKind] = useState<InventoryKind>("ordinal");
	const [search, setSearch] = useState("");
	const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
	const [tokenAmount, setTokenAmount] = useState("");
	const [tokenError, setTokenError] = useState<string | null>(null);
	const [bsvAmount, setBsvAmount] = useState("");
	const offerTokens = bsv21Tokens.flatMap((token) => {
		const offerToken = toBsv21OfferToken(token);
		return offerToken ? [offerToken] : [];
	});
	const selectedToken = offerTokens.find(
		(token) => token.id === selectedTokenId,
	);
	const filteredOrdinals = ordinals.filter((ordinal) => {
		if (!search) return true;
		const outpoint = getDisplayOutpoint(ordinal);
		return `${getName(ordinal) ?? "Ordinal"} ${outpoint}`
			.toLowerCase()
			.includes(search.toLowerCase());
	});
	const filteredTokens = offerTokens.filter((token) => {
		if (!search) return true;
		return `${token.name} ${token.id}`
			.toLowerCase()
			.includes(search.toLowerCase());
	});

	const reset = () => {
		setSearch("");
		setSelectedTokenId(null);
		setTokenAmount("");
		setTokenError(null);
		setBsvAmount("");
	};

	const changeOpen = (next: boolean) => {
		if (!next) reset();
		onOpenChange(next);
	};

	const selectTokenAmount = () => {
		if (!selectedToken) return;
		const result = createBsv21OfferItem(selectedToken, tokenAmount);
		if (!result.ok) {
			setTokenError(result.error);
			play("error");
			return;
		}
		play("click");
		onSelect(result.item);
		changeOpen(false);
	};

	const selectBsvAmount = () => {
		const satoshis = parseBsvAmount(bsvAmount);
		if (!satoshis) {
			setTokenError("Enter an amount of BSV above zero.");
			play("error");
			return;
		}
		if (balance && satoshis > balance.total) {
			setTokenError("That's more BSV than this wallet holds.");
			play("error");
			return;
		}
		play("click");
		onSelect({
			type: "satoshis",
			id: "bsv",
			name: `${formatSatoshisAsBsv(satoshis)} BSV`,
			satoshis,
		});
		changeOpen(false);
	};

	return (
		<SoundDialog open={open} onOpenChange={changeOpen}>
			<DialogContent className="flex h-[min(640px,85dvh)] max-w-3xl flex-col overflow-hidden pb-0 [--dialog-spacing:0px]">
				<DialogHeader className="border-b p-6">
					<DialogTitle>Add an asset to your offer</DialogTitle>
					<Tabs
						className="mt-3"
						onValueChange={(value) => {
							setKind(value as InventoryKind);
							setSearch("");
							setTokenError(null);
						}}
						value={kind}
					>
						<TabsList className="grid w-full grid-cols-3">
							<TabsTrigger value="ordinal">
								Ordinals <span className="tabular-nums">{ordinals.length}</span>
							</TabsTrigger>
							<TabsTrigger value="bsv21">
								BSV21 <span className="tabular-nums">{offerTokens.length}</span>
							</TabsTrigger>
							<TabsTrigger value="bsv">BSV</TabsTrigger>
						</TabsList>
					</Tabs>
					<div className={kind === "bsv" ? "hidden" : "relative mt-4"}>
						<Search className="absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" />
						<Input
							aria-label={`Search wallet ${kind === "ordinal" ? "ordinals" : "BSV21 tokens"}`}
							className="pl-8"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search items"
							value={search}
						/>
					</div>
				</DialogHeader>
				{/* The last block clears the home indicator: the amount form when it
				    shows, the list otherwise. */}
				<div
					className={
						(kind === "bsv21" && selectedToken) || kind === "bsv"
							? "flex-1 overflow-y-auto p-6"
							: "flex-1 overflow-y-auto p-6 pb-[max(--spacing(6),env(safe-area-inset-bottom))]"
					}
				>
					{!isInitialized && (
						<p className="py-10 text-center text-muted-foreground">
							Wallet loading…
						</p>
					)}
					{isInitialized &&
						kind === "ordinal" &&
						filteredOrdinals.length === 0 && (
							<p className="py-10 text-center text-muted-foreground">
								No matching ordinals found.
							</p>
						)}
					{isInitialized && kind === "bsv21" && filteredTokens.length === 0 && (
						<p className="py-10 text-center text-muted-foreground">
							No matching BSV21 tokens found.
						</p>
					)}
					{kind === "bsv" && (
						<p className="py-10 text-center text-muted-foreground">
							BSV you offer is paid in the same transaction as the swap.
						</p>
					)}
					{kind === "ordinal" && (
						<div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
							{filteredOrdinals.map((ordinal) => {
								const outpoint = getDisplayOutpoint(ordinal);
								const { txid, vout } = parseWalletOutpoint(ordinal);
								const name =
									getName(ordinal) ??
									`Ordinal ${txid.slice(0, 4)}…${txid.slice(-4)}`;
								const contentType =
									getContentType(ordinal) || "Unknown content";
								const image = getOrdinalThumbnail(outpoint, 200);
								return (
									<button
										className="overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary"
										key={outpoint}
										onClick={() => {
											play("click");
											onSelect({
												id: outpoint,
												name,
												type: "ordinal",
												image,
												txid,
												vout,
												satoshis: ordinal.satoshis,
											});
											changeOpen(false);
										}}
										type="button"
									>
										<div className="relative aspect-square bg-muted/20">
											{contentType.startsWith("image/") ? (
												<Image
													alt={name}
													className="object-cover"
													fill
													sizes="(max-width: 767px) 40vw, (max-width: 1023px) 25vw, 180px"
													src={image}
												/>
											) : (
												<div className="flex h-full items-center justify-center break-all p-2 text-center text-muted-foreground text-xs">
													{contentType}
												</div>
											)}
										</div>
										<div className="p-3">
											<p className="truncate font-medium text-sm">{name}</p>
											<p className="mt-1 truncate text-muted-foreground text-xs">
												{contentType}
											</p>
										</div>
									</button>
								);
							})}
						</div>
					)}
					{kind === "bsv21" && (
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{filteredTokens.map((token) => (
								<button
									aria-pressed={selectedTokenId === token.id}
									className="flex min-w-0 items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary aria-pressed:border-primary aria-pressed:bg-primary/5"
									key={token.id}
									onClick={() => {
										play("click");
										setSelectedTokenId(token.id);
										setTokenAmount("");
										setTokenError(null);
									}}
									type="button"
								>
									<div className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40">
										{token.image ? (
											<Image
												alt=""
												className="object-cover"
												fill
												sizes="48px"
												src={token.image}
											/>
										) : (
											<Coins className="size-5 text-muted-foreground" />
										)}
									</div>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-sm">{token.name}</p>
										<p className="truncate text-muted-foreground text-xs">
											{token.balanceDisplay} available
										</p>
									</div>
									<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
										BSV21
									</span>
								</button>
							))}
						</div>
					)}
				</div>
				{kind === "bsv" && (
					<form
						className="border-t bg-muted/20 p-4 pb-[max(--spacing(4),env(safe-area-inset-bottom))]"
						onSubmit={(event) => {
							event.preventDefault();
							selectBsvAmount();
						}}
					>
						<div className="flex items-end gap-3">
							<div className="min-w-0 flex-1 space-y-1.5">
								<Label htmlFor="p2p-bsv-amount">Amount of BSV</Label>
								<Input
									aria-describedby="p2p-bsv-balance"
									autoComplete="off"
									id="p2p-bsv-amount"
									inputMode="decimal"
									onChange={(event) => {
										setBsvAmount(event.target.value);
										setTokenError(null);
									}}
									placeholder="0.001"
									value={bsvAmount}
								/>
							</div>
							<Button disabled={!bsvAmount.trim()} type="submit">
								Add to offer
							</Button>
						</div>
						<p
							className="mt-2 text-muted-foreground text-xs"
							id="p2p-bsv-balance"
						>
							{balance
								? `Available: ${formatSatoshisAsBsv(balance.total)} BSV. Only one of you can offer BSV.`
								: "Only one of you can offer BSV."}
						</p>
						{tokenError && (
							<p className="mt-2 text-destructive text-sm" role="alert">
								{tokenError}
							</p>
						)}
					</form>
				)}
				{kind === "bsv21" && selectedToken && (
					<form
						className="border-t bg-muted/20 p-4 pb-[max(--spacing(4),env(safe-area-inset-bottom))]"
						onSubmit={(event) => {
							event.preventDefault();
							selectTokenAmount();
						}}
					>
						<div className="flex items-end gap-3">
							<div className="min-w-0 flex-1 space-y-1.5">
								<Label htmlFor="p2p-bsv21-amount">
									Amount of {selectedToken.symbol}
								</Label>
								<Input
									aria-describedby="p2p-bsv21-balance"
									autoComplete="off"
									id="p2p-bsv21-amount"
									inputMode="decimal"
									onChange={(event) => {
										setTokenAmount(event.target.value);
										setTokenError(null);
									}}
									placeholder="0"
									value={tokenAmount}
								/>
							</div>
							<Button disabled={!tokenAmount.trim()} type="submit">
								Add to offer
							</Button>
						</div>
						<p
							className="mt-2 text-muted-foreground text-xs"
							id="p2p-bsv21-balance"
						>
							Available: {selectedToken.balanceDisplay} {selectedToken.symbol}
						</p>
						{tokenError && (
							<p className="mt-2 text-destructive text-sm" role="alert">
								{tokenError}
							</p>
						)}
					</form>
				)}
			</DialogContent>
		</SoundDialog>
	);
}
