"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The surfaces around the browser's question for reaching a wallet on this
 * computer (BRC-325): the explanation before it, the wait while it is open,
 * and the help after a block. Inline panels, never modal, so the browser's own
 * question near the top of the window is the only thing asking. The text parts
 * are shared with the account menu, which renders its own menu items as the
 * controls.
 */

export const PRIMER_TITLE = "Look for your wallet on this computer";
export const PRIMER_LOOK = "Look for my wallet";
export const PRIMER_SKIP = "Skip for now";
export const STOP_WAITING = "Stop waiting";

export function PrimerText({ host }: { host: string }) {
	return (
		<>
			<p className="text-muted-foreground">
				Your browser will ask whether {host || "this site"} may reach other apps
				and services on this device. Its question appears near the top of the
				window.
			</p>
			<p className="text-muted-foreground">
				That access reaches more than your wallet. This site uses it only to
				find and talk to your wallet. Your keys stay in your wallet.
			</p>
			<p className="text-muted-foreground">Skipping changes nothing here.</p>
		</>
	);
}

export function WaitingText() {
	return (
		<p role="status">
			Waiting for your answer to your browser's question, near the top of the
			window. There's no time limit.
		</p>
	);
}

export function BlockedHelpText() {
	return (
		<>
			<p>
				Your browser blocks this site from reaching apps on this computer, so it
				can't look for a desktop wallet.
			</p>
			<p className="text-muted-foreground">
				In Chrome, open the control at the left of the address bar and allow
				Apps on device. This page notices the change by itself.
			</p>
			<p className="text-muted-foreground">
				You can still create or import a wallet in this browser.
			</p>
		</>
	);
}

export function LocalWalletPrimer({
	host,
	onLook,
	onSkip,
	className,
}: {
	host: string;
	onLook: () => void;
	onSkip: () => void;
	className?: string;
}) {
	const ref = useRef<HTMLElement>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	return (
		<section
			ref={ref}
			aria-labelledby="local-wallet-primer-title"
			tabIndex={-1}
			className={cn("space-y-3 text-left text-sm outline-none", className)}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onSkip();
				}
			}}
		>
			<p id="local-wallet-primer-title" className="font-medium">
				{PRIMER_TITLE}
			</p>
			<PrimerText host={host} />
			<div className="grid grid-cols-2 gap-2">
				<Button variant="secondary" onClick={onLook}>
					{PRIMER_LOOK}
				</Button>
				<Button variant="secondary" onClick={onSkip}>
					{PRIMER_SKIP}
				</Button>
			</div>
		</section>
	);
}

export function LocalWalletWaiting({
	onStop,
	className,
}: {
	onStop: () => void;
	className?: string;
}) {
	return (
		<div className={cn("space-y-3 text-left text-sm", className)}>
			<WaitingText />
			<Button variant="secondary" size="sm" onClick={onStop}>
				{STOP_WAITING}
			</Button>
		</div>
	);
}

export function LocalWalletBlockedHelp({
	onHide,
	className,
}: {
	onHide: () => void;
	className?: string;
}) {
	return (
		<section
			aria-label="Your browser blocks this site from reaching apps on this computer"
			className={cn("space-y-2 text-left text-sm", className)}
		>
			<BlockedHelpText />
			<Button variant="ghost" size="sm" onClick={onHide}>
				Hide
			</Button>
		</section>
	);
}
