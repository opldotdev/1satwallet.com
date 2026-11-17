"use client";

import type * as React from "react";
import { useEffect, useRef } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

/**
 * One step of creating or importing a wallet: a single card with the step
 * count, a title, the step's content and its actions. On phones the actions
 * stack full width with the primary on top; from sm they sit on one line at
 * the right, primary last. Pass `form` to make content and actions one form
 * (the form is `display: contents`, so the card's spacing still applies).
 */
export function OnboardingStep({
	step,
	total,
	title,
	description,
	children,
	actions,
	form,
}: {
	step: number;
	total: number;
	title: React.ReactNode;
	description?: React.ReactNode;
	children: React.ReactNode;
	/** Buttons, primary last. */
	actions?: React.ReactNode;
	form?: Omit<React.ComponentProps<"form">, "className" | "children">;
}) {
	// Each step is its own page: take focus to its heading, so keyboard and
	// screen-reader users land on the new step instead of the old button.
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		headingRef.current?.focus({ preventScroll: true });
	}, []);
	const body = (
		<>
			<CardContent>{children}</CardContent>
			{actions && (
				<CardFooter
					data-slot="onboarding-actions"
					className="flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end [&>*]:w-full sm:[&>*]:w-auto"
				>
					{actions}
				</CardFooter>
			)}
		</>
	);
	return (
		<Card className="mx-auto w-full max-w-2xl">
			<CardHeader>
				<p className="text-muted-foreground text-xs font-medium">
					Step {step} of {total}
				</p>
				<CardTitle>
					<h2
						ref={headingRef}
						tabIndex={-1}
						className="rounded-sm text-lg leading-tight font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
					>
						{title}
					</h2>
				</CardTitle>
				{description && <CardDescription>{description}</CardDescription>}
			</CardHeader>
			{form ? (
				<form {...form} className="contents">
					{body}
				</form>
			) : (
				body
			)}
		</Card>
	);
}
