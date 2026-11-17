import { Check, KeyRound, Lock, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./sweep-route-diagram.module.css";

export type SweepRouteState = "idle" | "moving" | "blocked" | "done";

function Endpoint({
	icon,
	label,
	tone,
}: {
	icon: ReactNode;
	label: string;
	tone: "from" | "to" | "done" | "muted";
}) {
	return (
		<div className="flex w-20 shrink-0 flex-col items-center gap-2 text-center">
			<div
				className={cn(
					"relative flex size-12 items-center justify-center rounded-2xl border bg-background [&>svg]:size-5",
					tone === "to" && "border-primary/40 text-primary",
					tone === "done" && "border-success/40 text-success",
					tone === "from" && "text-foreground",
					tone === "muted" && "text-muted-foreground opacity-60",
				)}
			>
				{icon}
			</div>
			<span className="text-muted-foreground text-xs leading-tight">
				{label}
			</span>
		</div>
	);
}

/**
 * Where things go: the old addresses on the left, this wallet on the right,
 * and a line between that moves ("idle" gently, "moving" fast), stops at a
 * lock ("blocked") or draws solid ("done"). The payload sits under it.
 */
export function SweepRouteDiagram({
	fromLabel = "Old addresses",
	toLabel = "This wallet",
	payload,
	state = "idle",
	className,
}: {
	fromLabel?: string;
	toLabel?: string;
	payload?: ReactNode;
	state?: SweepRouteState;
	className?: string;
}) {
	const blocked = state === "blocked";
	return (
		<figure
			data-slot="sweep-route-diagram"
			className={cn(
				"flex flex-col items-center gap-4 rounded-xl border bg-card px-4 py-5",
				className,
			)}
		>
			<div className="flex w-full items-start gap-2">
				<Endpoint
					icon={<KeyRound aria-hidden="true" />}
					label={fromLabel}
					tone="from"
				/>
				<div className={cn(styles.track, "mt-3")} data-state={state}>
					<svg
						className={styles.line}
						viewBox="0 0 100 24"
						preserveAspectRatio="none"
						aria-hidden="true"
						focusable="false"
					>
						<line
							className={styles.dash}
							x1="2"
							y1="12"
							x2={blocked ? 46 : 96}
							y2="12"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeDasharray={state === "done" ? undefined : "6 6"}
							vectorEffect="non-scaling-stroke"
						/>
						{blocked && (
							<line
								x1="54"
								y1="12"
								x2="96"
								y2="12"
								stroke="currentColor"
								strokeWidth="2"
								strokeDasharray="2 6"
								strokeLinecap="round"
								opacity="0.35"
								vectorEffect="non-scaling-stroke"
							/>
						)}
					</svg>
					{!blocked && state !== "done" && <span className={styles.dot} />}
					{blocked && (
						<span className="absolute top-1/2 left-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-warning">
							<Lock aria-hidden="true" className="size-3.5" />
						</span>
					)}
				</div>
				<Endpoint
					icon={
						<>
							<Wallet aria-hidden="true" />
							{state === "done" && (
								<span className="absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full bg-success text-background">
									<Check
										aria-hidden="true"
										className="size-3"
										strokeWidth={3}
									/>
								</span>
							)}
						</>
					}
					label={toLabel}
					tone={state === "done" ? "done" : blocked ? "muted" : "to"}
				/>
			</div>
			{payload && (
				<figcaption className="flex w-full min-w-0 flex-col items-center gap-1 text-center">
					{payload}
				</figcaption>
			)}
		</figure>
	);
}
