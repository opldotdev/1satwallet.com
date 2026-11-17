"use client";

import {
	CheckCircle,
	ExternalLink,
	Loader2,
	Shield,
	XCircle,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { isValidRedirectMethod } from "@/lib/cwi/redirect-utils";
import { redirectOriginator, toCWIErrorFields } from "@/lib/cwi/types";
import { clipForLog } from "@/lib/runtime-diagnostics";
import { useWallet, WalletSaveError } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

interface PendingAuthRequest {
	requestId: string;
	origin: string;
	redirectUri: string;
	call: string;
	args: unknown;
	status: string;
	expiresAt: number;
	createdAt: number;
}

interface CompleteResponse {
	redirectUrl: string;
	decision: "approved" | "denied" | "error";
}

const jsonPreview = (value: unknown): string => {
	try {
		const serialized = JSON.stringify(value, null, 2);
		if (!serialized) return "{}";
		if (serialized.length <= 1200) return serialized;
		return `${serialized.slice(0, 1200)}\n...`;
	} catch {
		return "[unserializable args]";
	}
};

function AuthorizeContent() {
	const searchParams = useSearchParams();
	const requestId = searchParams.get("requestId");
	const { hasWallet, isWalletLocked, unlockWallet } = useWallet();
	const { permissionsManager, isInitialized, isInitializing } =
		useWalletToolbox();

	const [requestData, setRequestData] = useState<PendingAuthRequest | null>(
		null,
	);
	const [isLoadingRequest, setIsLoadingRequest] = useState(true);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [passphrase, setPassphrase] = useState("");
	const [unlockError, setUnlockError] = useState<string | null>(null);
	const [isUnlocking, setIsUnlocking] = useState(false);

	const isExpired = useMemo(
		() => (requestData ? requestData.expiresAt <= Date.now() : false),
		[requestData],
	);

	useEffect(() => {
		if (!requestId) {
			setRequestError("Missing request id.");
			setIsLoadingRequest(false);
			return;
		}

		let cancelled = false;
		const loadRequest = async () => {
			setIsLoadingRequest(true);
			setRequestError(null);
			try {
				const response = await fetch(
					`/api/cwi/authorize/request?requestId=${encodeURIComponent(requestId)}`,
					{
						method: "GET",
						cache: "no-store",
					},
				);
				const data = (await response.json()) as
					| PendingAuthRequest
					| { error?: string };
				if (!response.ok) {
					throw new Error(
						(data as { error?: string }).error ??
							"Failed to load authorization request.",
					);
				}
				if (cancelled) return;
				setRequestData(data as PendingAuthRequest);
			} catch (error) {
				if (cancelled) return;
				console.error("[cwi] could not load the authorization request", {
					requestId,
					error,
				});
				setRequestError(
					"The request couldn't be loaded. It may have expired; start again from the app.",
				);
			} finally {
				if (!cancelled) {
					setIsLoadingRequest(false);
				}
			}
		};

		void loadRequest();
		return () => {
			cancelled = true;
		};
	}, [requestId]);

	const completeAuthorization = useCallback(
		async (body: {
			requestId: string;
			decision: "approved" | "denied" | "error";
			result?: unknown;
			error?: string;
			error_description?: string;
			error_code?: number;
			error_stack?: string;
		}) => {
			const response = await fetch("/api/cwi/authorize/complete", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			const data = (await response.json()) as
				| CompleteResponse
				| { error?: string };
			if (!response.ok) {
				throw new Error(
					(data as { error?: string }).error ?? "completion_failed",
				);
			}
			return data as CompleteResponse;
		},
		[],
	);

	const executeRequestedCall = useCallback(async () => {
		if (!requestData) {
			throw new Error("authorization_request_missing");
		}
		if (!isValidRedirectMethod(requestData.call)) {
			throw new Error("unknown_method");
		}
		if (!permissionsManager) {
			throw new Error("wallet_permissions_manager_not_ready");
		}
		// The app's hostname, as the relay passes it; never the wallet's own.
		const originator = redirectOriginator(
			requestData.origin,
			window.location.host,
		);
		if (!originator) {
			console.error("[cwi] refused a redirect request from a non-app origin", {
				requestId: requestData.requestId,
				origin: clipForLog(requestData.origin),
			});
			throw new Error("origin_not_an_app");
		}

		const permissionsRecord = permissionsManager as unknown as Record<
			string,
			unknown
		>;
		const method = permissionsRecord[requestData.call];
		if (typeof method !== "function") {
			throw new Error("method_not_callable");
		}

		return await (
			method as (args: unknown, originator: string) => Promise<unknown>
		).call(permissionsManager, requestData.args ?? {}, originator);
	}, [requestData, permissionsManager]);

	const redirectToCallback = useCallback((redirectUrl: string) => {
		window.location.assign(redirectUrl);
	}, []);

	const handleApprove = useCallback(async () => {
		if (!requestData) return;
		setIsSubmitting(true);
		setRequestError(null);
		try {
			const result = await executeRequestedCall();
			const completion = await completeAuthorization({
				requestId: requestData.requestId,
				decision: "approved",
				result,
			});
			redirectToCallback(completion.redirectUrl);
		} catch (error) {
			console.error("[cwi] requested call failed", {
				requestId: requestData.requestId,
				error,
			});
			const wireError = toCWIErrorFields(
				error,
				process.env.NODE_ENV !== "production",
			);
			try {
				const completion = await completeAuthorization({
					requestId: requestData.requestId,
					decision: "error",
					error: "wallet_execution_failed",
					error_description: wireError.description,
					error_code: wireError.code,
					error_stack: wireError.stack,
				});
				redirectToCallback(completion.redirectUrl);
			} catch (completionError) {
				console.error("[cwi] could not report a failed call to the app", {
					requestId: requestData.requestId,
					error: completionError,
				});
				setRequestError(wireError.description);
				setIsSubmitting(false);
			}
		}
	}, [
		requestData,
		executeRequestedCall,
		completeAuthorization,
		redirectToCallback,
	]);

	const handleDeny = useCallback(async () => {
		if (!requestData) return;
		setIsSubmitting(true);
		setRequestError(null);
		try {
			const completion = await completeAuthorization({
				requestId: requestData.requestId,
				decision: "denied",
				error: "access_denied",
				error_description: "The user denied the request.",
			});
			redirectToCallback(completion.redirectUrl);
		} catch (error) {
			console.error("[cwi] could not send the denial", {
				requestId: requestData.requestId,
				error,
			});
			setRequestError("Couldn't send the denial. Try again.");
			setIsSubmitting(false);
		}
	}, [requestData, completeAuthorization, redirectToCallback]);

	const handleUnlock = useCallback(
		async (event: React.FormEvent) => {
			event.preventDefault();
			if (isUnlocking) return;
			setIsUnlocking(true);
			setUnlockError(null);
			try {
				const success = await unlockWallet(passphrase);
				if (!success) {
					setUnlockError("Invalid passphrase");
				}
			} catch (error) {
				setUnlockError(
					error instanceof WalletSaveError
						? error.message
						: "Unable to unlock wallet. Please try again.",
				);
			} finally {
				setPassphrase("");
				setIsUnlocking(false);
			}
		},
		[isUnlocking, passphrase, unlockWallet],
	);

	if (isLoadingRequest) {
		return (
			<StatusScreen
				icon={<Loader2 className="animate-spin text-primary" />}
				title="Loading authorization request"
			/>
		);
	}

	if (!requestData) {
		return (
			<StatusScreen
				icon={<XCircle className="text-destructive" />}
				title="Authorization request unavailable"
			>
				{requestError ?? "The request could not be loaded."}
			</StatusScreen>
		);
	}

	if (isExpired || requestData.status !== "pending") {
		return (
			<StatusScreen
				icon={<XCircle className="text-destructive" />}
				title="Authorization request is no longer active"
			>
				Status: {requestData.status}
			</StatusScreen>
		);
	}

	if (!hasWallet) {
		return (
			<StatusScreen
				icon={<XCircle className="text-destructive" />}
				title="No wallet available"
			>
				Create or import a wallet before authorizing requests.
			</StatusScreen>
		);
	}

	if (isWalletLocked) {
		return (
			<AuthorizeScreen>
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<Shield className="mx-auto size-10 text-primary" />
						<CardTitle>Unlock wallet</CardTitle>
					</CardHeader>
					<CardContent>
						<form onSubmit={handleUnlock} className="flex flex-col gap-4">
							<Input
								aria-label="Passphrase"
								autoComplete="current-password"
								type="password"
								value={passphrase}
								onChange={(event) => setPassphrase(event.target.value)}
								placeholder="Passphrase"
								required
								disabled={isUnlocking}
								aria-invalid={unlockError ? true : undefined}
								aria-describedby={unlockError ? "cwi-unlock-error" : undefined}
							/>
							{unlockError && (
								<p
									id="cwi-unlock-error"
									aria-live="polite"
									className="text-sm text-destructive"
									role="alert"
								>
									{unlockError}
								</p>
							)}
							<Button type="submit" className="w-full" disabled={isUnlocking}>
								{isUnlocking ? (
									<>
										<Loader2
											className="animate-spin"
											data-icon="inline-start"
										/>
										Unlocking…
									</>
								) : (
									"Unlock"
								)}
							</Button>
						</form>
					</CardContent>
				</Card>
			</AuthorizeScreen>
		);
	}

	if (!isInitialized || isInitializing || !permissionsManager) {
		return (
			<StatusScreen
				icon={<Loader2 className="animate-spin text-primary" />}
				title="Preparing wallet authorization"
			>
				Waiting for wallet services to initialize.
			</StatusScreen>
		);
	}

	return (
		<AuthorizeScreen>
			<Card className="w-full max-w-lg">
				<CardHeader className="text-center">
					<CheckCircle className="mx-auto size-10 text-primary" />
					<CardTitle>Authorize wallet request</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<DetailList>
						<DetailRow label="Requesting origin" mono={false} stack>
							<span className="flex items-center gap-1">
								<ExternalLink aria-hidden="true" className="size-3 shrink-0" />
								{requestData.origin}
							</span>
						</DetailRow>
						<DetailRow label="Method">{requestData.call}</DetailRow>
						<DetailRow label="Args" stack>
							<pre className="max-w-full overflow-x-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap break-all">
								{jsonPreview(requestData.args)}
							</pre>
						</DetailRow>
					</DetailList>
					{requestError && <Notice tone="danger">{requestError}</Notice>}
				</CardContent>
				{/* On phones the decision stays in reach at the bottom of the
				    screen, clear of the home indicator. */}
				<CardFooter className="gap-3 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:border-t max-sm:bg-card max-sm:pt-3 max-sm:pb-[max(--spacing(3),env(safe-area-inset-bottom))]">
					<Button
						variant="outline"
						className="flex-1"
						onClick={handleDeny}
						disabled={isSubmitting}
					>
						Deny
					</Button>
					<Button
						className="flex-1"
						onClick={handleApprove}
						disabled={isSubmitting}
					>
						{isSubmitting ? (
							<Loader2 className="animate-spin" data-icon="inline-start" />
						) : (
							<CheckCircle data-icon="inline-start" />
						)}
						Allow
					</Button>
				</CardFooter>
			</Card>
		</AuthorizeScreen>
	);
}

/**
 * The card sits under the wallet header: at the top on phones, where any
 * extra height would only push the page past the screen, and centered in
 * most of the remaining height from sm.
 */
function AuthorizeScreen({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-start justify-center sm:min-h-[60dvh] sm:items-center">
			{children}
		</div>
	);
}

function StatusScreen({
	icon,
	title,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	children?: React.ReactNode;
}) {
	return (
		<AuthorizeScreen>
			<Card className="w-full max-w-md">
				<CardHeader className="text-center">
					<div className="mx-auto [&>svg]:size-10">{icon}</div>
					<CardTitle>{title}</CardTitle>
				</CardHeader>
				{children && (
					<CardContent className="text-center text-sm text-muted-foreground">
						{children}
					</CardContent>
				)}
			</Card>
		</AuthorizeScreen>
	);
}

export default function CWIAuthorizePage() {
	return (
		<Suspense
			fallback={
				<StatusScreen
					icon={<Loader2 className="animate-spin text-primary" />}
					title="Loading authorization"
				/>
			}
		>
			<AuthorizeContent />
		</Suspense>
	);
}
