import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
	title: "Privacy Policy | 1Sat Wallet",
	description:
		"How 1Sat Wallet handles wallet data, keys, and service requests.",
};

const sections = [
	{
		title: "Keys and local wallet data",
		text: "The Apple app stores wallet recovery material in Apple Keychain. Depending on your custody choice, it can sync through iCloud Keychain or remain on this device. The browser wallet stores an encrypted wallet backup in browser storage. Wallet preferences and cached balances, assets, and history can also be stored locally. Keep an independent backup: deleting local data or losing access to your device can make a wallet inaccessible.",
	},
	{
		title: "Wallet services and public transactions",
		text: "The wallet sends requests to wallet storage services, blockchain indexers, transaction broadcasters, and asset-content hosts to retrieve balances and history, manage wallet records, display media, and submit transactions. These requests can include public keys, addresses, transaction identifiers, transaction data, and wallet metadata. Service providers receive connection information such as your IP address. Blockchain transactions and inscriptions are public and can remain available permanently; deleting the app cannot remove them.",
	},
	{
		title: "Connected apps and trading",
		text: "When you connect another app, the wallet shares the information needed for the operations you approve, subject to wallet permissions. The website uses Convex for connection authorization and peer-to-peer features. Records can include the requesting website, requested operation and arguments, public identity keys, profiles, presence, and proposed trade items. Information you announce to other participants is visible to them. Connected apps and external websites have their own privacy practices.",
	},
	{
		title: "Website storage and service providers",
		text: "The website uses browser storage to remember wallet state, connection choices, and preferences. Hosting and backend providers process requests to operate and secure the service. Apple provides app distribution, TestFlight, and optional iCloud Keychain synchronization. Asset images and other remote content can contact their respective hosts when displayed.",
	},
	{
		title: "Feedback and diagnostics",
		text: "If you send feedback, we receive the contact details, messages, screenshots, and diagnostics you choose to include and use them to respond and investigate issues. Apple may share TestFlight feedback and crash information according to your Apple settings and its TestFlight terms. Never include your recovery phrase, private keys, passwords, or other secrets in a report. Screenshots and logs may reveal wallet balances, addresses, or transaction details.",
	},
	{
		title: "Retention and deletion",
		text: "Local data remains until removed through wallet controls or device/browser storage settings; Keychain and synced copies may persist separately from an app installation. The website schedules cleanup of expired authorization and presence records and of terminal trade records after their retention period. This cleanup does not erase public blockchain data, third-party copies, or all provider logs and backups. Wallet-service records and support correspondence have separate retention. Contact us to request access, correction, or deletion of non-public information we hold; we will explain what can be removed and any technical or legal limits. Do not delete your only wallet backup.",
	},
	{
		title: "Your choices",
		text: "You can decline connection requests, review wallet permissions, avoid optional trading or profile features, and choose what to include in feedback. Device settings control available Apple privacy and iCloud features. Disconnecting an app does not retract information already shared with it. Contact us with privacy questions or requests; never send recovery material to prove ownership.",
	},
];

export default function PrivacyPage() {
	return (
		<article className="mx-auto max-w-3xl px-6 py-12 leading-relaxed">
			<Link
				className="text-sm text-muted-foreground underline"
				href="/download"
			>
				1Sat Wallet
			</Link>
			<h1 className="mt-6 font-semibold text-3xl">Privacy Policy</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Updated September 8, 2026
			</p>
			<p className="mt-6">
				This policy covers the 1Sat Wallet Apple app and 1satwallet.com,
				including its browser wallet. It describes how information is handled
				when you use these services.
			</p>
			{sections.map(({ title, text }) => (
				<section className="mt-8" key={title}>
					<h2 className="font-semibold text-xl">{title}</h2>
					<p className="mt-2 text-muted-foreground">{text}</p>
				</section>
			))}
			<section className="mt-8">
				<h2 className="font-semibold text-xl">Contact and updates</h2>
				<p className="mt-2 text-muted-foreground">
					Contact 1Sat Wallet at{" "}
					<a className="underline" href="mailto:luke@opl.dev">
						luke@opl.dev
					</a>
					. Updates to this policy will appear on this page with a revised date.
				</p>
			</section>
		</article>
	);
}
