// Turns NESA's published "Performance of Schools" PDFs (converted with `pdftotext -layout`) into a
// school-directory CSV. Usage:
//   node scripts/extract-nesa-schools.mjs out.csv p6.txt s3.txt     (first file = primary/PLE, the reference)
//
// Only school code and name are read from each row. The district is derived from the first two digits of
// the school code, because the printed "District name" column is blank or wrong in the O-level (S3) file.
// The prefix->district table is NOT hard-coded: it is learned from the PLE file and every prefix must map
// to exactly one district there, and the printed PLE district must agree for every row, or this script aborts.
// The PDFs carry no sector or cell, so those columns stay empty.
import fs from "node:fs";

const [out, primaryFile, ...otherFiles] = process.argv.slice(2);
if (!out || !primaryFile) { console.error("Usage: extract-nesa-schools.mjs out.csv primary.txt [other.txt ...]"); process.exit(1); }

const data = JSON.parse(fs.readFileSync(new URL("../data/rwanda-locations.json", import.meta.url), "utf8"));
const norm = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const districts = new Map();
for (const p of data.provinces) for (const d of p.districts) districts.set(norm(d.name), { province: p.name, district: d.name });

const ROW = /^\s*(\d{6})\s+(\S.*?)(?:\s{2,}(.*))?$/;
const TAIL = /^([A-Za-z' -]+?)?(?:\s+\d+)?\s+\d+(?:\.\d+)?$|^\d+(?:\.\d+)?$/;
function parse(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!/^\s*\d{6}\s/.test(line)) continue;
    const m = ROW.exec(line);
    if (!m) throw new Error(`Unparseable row: ${line}`);
    const tail = (m[3] ?? "").trim();
    if (tail && !TAIL.test(tail)) throw new Error(`Unexpected columns after the school name: ${line}`);
    const printed = tail ? (TAIL.exec(tail)?.[1] ?? "").trim() : "";
    rows.push({ code: m[1], name: m[2].replace(/\s+/g, " ").trim(), printedDistrict: printed });
  }
  return rows;
}

// 1. Learn prefix -> district from the primary file and require it to be perfectly consistent.
const primary = parse(primaryFile);
const prefixDistrict = new Map();
let checked = 0;
for (const r of primary) {
  if (!r.printedDistrict) continue;
  const loc = districts.get(norm(r.printedDistrict));
  if (!loc) throw new Error(`Unknown district "${r.printedDistrict}" for ${r.code}`);
  const prefix = r.code.slice(0, 2), prev = prefixDistrict.get(prefix);
  if (prev && prev.district !== loc.district) throw new Error(`Prefix ${prefix} maps to both ${prev.district} and ${loc.district}`);
  prefixDistrict.set(prefix, loc); checked++;
}
if (prefixDistrict.size !== 30) throw new Error(`Expected 30 district prefixes, learned ${prefixDistrict.size}`);
if (new Set([...prefixDistrict.values()].map((l) => l.district)).size !== 30) throw new Error("Two prefixes share a district");

// 2. Build the school list: primary rows first, then the other files (codes already seen keep their first name).
const schools = new Map();
const stats = { primaryRows: primary.length, rowsCheckedAgainstPrintedDistrict: checked, otherRows: 0, nameMismatches: 0, unknownPrefix: 0 };
const mismatches = [];
const add = (r, isOther) => {
  const loc = prefixDistrict.get(r.code.slice(0, 2));
  if (!loc) { stats.unknownPrefix++; return; }
  const prev = schools.get(r.code);
  if (prev) {
    if (isOther && prev.name.toLowerCase() !== r.name.toLowerCase()) { stats.nameMismatches++; mismatches.push(`${r.code}: "${prev.name}" vs "${r.name}"`); }
    return;
  }
  schools.set(r.code, { code: r.code, name: r.name, ...loc });
};
primary.forEach((r) => add(r, false));
for (const f of otherFiles) { const rows = parse(f); stats.otherRows += rows.length; rows.forEach((r) => add(r, true)); }

const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const rows = [...schools.values()].sort((a, b) => a.code.localeCompare(b.code));
fs.writeFileSync(out, ["school_name,province,district,sector,cell,school_code,school_type",
  ...rows.map((r) => [q(r.name), q(r.province), q(r.district), "", "", r.code, ""].join(","))].join("\n") + "\n");
console.log(JSON.stringify({ ...stats, uniqueSchools: rows.length }));
if (mismatches.length) console.log("NAME MISMATCHES (first kept):\n" + mismatches.slice(0, 12).join("\n"));
