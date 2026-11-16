"use client";

import { createContext, type ReactNode, useContext } from "react";

const HeadingLevel = createContext<"h1" | "h2">("h1");

/**
 * Marks content that sits under a page's own h1 (the wallet header names the
 * section), so a testnet notice inside it heads itself with an h2. Not by
 * pathname: on a first load the proxy rewrites to /not-on-testnet, which has
 * no wallet header, under the original URL.
 */
export function UnderPageHeading({ children }: { children: ReactNode }) {
	return <HeadingLevel value="h2">{children}</HeadingLevel>;
}

/** The notice for a mainnet-only page on a testnet account. */
export function NotOnTestnet() {
	const Heading = useContext(HeadingLevel);
	return (
		<div
			className="mx-auto w-full max-w-xl p-4 py-16 text-center"
			role="status"
		>
			<Heading className="text-xl font-semibold">
				Not available on testnet
			</Heading>
			<p className="mt-2 text-sm text-muted-foreground">
				This page uses mainnet services, and the active wallet is a testnet
				account.
			</p>
		</div>
	);
}
