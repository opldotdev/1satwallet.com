"use client";

import { ArrowDownToLine, Copy, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	SoundDialog,
} from "@/components/ui/sound-dialog";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { useWalletHandles } from "@/hooks/use-wallet-handles";
import { formatHandle } from "@/lib/wallet/handles";
import { RegisterHandle } from "./register-handle";

export const ONE_COLOR_RECEIVE_NOTE =
	"1Color tokens are sent to a handle, not to an address. Give the sender one of your handles below.";

function HandleQr({ handle }: { handle: string }) {
	return (
		<div
			aria-label={`QR code for ${handle}`}
			className="mx-auto w-fit rounded-lg bg-white p-4"
			role="img"
		>
			<QRCodeSVG size={160} value={handle} />
		</div>
	);
}

/**
 * The selected handle's QR, then every handle with copy. One QR at a time
 * keeps a wallet with several handles short on a phone.
 */
function HandleList({ handles }: { handles: string[] }) {
	const [, copy] = useCopyWithSound();
	const [picked, setPicked] = useState(handles[0]);
	const selected = handles.includes(picked) ? picked : handles[0];
	return (
		<div className="space-y-4">
			<HandleQr handle={selected} />
			<ul className="space-y-2">
				{handles.map((handle) => (
					<li className="flex items-center gap-2" key={handle}>
						{handles.length > 1 ? (
							<Button
								aria-pressed={handle === selected}
								className="min-w-0 flex-1 justify-start font-mono text-sm"
								onClick={() => setPicked(handle)}
								variant={handle === selected ? "secondary" : "ghost"}
							>
								<span className="truncate">{handle}</span>
							</Button>
						) : (
							<span className="min-w-0 flex-1 truncate font-mono text-sm">
								{handle}
							</span>
						)}
						<Button
							aria-label={`Copy ${handle}`}
							onClick={() => void copy(handle)}
							size="icon"
							variant="outline"
						>
							<Copy />
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The wallet's BRC-169 handles, with copy and QR, or registration when there
 * is none. Read again every time it mounts, so a handle registered in another
 * tab shows promptly.
 */
export function WalletHandles() {
	const handles = useWalletHandles({ refetchOnMount: "always" });

	if (handles.isPending) {
		return (
			<div className="flex items-center justify-center py-6 text-muted-foreground">
				<Loader2 className="mr-2 size-5 animate-spin" />
				Loading your handles…
			</div>
		);
	}
	if (handles.isError) {
		return (
			<div className="space-y-2 text-sm" role="alert">
				<p className="text-destructive">
					Your handles couldn&apos;t be read from the wallet.
				</p>
				<Button
					onClick={() => void handles.refetch()}
					size="sm"
					variant="outline"
				>
					Try again
				</Button>
			</div>
		);
	}
	if (handles.data.length === 0) {
		return (
			<div className="space-y-3 text-sm">
				<p className="text-muted-foreground">This wallet has no handle yet.</p>
				<RegisterHandle />
			</div>
		);
	}
	return <HandleList handles={[...new Set(handles.data.map(formatHandle))]} />;
}

/**
 * Where this wallet receives 1Color tokens: its BRC-169 handles. Tokens sent
 * to a handle are collected by the handle inbox sync.
 */
export function OneColorReceive() {
	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-sm">{ONE_COLOR_RECEIVE_NOTE}</p>
			<WalletHandles />
		</div>
	);
}

/** A Receive button that opens `OneColorReceive` in a dialog. */
export function OneColorReceiveDialog() {
	return (
		<SoundDialog>
			<DialogTrigger asChild>
				<Button size="sm" variant="outline">
					<ArrowDownToLine data-icon="inline-start" /> Receive
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Receive 1Color tokens</DialogTitle>
					<DialogDescription>
						Received tokens appear after the handle inbox is checked, about once
						a minute.
					</DialogDescription>
				</DialogHeader>
				<OneColorReceive />
			</DialogContent>
		</SoundDialog>
	);
}
