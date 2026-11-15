import Link from "next/link";

export function NotOnTestnet() {
	return (
		<div
			className="mx-auto w-full max-w-xl p-4 py-16 text-center"
			role="status"
		>
			<h1 className="text-xl font-semibold">Not available on testnet</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				This page uses mainnet services. Switch the network in{" "}
				<Link className="underline" href="/wallet/settings">
					Wallet settings
				</Link>{" "}
				to use it.
			</p>
		</div>
	);
}
