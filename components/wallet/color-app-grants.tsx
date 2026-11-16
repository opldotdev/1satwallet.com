"use client";

import type { StoredGrant } from "@1sat/wallet-browser";
import { Coins, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { colorGrantLabel, colorPermissionStore } from "@/lib/cwi/color-consent";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

type BasketGrant = StoredGrant & {
	key: Extract<StoredGrant["key"], { type: "basket" }>;
};

const grantId = (grant: BasketGrant) =>
	`${grant.key.originator}\n${grant.key.basket}`;

const logFailure = (operation: string, error: unknown) => {
	const event = reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.color-consent.${operation}`,
		recoverable: true,
		context: { retryable: true },
	});
	console.error(`[wallet] 1Color grants: ${operation} failed`, {
		correlationId: event.correlationId,
		error,
	});
};

/**
 * The 1Color basket grants apps were given (testnet, built-in wallet only),
 * with revoke. Sends, signatures and label reads keep no grant: they are
 * asked every time, so they never show here.
 */
export function ColorAppGrants() {
	const { chain, colorContext } = useWalletToolbox();
	const enabled = colorContext !== null && isOneColorAvailable(chain);
	const [grants, setGrants] = useState<BasketGrant[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!enabled) {
			setGrants([]);
			setLoadError(null);
			return;
		}
		try {
			const listed = await colorPermissionStore(chain).listGrants({
				type: "basket",
			});
			setGrants(
				listed
					.filter((grant): grant is BasketGrant => grant.key.type === "basket")
					.sort(
						(a, b) =>
							a.key.originator.localeCompare(b.key.originator) ||
							a.key.basket.localeCompare(b.key.basket),
					),
			);
			setLoadError(null);
		} catch (error) {
			logFailure("list", error);
			setGrants([]);
			setLoadError("Could not load 1Color token access. Try again.");
		}
	}, [enabled, chain]);

	useEffect(() => {
		void load();
	}, [load]);

	const revoke = async (grant: BasketGrant) => {
		const id = grantId(grant);
		setRevoking(id);
		try {
			await colorPermissionStore(chain).deleteGrant(grant.key);
			await load();
		} catch (error) {
			logFailure("revoke", error);
			toast.error("Could not revoke this 1Color access. Try again.");
		} finally {
			setRevoking(null);
		}
	};

	if (!enabled || (grants.length === 0 && !loadError)) return null;

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-sm">1Color token access</CardTitle>
				<CardDescription>
					Apps allowed to read your 1Color tokens on testnet. Sends and
					signatures are asked every time.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-2">
				{loadError ? (
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm text-destructive">{loadError}</span>
						<Button variant="outline" size="sm" onClick={() => void load()}>
							Try again
						</Button>
					</div>
				) : (
					grants.map((grant) => {
						const id = grantId(grant);
						const label = colorGrantLabel(grant.key.basket);
						return (
							<div
								key={id}
								className="flex items-center justify-between gap-2 py-2 border-b last:border-0"
							>
								<div className="flex items-center gap-2 min-w-0">
									<Coins className="h-4 w-4 shrink-0" />
									<div className="min-w-0">
										<div className="text-sm font-mono truncate">
											{grant.key.originator}
										</div>
										<div
											className="text-xs text-muted-foreground truncate"
											title={grant.key.basket}
										>
											{label}
										</div>
									</div>
								</div>
								<Button
									variant="ghost"
									size="icon"
									className="shrink-0 text-destructive hover:text-destructive"
									aria-label={
										revoking === id
											? `Revoking ${label} access for ${grant.key.originator}`
											: `Revoke ${label} access for ${grant.key.originator}`
									}
									disabled={revoking === id}
									onClick={() => void revoke(grant)}
								>
									{revoking === id ? (
										<Loader2 className="h-4 w-4 animate-spin" />
									) : (
										<Trash2 className="h-4 w-4" />
									)}
								</Button>
							</div>
						);
					})
				)}
			</CardContent>
		</Card>
	);
}
