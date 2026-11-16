import { ThemeTokenProvider } from "@theme-token/sdk/react";
import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import type { WebApplication, WithContext } from "schema-dts";
import { JsonLd } from "@/components/json-ld";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { WalletBridge } from "@/components/wallet-bridge";
import { QueryProvider } from "@/providers/query-provider";
import { WalletChainProvider } from "@/providers/wallet-chain-provider";
import { WalletProvider } from "@/providers/wallet-provider";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";
import "./animations.css";

const spaceGrotesk = Space_Grotesk({
	variable: "--font-sans",
	subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
	variable: "--font-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "1Sat Wallet | BRC-100 Wallet for BSV",
	description:
		"Use 1Sat Wallet on the web, connect a compatible BRC-100 wallet, and manage BSV, ordinals, BSV21 tokens, and portable identities.",
	metadataBase: new URL("https://1satwallet.com"),
	keywords: [
		"1Sat Wallet",
		"BRC-100 wallet",
		"BSV wallet",
		"Bitcoin SV",
		"BSV ordinals",
		"BSV21",
	],
	openGraph: {
		title: "1Sat Wallet | BRC-100 Wallet for BSV",
		description:
			"A web wallet and BRC-100 connection hub for BSV, ordinals, BSV21 tokens, and portable identities.",
		url: "https://1satwallet.com",
		siteName: "1Sat Wallet",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "1Sat Wallet | BRC-100 Wallet for BSV",
		description: "Connect or use a BRC-100 wallet for BSV on the web.",
	},
};

// Draw under the notch and home indicator; the shell pads itself with the
// safe-area insets (see dual-sidebar-layout, DialogContent, Sheet). The
// on-screen keyboard resizes the layout viewport where supported, so dvh
// sheets and fixed footers stay above it.
export const viewport: Viewport = {
	viewportFit: "cover",
	interactiveWidget: "resizes-content",
};

const jsonLd: WithContext<WebApplication> = {
	"@context": "https://schema.org",
	"@type": "WebApplication",
	name: "1Sat Wallet",
	url: "https://1satwallet.com",
	description:
		"A web wallet and BRC-100 connection hub for BSV, ordinals, BSV21 tokens, and portable identities.",
	applicationCategory: "FinanceApplication",
	operatingSystem: "Web",
	offers: {
		"@type": "Offer",
		price: "0",
		priceCurrency: "USD",
	},
	provider: {
		"@type": "Organization",
		name: "1Sat",
		url: "https://1satwallet.com",
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<JsonLd data={jsonLd} />
			</head>
			<body
				className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} antialiased font-sans`}
			>
				<ConvexClientProvider>
					<ThemeProvider
						attribute="class"
						defaultTheme="dark"
						enableSystem
						disableTransitionOnChange
					>
						<ThemeTokenProvider>
							<QueryProvider>
								<WalletProvider>
									<WalletChainProvider>
										<KeyboardShortcuts />
										<WalletBridge>{children}</WalletBridge>
									</WalletChainProvider>
								</WalletProvider>
								{/* Outside the chain provider, so a toast raised just before
								    the wallet moves to another network survives the remount. */}
								<Toaster position="bottom-right" />
							</QueryProvider>
						</ThemeTokenProvider>
					</ThemeProvider>
				</ConvexClientProvider>
			</body>
		</html>
	);
}
