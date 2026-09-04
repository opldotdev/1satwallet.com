import {
	Page,
	PageContent,
	PageHeader,
	PageTitle,
} from "@/components/page-layout";
import { Skeleton } from "@/components/ui/skeleton";

export default function WalletLoading() {
	return (
		<Page>
			<PageHeader className="flex-wrap gap-3">
				<div>
					<PageTitle>Wallet</PageTitle>
					<Skeleton aria-hidden="true" className="mt-1 h-4 w-72" />
				</div>
				<Skeleton aria-hidden="true" className="h-6 w-36 rounded-full" />
			</PageHeader>
			<PageContent className="space-y-6">
				<div aria-live="polite" role="status">
					<span className="sr-only">Loading wallet…</span>
					<div aria-hidden="true" className="space-y-6">
						<Skeleton className="h-9 w-full rounded-md" />
						<div className="space-y-3 rounded-xl border p-6">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-10 w-60" />
							<Skeleton className="h-4 w-28" />
						</div>
						<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
							<Skeleton className="h-32 rounded-xl" />
							<Skeleton className="h-32 rounded-xl" />
							<Skeleton className="h-32 rounded-xl" />
							<Skeleton className="h-32 rounded-xl" />
							<Skeleton className="h-32 rounded-xl" />
						</div>
						<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
							<Skeleton className="h-36 rounded-xl" />
							<Skeleton className="h-36 rounded-xl" />
						</div>
					</div>
				</div>
			</PageContent>
		</Page>
	);
}
