"use client";

import { Info } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SweepShell } from "./sweep-shell";
import { SweepStepIndicator } from "./sweep-step-indicator";

/**
 * The frame every sweep screen shares: the step indicator and the info
 * button that opens Details, a headline that takes focus when the step
 * changes, the step's body sliding in from the side it came from, and the
 * pinned footer. Enter on the frame runs the primary action.
 */
export function SweepWizard({
	variant = "page",
	stepKey,
	direction = "forward",
	indicator,
	title,
	description,
	onInfo,
	onEnter,
	children,
	footer,
}: {
	variant?: "page" | "dialog";
	/** Changes when the step changes: re-runs the entrance and moves focus. */
	stepKey: string;
	direction?: "forward" | "back";
	/** Shown on the choice steps only, not on scan, progress or done. */
	indicator?: { index: number; total: number };
	title: ReactNode;
	description?: ReactNode;
	onInfo: () => void;
	onEnter?: () => void;
	children?: ReactNode;
	footer?: ReactNode;
}) {
	const headingRef = useRef<HTMLHeadingElement>(null);
	const firstKey = useRef(stepKey);

	useEffect(() => {
		// The first screen keeps the page's own focus; later ones take it.
		if (stepKey === firstKey.current) return;
		firstKey.current = "";
		headingRef.current?.focus({ preventScroll: false });
	}, [stepKey]);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Enter" || !onEnter) return;
		const target = event.target as HTMLElement;
		if (target.closest("button, a, input, textarea, select, [role='switch']"))
			return;
		event.preventDefault();
		onEnter();
	};

	return (
		<SweepShell variant={variant} footer={footer}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Enter runs the step's primary action */}
			<div className="flex flex-col gap-5" onKeyDown={handleKeyDown}>
				<div className="flex min-h-11 items-center gap-3">
					{indicator ? (
						<SweepStepIndicator
							index={indicator.index}
							total={indicator.total}
						/>
					) : (
						<span className="flex-1" />
					)}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="-mr-2 shrink-0 text-muted-foreground"
						aria-label="How the sweep works"
						title="How the sweep works"
						onClick={onInfo}
					>
						<Info aria-hidden="true" />
					</Button>
				</div>
				<div
					key={stepKey}
					className={cn(
						"flex flex-col gap-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
						direction === "back"
							? "motion-safe:slide-in-from-left-4"
							: "motion-safe:slide-in-from-right-4",
					)}
				>
					<div className="flex flex-col gap-1.5">
						<h2
							ref={headingRef}
							tabIndex={-1}
							className="text-balance font-semibold text-2xl tracking-tight outline-none"
						>
							{title}
						</h2>
						{description && (
							<p className="text-pretty text-muted-foreground text-sm">
								{description}
							</p>
						)}
					</div>
					{children}
				</div>
			</div>
		</SweepShell>
	);
}
