import { Badge } from "@/components/ui/badge";

const LABEL = "Testnet account. Coins have no real value.";

/** The one testnet chip, so the header, settings and import preview match. */
export function TestnetBadge({ className }: { className?: string }) {
	return (
		<Badge
			aria-label={LABEL}
			className={className}
			title={LABEL}
			variant="outline"
		>
			Testnet
		</Badge>
	);
}
