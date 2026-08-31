const fs = require("node:fs");
const path = require("node:path");
const { TTFLoader } = require("three-stdlib");

const repositoryRoot = path.resolve(__dirname, "..");
const inputPath = path.resolve(
	process.argv[2] ??
		path.join(repositoryRoot, "public/fonts/Kanit-ExtraBold.ttf"),
);
const outputPath = path.resolve(
	process.argv[3] ??
		path.join(repositoryRoot, "public/fonts/kanit-extrabold.typeface.json"),
);

const source = fs.readFileSync(inputPath);
const arrayBuffer = source.buffer.slice(
	source.byteOffset,
	source.byteOffset + source.byteLength,
);

// Three's converter emits curve endpoints before their control points, which
// is the order FontLoader expects for both q and b outline commands.
const result = new TTFLoader().parse(arrayBuffer);

fs.writeFileSync(outputPath, `${JSON.stringify(result, null, "\t")}\n`);
console.log(`Converted ${inputPath} to ${outputPath}`);
console.log(`Total glyphs: ${Object.keys(result.glyphs).length}`);
