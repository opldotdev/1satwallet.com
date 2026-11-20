"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSound } from "@/hooks/use-sound";
import { walletHandlesQueryKey } from "@/hooks/use-wallet-handles";
import { endpointsOf } from "@/lib/chain-endpoints";
import {
	allowsRegistration,
	availabilityMessage,
	checkHandleAvailability,
	type HandleAvailability,
	HandleRegistrationError,
	normalizeHandleUsername,
	registerHandle,
} from "@/lib/wallet/handle-registration";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/**
 * Register a handle at this chain's handle domain, in the built-in wallet
 * (iOS Settings > Identity). Check first, then Register: a handle is
 * permanent and one per account. The registration site stays linked.
 */
export function RegisterHandle() {
	const { wallet, chain, identityKey, connectionMode } = useWalletToolbox();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const [name, setName] = useState("");
	const [checked, setChecked] = useState<{
		name: string;
		availability: HandleAvailability;
	} | null>(null);
	const [busy, setBusy] = useState<"check" | "register" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const inFlight = useRef(false);
	const { handleDomain, handleRegistration } = endpointsOf(chain);
	const builtIn = connectionMode === "built-in" && !!wallet && !!identityKey;
	const current =
		checked && checked.name === normalizeHandleUsername(name)
			? checked.availability
			: null;

	const check = async () => {
		if (!identityKey || inFlight.current) return;
		inFlight.current = true;
		setBusy("check");
		setError(null);
		const availability = await checkHandleAvailability(
			name,
			chain,
			identityKey,
		);
		setChecked({ name: normalizeHandleUsername(name) ?? name, availability });
		setBusy(null);
		inFlight.current = false;
	};

	const register = async () => {
		if (!wallet || !identityKey || inFlight.current) return;
		inFlight.current = true;
		setBusy("register");
		setError(null);
		try {
			await registerHandle(name, { wallet, chain, identityKey });
			play("success");
			setName("");
			setChecked(null);
			await queryClient.invalidateQueries({
				queryKey: walletHandlesQueryKey(chain, identityKey),
			});
		} catch (caught) {
			console.error("[handles] registration failed", { chain, error: caught });
			setError(
				caught instanceof HandleRegistrationError
					? caught.message
					: "The handle couldn't be registered. Try again.",
			);
			play("error");
		} finally {
			setBusy(null);
			inFlight.current = false;
		}
	};

	return (
		<div className="space-y-3 text-sm">
			{builtIn ? (
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						void (current && allowsRegistration(current)
							? register()
							: check());
					}}
				>
					<Label htmlFor="register-handle-name">Pick a handle</Label>
					<div className="flex items-center gap-2">
						<Input
							aria-describedby="register-handle-status"
							autoCapitalize="none"
							autoComplete="off"
							disabled={busy !== null}
							id="register-handle-name"
							onChange={(event) => setName(event.target.value)}
							placeholder="name"
							spellCheck={false}
							value={name}
						/>
						<span className="shrink-0 font-mono text-muted-foreground">
							@{handleDomain}
						</span>
					</div>
					<p
						className={
							current?.kind === "taken" || current?.kind === "invalid"
								? "text-destructive text-xs"
								: "text-muted-foreground text-xs"
						}
						id="register-handle-status"
						role="status"
					>
						{current
							? availabilityMessage(current)
							: "A handle is permanent, and an account has one."}
					</p>
					{error ? (
						<p className="text-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={busy !== null || !name.trim()}
							onClick={() => void check()}
							type="button"
							variant="outline"
						>
							{busy === "check" ? (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							) : null}
							Check
						</Button>
						<Button
							disabled={busy !== null || !allowsRegistration(current)}
							type="submit"
						>
							{busy === "register" ? (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							) : null}
							Register
						</Button>
					</div>
				</form>
			) : null}
			<Button asChild variant="ghost">
				<a href={handleRegistration} rel="noopener noreferrer" target="_blank">
					Register on the handle site <ExternalLink data-icon="inline-end" />
				</a>
			</Button>
		</div>
	);
}
