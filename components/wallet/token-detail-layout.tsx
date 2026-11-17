"use client";

import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { SectionHeader } from "@/components/ui/section-header";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { TokenIcon } from "./token-row";

/**
 * One token's page, for every standard: icon, ticker and balance, then the
 * action bar (Receive, Send, Mint), then the standard's own sections
 * (pending sends, history), then the token's id with copy and its facts.
 * The wallet header above is the page's h1 and back arrow, so the ticker is
 * an h2.
 */
export function TokenDetailLayout({
	icon,
	ticker,
	badge,
	balance,
	balanceCaption,
	actions,
	status,
	idLabel,
	id,
	details,
	children,
}: {
	icon: string | undefined;
	ticker: string;
	/** A chip beside the ticker, such as a mint authority. */
	badge?: ReactNode;
	/** The spendable balance, formatted. */
	balance: string;
	/** One muted line under the balance. */
	balanceCaption?: ReactNode;
	/** The action bar's buttons: one row, equal widths on a phone. */
	actions: ReactNode;
	/** The last action's outcome, under the action bar. */
	status?: ReactNode;
	/** What the standard calls its id: "Token ID", "Asset ID". */
	idLabel: string;
	id: string;
	/** More DetailRows after the id. */
	details?: ReactNode;
	/** The standard's own sections, between the action bar and the details. */
	children?: ReactNode;
}) {
	const [, copy] = useCopyWithSound();
	return (
		<div className="flex flex-col gap-6">
			<section
				aria-labelledby="token-detail-ticker"
				className="flex flex-col gap-4"
			>
				<div className="flex items-center gap-4">
					<TokenIcon icon={icon} size={64} />
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<h2
								className="min-w-0 font-semibold text-lg tracking-tight wrap-anywhere"
								id="token-detail-ticker"
							>
								{ticker}
							</h2>
							{badge}
						</div>
						<p
							className="font-mono font-semibold text-2xl tabular-nums wrap-anywhere"
							data-testid="token-balance"
						>
							{balance}
						</p>
						{balanceCaption ? (
							<p className="text-muted-foreground text-sm">{balanceCaption}</p>
						) : null}
					</div>
				</div>
				<fieldset
					aria-label="Token actions"
					className="grid min-w-0 auto-cols-fr grid-flow-col gap-2 sm:flex sm:flex-wrap"
				>
					{actions}
				</fieldset>
				{status}
			</section>
			{children}
			<section aria-label="Token details" className="flex flex-col gap-3">
				<SectionHeader title="Details" />
				<DetailList className="rounded-xl border p-4">
					<DetailRow label={idLabel} stack>
						<span className="flex items-start justify-between gap-2">
							<span className="min-w-0 break-all text-xs">{id}</span>
							<Button
								aria-label={`Copy ${idLabel.toLowerCase()}`}
								className="-my-2 shrink-0"
								onClick={() => void copy(id)}
								size="icon"
								title={`Copy ${idLabel.toLowerCase()}`}
								variant="ghost"
							>
								<Copy />
							</Button>
						</span>
					</DetailRow>
					{details}
				</DetailList>
			</section>
		</div>
	);
}
