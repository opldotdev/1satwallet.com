import { cn } from "@/lib/utils";

interface PageProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Page({ children, className, ...props }: PageProps) {
	return (
		<div
			className={cn(
				"mx-auto flex w-full min-w-0 max-w-[1320px] flex-col gap-6",
				// Gutters step 16/24/32 by breakpoint. The safe-area insets are
				// already padded by the shell (dual-sidebar-layout), so they are
				// not added again here.
				"[--page-x:--spacing(4)] [--page-y:--spacing(5)] md:[--page-x:--spacing(6)] md:[--page-y:--spacing(6)] xl:[--page-x:--spacing(8)] xl:[--page-y:--spacing(7)]",
				"px-(--page-x) py-(--page-y)",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

export function PageHeader({ children, className, ...props }: PageProps) {
	return (
		<div
			className={cn("flex items-center justify-between gap-4", className)}
			{...props}
		>
			{children}
		</div>
	);
}

export function PageTitle({
	children,
	className,
	...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h1
			className={cn(
				"font-sans text-2xl font-semibold tracking-tight md:text-3xl",
				className,
			)}
			{...props}
		>
			{children}
		</h1>
	);
}

export function PageContent({ children, className, ...props }: PageProps) {
	return (
		<div className={cn("w-full", className)} {...props}>
			{children}
		</div>
	);
}
