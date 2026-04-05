import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const csvPath = path.join(root, "data", "sector-industry-mapping.csv");
const outPath = path.join(root, "backend", "src", "data", "industrySectorMapping.ts");

function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      result.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  result.push(cur);
  return result;
}

const text = fs.readFileSync(csvPath, "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const parts = parseCSVLine(lines[i]);
  if (parts.length >= 2) rows.push([parts[0].trim(), parts[1].trim()]);
}

const esc = (s) => JSON.stringify(s);
let out = "";
out += "/**\n";
out += " * Industry name to sector (NSE-style groupings).\n";
out += " * Generated from data/sector-industry-mapping.csv — run: node scripts/generate-industry-sector-mapping.mjs\n";
out += " */\n";
out += "export const INDUSTRY_TO_SECTOR: Record<string, string> = {\n";
for (const [k, v] of rows) {
  out += `  ${esc(k)}: ${esc(v)},\n`;
}
out += "};\n\n";
out += "export function getSectorForIndustry(industryName: string): string | undefined {\n";
out += "  const t = industryName.trim();\n";
out += "  return INDUSTRY_TO_SECTOR[t];\n";
out += "}\n";

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out, "utf8");
console.log(`Wrote ${rows.length} entries to ${path.relative(root, outPath)}`);
