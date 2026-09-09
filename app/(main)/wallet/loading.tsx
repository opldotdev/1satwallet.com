import { Skeleton } from "@/components/ui/skeleton";
export default function WalletLoading() {
	return (
		<div className="min-h-80 space-y-8 py-8" role="status" aria-live="polite">
			<span className="sr-only">Loading wallet…</span>
			<Skeleton className="h-4 w-32" />
			<Skeleton className="h-14 w-64 max-w-full" />
			<Skeleton className="h-10 w-48" />
		</div>
	);
}
