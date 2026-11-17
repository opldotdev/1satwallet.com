import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";

/**
 * A titled group of settings rows in one card, rows split by a hairline.
 */
export function SettingsGroup({
	title,
	description,
	danger = false,
	children,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	/** Irreversible settings: the card takes a destructive border. */
	danger?: boolean;
	children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<SectionHeader title={title} description={description} />
			<Card className={cn(danger && "border-destructive/50")}>
				<CardContent className="flex flex-col divide-y">{children}</CardContent>
			</Card>
		</section>
	);
}

/**
 * One setting: a 20px icon, its title and description, and its control.
 * `control` is a switch, badge or short value that stays at the row's end.
 * `action` is a button or select: full width under the text on phones,
 * 160px at the row's end from sm.
 */
export function SettingsRow({
	icon: Icon,
	title,
	description,
	htmlFor,
	control,
	action,
	children,
}: {
	icon: LucideIcon;
	title?: React.ReactNode;
	description?: React.ReactNode;
	/** The id of the control the title labels. */
	htmlFor?: string;
	control?: React.ReactNode;
	action?: React.ReactNode;
	/** Replaces the title and description, for a row that renders its own. */
	children?: React.ReactNode;
}) {
	const Title = htmlFor ? "label" : "p";
	return (
		<div
			data-slot="settings-row"
			className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
		>
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<Icon
					aria-hidden="true"
					className="mt-0.5 size-5 shrink-0 text-muted-foreground"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					{children ?? (
						<>
							<Title className="text-sm font-medium" htmlFor={htmlFor}>
								{title}
							</Title>
							{description && (
								<p className="text-muted-foreground text-sm">{description}</p>
							)}
						</>
					)}
				</div>
				{control && (
					<div className="flex min-h-5 shrink-0 items-center self-center">
						{control}
					</div>
				)}
			</div>
			{action && (
				<div className="w-full shrink-0 sm:w-40 [&>*]:w-full">{action}</div>
			)}
		</div>
	);
}
