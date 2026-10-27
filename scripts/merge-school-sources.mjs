// Builds the school directory CSV by merging two sources:
//   1. NESA exam-result lists  -> code, name, district            (data/schools-nesa-2024-25.csv)
//   2. ROF-supplied school list -> code, name, type, district, sector, and (day schools) cell
// Usage: node scripts/merge-school-sources.mjs <out.csv> <nesa.csv> <upload.csv>
//
// Nothing is guessed:
//  - sector/cell names must resolve against data/rwanda-locations.json (plus data/location-aliases.json);
//  - a cell that is a truncated name in the upload (e.g. "Rwanyamuhang") is accepted only when it is the unique
//    cell of that sector starting with that text;
//  - the district implied by the school code prefix (learned from the NESA list) must equal the upload's district,
//    otherwise the row is rejected and reported;
//  - for schools present in both lists the NESA name is kept (the upload often omits the "GS"/"EP" prefix);
//  - a row whose sector cannot be resolved is kept at district level (no sector), never dropped silently.
import fs from "node:fs";

const [out, nesaFile, uploadFile] = process.argv.slice(2);
if (!out || !nesaFile || !uploadFile) { console.error("Usage: merge-school-sources.mjs out.csv nesa.csv upload.csv"); process.exit(1); }

const root = new URL("../data/", import.meta.url);
const loc = JSON.parse(fs.readFileSync(new URL("rwanda-locations.json", root), "utf8"));
const aliases = JSON.parse(fs.readFileSync(new URL("location-aliases.json", root), "utf8"));
const norm = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(f); f = ""; rows.push(row); row = []; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const districts = new Map(); // norm district -> { province, district, sectors: Map }
for (const p of loc.provinces) for (const d of p.districts)
  districts.set(norm(d.name), { province: p.name, district: d.name, sectors: new Map(d.sectors.map((s) => [norm(s.name), s])) });

// --- 1. NESA list ---
const nesaRows = parseCsv(fs.readFileSync(nesaFile, "utf8")).slice(1).filter((r) => r.length >= 6);
const schools = new Map(); // code -> record
const prefixDistrict = new Map();
for (const r of nesaRows) {
  const [name, province, district, , , code] = r;
  schools.set(code, { code, name, province, district, sector: "", cell: "", type: "", source: "nesa" });
  const prev = prefixDistrict.get(code.slice(0, 2));
  if (prev && prev !== district) throw new Error(`NESA prefix ${code.slice(0, 2)} maps to two districts`);
  prefixDistrict.set(code.slice(0, 2), district);
}

// --- 2. ROF upload ---
const TYPES = { PUBLIC: "Public", GOVERNMENT_AIDED: "Government Aided", PRIVATE: "Private" };
const upload = new Map(); // code -> { name,status,district,sector,cells:Set }
for (const r of parseCsv(fs.readFileSync(uploadFile, "utf8"))) {
  const code = (r[0] ?? "").trim();
  if (!/^\d{6}$/.test(code)) continue;
  const rec = { name: (r[1] ?? "").replace(/\s+/g, " ").trim(), status: (r[2] ?? "").trim(), district: (r[4] ?? "").trim(), sector: (r[5] ?? "").trim() };
  const cell = (r[3] ?? "").trim() === "DAY" ? (r[6] ?? "").trim() : "";
  const prev = upload.get(code);
  if (prev) {
    for (const k of ["name", "status", "district", "sector"]) if (norm(prev[k]) !== norm(rec[k])) throw new Error(`Upload rows disagree for ${code} on ${k}: "${prev[k]}" vs "${rec[k]}"`);
    if (cell) prev.cells.add(cell);
  } else upload.set(code, { ...rec, cells: new Set(cell ? [cell] : []) });
}

const stats = {
  nesaSchools: schools.size, uploadSchools: upload.size, addedFromUpload: 0, enrichedFromUpload: 0,
  rejectedPrefixMismatch: 0, sectorResolved: 0, sectorUnresolvedKeptAtDistrict: 0, cellResolvedExact: 0, cellResolvedViaAlias: 0,
  cellResolvedViaTruncation: 0, cellUnresolved: 0, cellAmbiguousAcrossRows: 0, nameDiffersIgnoringCase: 0, unknownType: 0,
};
const issues = [];

for (const [code, u] of upload) {
  const d = districts.get(norm(u.district));
  if (!d) { issues.push(`${code}: unknown district "${u.district}"`); stats.rejectedPrefixMismatch++; continue; }
  const expected = prefixDistrict.get(code.slice(0, 2));
  if (expected && norm(expected) !== norm(d.district)) { issues.push(`${code}: upload district ${d.district} but code prefix says ${expected}`); stats.rejectedPrefixMismatch++; continue; }

  // sector (with alias)
  let sec = d.sectors.get(norm(u.sector));
  if (!sec) {
    const canon = aliases.sectors[`${norm(d.district)}|${norm(u.sector)}`];
    if (canon) sec = d.sectors.get(norm(canon));
  }
  let cellName = "";
  if (sec) {
    stats.sectorResolved++;
    // cell (exact, alias, or unique truncated prefix)
    const wanted = [...u.cells];
    if (wanted.length > 1) { stats.cellAmbiguousAcrossRows++; issues.push(`${code}: several different cells in upload (${wanted.join(" / ")}); cell left empty`); }
    else if (wanted.length === 1) {
      const w = wanted[0], key = norm(w);
      const exact = sec.cells.find((c) => norm(c.name) === key);
      const aliasName = aliases.cells[`${norm(d.district)}|${norm(sec.name)}|${key}`];
      const viaAlias = aliasName && sec.cells.find((c) => norm(c.name) === norm(aliasName));
      const prefix = sec.cells.filter((c) => key.length >= 4 && norm(c.name).startsWith(key));
      if (exact) { cellName = exact.name; stats.cellResolvedExact++; }
      else if (viaAlias) { cellName = viaAlias.name; stats.cellResolvedViaAlias++; }
      else if (prefix.length === 1) { cellName = prefix[0].name; stats.cellResolvedViaTruncation++; }
      else { stats.cellUnresolved++; issues.push(`${code}: cell "${w}" not found in ${d.district}/${sec.name}; cell left empty`); }
    }
  } else {
    stats.sectorUnresolvedKeptAtDistrict++;
    issues.push(`${code}: sector "${u.sector}" not found in ${d.district}; kept at district level`);
  }

  const type = TYPES[u.status] ?? "";
  if (!type) stats.unknownType++;
  const existing = schools.get(code);
  // Name: NESA's (fuller, from the 2024/25 results) wins when both lists have the school; the upload's name is used otherwise.
  const rec = { code, name: existing ? existing.name : u.name, province: d.province, district: d.district, sector: sec?.name ?? "", cell: cellName, type, source: "upload" };
  if (existing) {
    if (norm(existing.name) !== norm(u.name)) stats.nameDiffersIgnoringCase++;
    stats.enrichedFromUpload++;
  } else stats.addedFromUpload++;
  schools.set(code, rec);
}

const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const rows = [...schools.values()].sort((a, b) => a.code.localeCompare(b.code));
fs.writeFileSync(out, ["school_name,province,district,sector,cell,school_code,school_type",
  ...rows.map((r) => [q(r.name), q(r.province), q(r.district), q(r.sector), q(r.cell), r.code, r.type].join(","))].join("\n") + "\n");
stats.total = rows.length;
stats.withSector = rows.filter((r) => r.sector).length;
stats.withCell = rows.filter((r) => r.cell).length;
stats.withType = rows.filter((r) => r.type).length;
console.log(JSON.stringify(stats, null, 1));
if (issues.length) console.log(`\nISSUES (${issues.length}):\n` + issues.slice(0, 40).join("\n"));
