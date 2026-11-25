"use client";

import { ChevronRight, Coins } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useSound } from "@/hooks/use-sound";
import { cn } from "@/lib/utils";

/**
 * A token's icon, else a coin, in a rounded tile: 40px in a row, 64 on its
 * wallet page, 80 on its market page. An icon that fails to load is logged
 * and replaced by the coin.
 */
export function TokenIcon({
	icon,
	size,
}: {
	icon: string | undefined;
	size: 40 | 64 | 80;
}) {
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const showImage = Boolean(icon) && failedSrc !== icon;
	return (
		<div
			data-slot="token-icon"
			data-icon-src={icon || undefined}
			className={cn(
				"relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted",
				size === 80
					? "size-20 border"
					: size === 64
						? "size-16 border"
						: "size-10",
			)}
		>
			{icon && showImage ? (
				<Image
					src={icon}
					alt=""
					fill
					sizes={`${size}px`}
					className="object-cover"
					unoptimized
					onError={() => {
						console.error("[token-icon] image failed to load", { src: icon });
						setFailedSrc(icon);
					}}
				/>
			) : (
				<Coins
					aria-hidden="true"
					data-testid={icon ? "token-icon-failed" : "token-icon-none"}
					className={cn(
						"text-muted-foreground",
						size === 40 ? "size-5" : "size-8",
					)}
				/>
			)}
		</div>
	);
}

/**
 * One token in a list: a 64px link to its page with the icon, ticker, a
 * caption, the balance and a chevron. Actions live on the token's page.
 */
export function TokenRow({
	href,
	icon,
	ticker,
	caption,
	amount,
	badge,
}: {
	href: string;
	icon: string | undefined;
	ticker: string;
	/** One muted line under the ticker: pending amount or the short id. */
	caption: string;
	/** The spendable balance, formatted. */
	amount: string;
	/** A chip beside the ticker, such as a mint authority. */
	badge?: ReactNode;
}) {
	const { play } = useSound();
	return (
		<li>
			<Link
				className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				data-slot="token-row"
				href={href}
				onClick={() => play("click")}
			>
				<TokenIcon icon={icon} size={40} />
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<span className="truncate font-medium">{ticker}</span>
						{badge}
					</div>
					<p className="truncate text-muted-foreground text-xs">{caption}</p>
				</div>
				<span className="max-w-[40%] truncate text-right font-mono text-sm tabular-nums">
					{amount}
				</span>
				<ChevronRight
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
			</Link>
		</li>
	);
}

/** The rows of a token list, bordered as one card. */
export function TokenList({ children }: { children: ReactNode }) {
	return (
		<ul className="divide-y overflow-hidden rounded-xl border bg-card">
			{children}
		</ul>
	);
}

const SKELETON_ROWS = ["first", "second"] as const;

/** Loading rows, the height of real ones. */
export function TokenRowsSkeleton() {
	return (
		<div
			aria-live="polite"
			className="divide-y overflow-hidden rounded-xl border"
			role="status"
		>
			<span className="sr-only">Loading tokens…</span>
			{SKELETON_ROWS.map((row) => (
				<div key={row} className="flex min-h-16 items-center gap-3 px-4 py-3">
					<Skeleton className="size-10 rounded-lg" />
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-3 w-16" />
					</div>
					<Skeleton className="h-4 w-16" />
				</div>
			))}
		</div>
	);
}

/**
 * One standard's group in the Tokens section: a quiet heading ("BSV-21",
 * "1Color"), an optional control beside it, then its rows.
 */
export function TokenGroup({
	id,
	title,
	action,
	children,
}: {
	id: string;
	title: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-labelledby={id} className="flex flex-col gap-3">
			<div className="flex min-h-11 items-center justify-between gap-3">
				<h2 className="font-medium text-muted-foreground text-sm" id={id}>
					{title}
				</h2>
				{action ? (
					<div className="flex shrink-0 items-center gap-2">{action}</div>
				) : null}
			</div>
			{children}
		</section>
	);
}
