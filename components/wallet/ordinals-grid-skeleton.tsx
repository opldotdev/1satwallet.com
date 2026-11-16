import { Skeleton } from "@/components/ui/skeleton";

/** The Ordinals section while it loads: count, Refresh and the tiles. */
export function OrdinalsGridSkeleton() {
	return (
		<div
			className="flex flex-col gap-4"
			aria-label="Loading ordinals"
			role="status"
		>
			<div className="flex items-center justify-between gap-4">
				<Skeleton className="h-6 w-28" />
				<Skeleton className="size-9 max-md:size-11" />
			</div>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
				{["one", "two", "three", "four", "five", "six"].map((id) => (
					<Skeleton className="aspect-square rounded-xl" key={id} />
				))}
			</div>
			<span className="sr-only">Loading wallet ordinals</span>
		</div>
	);
}
