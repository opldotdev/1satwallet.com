// Builds the feature showcase images in public/download/features/ from full
// screenshots. Usage: bun scripts/make-feature-crops.mjs <source dir>
// Each entry crops a region (source pixels) and writes WebP. Add an entry when
// a new screenshot arrives, then add a Shot for it in app/download/showcase-data.ts.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const crops = [
	["home-full", "luke-home.png", [0, 190, 1179, 2366]],
	["passes-collections", "luke-home.png", [60, 1405, 1059, 700]],
	["handle-field", "luke-handle.png", [60, 766, 1059, 158]],
	["handle-register", "luke-handle.png", [60, 1339, 1059, 145]],
	["inscribe-sheet", "luke-inscribe.png", [0, 179, 1179, 2185]],
	["inscribe-sign", "luke-inscribe.png", [60, 1695, 1059, 221]],
	["passes-themes", "iphone-wallet-1220.png", [60, 1265, 1059, 665]],
	["mac-sidebar", "mac-wallet-1237.png", [56, 38, 304, 812]],
	["mac-activity", "mac-wallet-1237.png", [640, 340, 464, 510]],
];

const source = process.argv[2];
if (!source) {
	console.error("Usage: bun scripts/make-feature-crops.mjs <source dir>");
	process.exit(1);
}
const out = new URL("../public/download/features/", import.meta.url).pathname;
await mkdir(out, { recursive: true });
for (const [name, file, [left, top, width, height]] of crops) {
	const info = await sharp(join(source, file))
		.extract({ left, top, width, height })
		.webp({ quality: 90 })
		.toFile(join(out, `${name}.webp`));
	console.log(`${name}.webp ${info.width}x${info.height} ${info.size} B`);
}
