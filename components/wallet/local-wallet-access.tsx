"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The surfaces around the browser's question for reaching a wallet on this
 * computer (BRC-325): the explanation before it, the wait while it is open,
 * and the help after a block. Inline panels, never modal, so the browser's own
 * question near the top of the window is the only thing asking.
 */

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
				Look for your wallet on this computer
			</p>
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
			<div className="grid grid-cols-2 gap-2">
				<Button variant="secondary" onClick={onLook}>
					Look for my wallet
				</Button>
				<Button variant="secondary" onClick={onSkip}>
					Skip for now
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
			<p role="status">
				Waiting for your answer to your browser's question, near the top of the
				window. There's no time limit.
			</p>
			<Button variant="secondary" size="sm" onClick={onStop}>
				Stop waiting
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
			<Button variant="ghost" size="sm" onClick={onHide}>
				Hide
			</Button>
		</section>
	);
}
