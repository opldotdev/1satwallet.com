"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * One narrow column for a sweep screen with the screen's actions in a footer
 * that never needs scrolling to reach.
 *
 * `page`: on phones the footer is fixed to the bottom of the screen, clear
 * of the home indicator, with a spacer of its measured height so nothing
 * hides under it; from sm it is sticky at the bottom of the viewport.
 * `dialog`: for the full-screen first-run wizard; the column fills the
 * dialog's scroll container and the footer sticks to its bottom (the dialog
 * pads the safe area itself).
 */
export function SweepShell({
	children,
	footer,
	variant = "page",
	className,
}: {
	children: ReactNode;
	footer?: ReactNode;
	variant?: "page" | "dialog";
	className?: string;
}) {
	const footerRef = useRef<HTMLDivElement>(null);
	const [footerHeight, setFooterHeight] = useState(0);

	useEffect(() => {
		const el = footerRef.current;
		if (!el || variant !== "page") return;
		const observer = new ResizeObserver(() => setFooterHeight(el.offsetHeight));
		observer.observe(el);
		return () => observer.disconnect();
	}, [variant]);

	return (
		<div
			data-slot="sweep-shell"
			className={cn(
				"mx-auto flex w-full max-w-lg flex-col",
				variant === "dialog" && "min-h-full flex-1",
				className,
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-5 pb-4">{children}</div>
			{footer && (
				<>
					<div
						ref={footerRef}
						data-slot="sweep-footer"
						className={cn(
							"sticky bottom-0 z-30 flex flex-col gap-2 border-t pt-3",
							variant === "page"
								? "bg-background/95 pb-[max(--spacing(3),env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/80 max-sm:fixed max-sm:inset-x-0 max-sm:pr-[max(--spacing(4),env(safe-area-inset-right))] max-sm:pl-[max(--spacing(4),env(safe-area-inset-left))]"
								: "bg-background pb-4 sm:bg-card",
						)}
					>
						{footer}
					</div>
					{variant === "page" && (
						<div
							aria-hidden="true"
							className="sm:hidden"
							style={{ height: footerHeight }}
						/>
					)}
				</>
			)}
		</div>
	);
}

/** Footer buttons: a quiet one beside the primary, or stacked when long. */
export function SweepFooterRow({
	children,
	stack = false,
}: {
	children: ReactNode;
	stack?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex gap-2",
				stack ? "flex-col-reverse sm:flex-row sm:justify-end" : "flex-row",
			)}
		>
			{children}
		</div>
	);
}
