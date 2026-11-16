"use client";

import { ArrowDownToLine, Copy, ExternalLink, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { endpointsOf } from "@/lib/chain-endpoints";
import { formatHandle } from "@/lib/wallet/handles";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export const ONE_COLOR_RECEIVE_NOTE =
	"1Color tokens are sent to a handle, not to an address. Give the sender one of your handles below.";

function HandleRow({ handle }: { handle: string }) {
	const [, copy] = useCopyWithSound();
	return (
		<div className="flex flex-col items-center gap-3">
			<div
				aria-label={`QR code for ${handle}`}
				className="rounded-lg bg-white p-4"
				role="img"
			>
				<QRCodeSVG size={160} value={handle} />
			</div>
			<div className="flex w-full gap-2">
				<Input
					aria-label="Handle"
					className="font-mono text-sm"
					readOnly
					value={handle}
				/>
				<Button
					aria-label={`Copy ${handle}`}
					onClick={() => void copy(handle)}
					size="icon"
					variant="outline"
				>
					<Copy />
				</Button>
			</div>
		</div>
	);
}

/**
 * Where this wallet receives 1Color tokens: its BRC-169 handles, with copy
 * and QR, or a link to register one. Tokens sent to a handle are collected
 * by the handle inbox sync.
 */
export function OneColorReceive() {
	const { chain } = useWalletToolbox();
	const handles = useWalletHandles();
	const registration = endpointsOf(chain).handleRegistration;

	let body: React.ReactNode;
	if (handles.isPending) {
		body = (
			<div className="flex items-center justify-center py-6 text-muted-foreground">
				<Loader2 className="mr-2 size-5 animate-spin" />
				Loading your handles…
			</div>
		);
	} else if (handles.isError) {
		body = (
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
	} else if (handles.data.length === 0) {
		body = (
			<div className="space-y-3 text-sm">
				<p className="text-muted-foreground">
					This wallet has no handle yet. Register one, then come back here.
				</p>
				<Button asChild variant="outline">
					<a href={registration} rel="noopener noreferrer" target="_blank">
						Register a handle <ExternalLink data-icon="inline-end" />
					</a>
				</Button>
			</div>
		);
	} else {
		const unique = [...new Set(handles.data.map(formatHandle))];
		body = (
			<div className="space-y-6">
				{unique.map((handle) => (
					<HandleRow handle={handle} key={handle} />
				))}
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-sm">{ONE_COLOR_RECEIVE_NOTE}</p>
			{body}
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
