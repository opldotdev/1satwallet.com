import { cn } from "@/lib/utils";

interface PageProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Page({ children, className, ...props }: PageProps) {
	return (
		<div
			className={cn(
				"mx-auto flex w-full min-w-0 max-w-[1320px] flex-col gap-6 px-4 py-5 md:p-6 xl:px-8 xl:py-7",
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
			className={cn("flex items-center justify-between", className)}
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
				"font-mono text-3xl font-semibold tracking-tight",
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
