"use client";

import { Search } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
	DialogContent,
	DialogHeader,
	DialogTitle,
	SoundDialog,
} from "@/components/ui/sound-dialog";
import { useSound } from "@/hooks/use-sound";
import { getOrdinalThumbnail } from "@/lib/image-utils";
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

export function InventorySelector({
	open,
	onOpenChange,
	onSelect,
}: InventorySelectorProps) {
	const { play } = useSound();
	const { ordinals, isInitialized } = useWalletToolbox();
	const [search, setSearch] = useState("");
	const filtered = ordinals.filter((ordinal) => {
		if (!search) return true;
		const outpoint = getDisplayOutpoint(ordinal);
		return `${getName(ordinal) ?? "Ordinal"} ${outpoint}`
			.toLowerCase()
			.includes(search.toLowerCase());
	});

	return (
		<SoundDialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[min(600px,85dvh)] max-w-3xl flex-col overflow-hidden p-0">
				<DialogHeader className="border-b p-6">
					<DialogTitle>Select an ordinal to offer</DialogTitle>
					<div className="relative mt-4">
						<Search className="absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" />
						<Input
							aria-label="Search wallet ordinals"
							className="pl-8"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search items"
							value={search}
						/>
					</div>
				</DialogHeader>
				<div className="flex-1 overflow-y-auto p-6">
					{!isInitialized && (
						<p className="py-10 text-center text-muted-foreground">
							Wallet loading…
						</p>
					)}
					{isInitialized && filtered.length === 0 && (
						<p className="py-10 text-center text-muted-foreground">
							No matching ordinals found.
						</p>
					)}
					<div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
						{filtered.map((ordinal) => {
							const outpoint = getDisplayOutpoint(ordinal);
							const { txid, vout } = parseWalletOutpoint(ordinal);
							const name =
								getName(ordinal) ??
								`Ordinal ${txid.slice(0, 4)}…${txid.slice(-4)}`;
							const contentType = getContentType(ordinal) || "Unknown content";
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
										onOpenChange(false);
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
				</div>
			</DialogContent>
		</SoundDialog>
	);
}
