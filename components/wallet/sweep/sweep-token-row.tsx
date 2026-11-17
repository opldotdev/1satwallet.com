import { TokenIcon } from "@/components/wallet/token-row";
import { cn } from "@/lib/utils";

/** A ticker's first letter in a rounded tile, for tokens with no icon. */
export function SweepLetterAvatar({
	ticker,
	className,
}: {
	ticker: string;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted font-semibold text-muted-foreground text-sm",
				className,
			)}
		>
			{ticker.slice(0, 1).toUpperCase() || "?"}
		</span>
	);
}

/**
 * One token in a sweep list: icon (or letter), ticker, output count as a
 * quiet caption, and the amount inline at the right.
 */
export function SweepTokenRow({
	icon,
	letterAvatar = false,
	ticker,
	amount,
	caption,
	outputCount,
	dimmed = false,
	className,
}: {
	icon?: string;
	/** BSV-20 tokens have no icon: show the ticker's letter instead. */
	letterAvatar?: boolean;
	ticker: string;
	/** Already formatted at the token's decimals. Omit for none. */
	amount?: string;
	/** Replaces the output count caption. */
	caption?: string;
	outputCount: number;
	/** Excluded from the sweep. */
	dimmed?: boolean;
	className?: string;
}) {
	return (
		<div
			data-slot="sweep-token-row"
			className={cn(
				"flex min-h-14 min-w-0 items-center gap-3 px-4 py-2 motion-safe:transition-opacity",
				dimmed && "opacity-50",
				className,
			)}
		>
			{letterAvatar ? (
				<SweepLetterAvatar ticker={ticker} />
			) : (
				<TokenIcon icon={icon} size={40} />
			)}
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">{ticker}</p>
				<p className="truncate text-muted-foreground text-xs">
					{caption ??
						`${outputCount.toLocaleString("en-US")} ${outputCount === 1 ? "output" : "outputs"}`}
				</p>
			</div>
			{amount && (
				<span className="max-w-[50%] truncate text-right font-mono text-sm tabular-nums">
					{amount}
				</span>
			)}
		</div>
	);
}
