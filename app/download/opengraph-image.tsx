import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "1Sat Wallet: Apple App Beta for iPhone, iPad, and Mac";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const logoData = await readFile(
	join(process.cwd(), "public/oneSatLogoDark.svg"),
	"base64",
);
const logoSrc = `data:image/svg+xml;base64,${logoData}`;

export default function OpenGraphImage() {
	return new ImageResponse(
		<div
			style={{
				height: "100%",
				width: "100%",
				display: "flex",
				alignItems: "center",
				background: "#0b0b0a",
				padding: "0 88px",
				gap: 72,
			}}
		>
			<img src={logoSrc} alt="1Sat Wallet logo" width={280} height={280} />
			<div style={{ display: "flex", flexDirection: "column" }}>
				<div
					style={{
						fontSize: 84,
						fontWeight: 700,
						color: "#ffffff",
						letterSpacing: "-0.04em",
						lineHeight: 1,
					}}
				>
					1Sat Wallet
				</div>
				<div
					style={{
						marginTop: 18,
						fontSize: 40,
						fontWeight: 600,
						color: "#F0BB00",
						letterSpacing: "-0.02em",
					}}
				>
					Apple App Beta
				</div>
				<div
					style={{
						marginTop: 12,
						fontSize: 28,
						color: "#9a9a94",
					}}
				>
					iPhone, iPad, and Mac
				</div>
			</div>
		</div>,
		size,
	);
}
