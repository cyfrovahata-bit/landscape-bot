import fs from "node:fs";
import path from "node:path";

type ExportItem = {
  kind: string;
  name: string;
  signature?: string;
  line?: number;
};

type FileSummary = {
  file: string;
  exports: ExportItem[];
  envKeys: string[];
  notes: string[];
};

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");
const OUT_FILE = path.join(ROOT, "PROJECT_SNAPSHOT.md");

// що ігноруємо
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const INCLUDE_EXT = new Set([".ts", ".tsx"]);

// дуже проста евристика для експорту
const RE_EXPORTS = [
  // existing...
  { kind: "export function", re: /export\s+async\s+function\s+([A-Za-z0-9_]+)/g },
  { kind: "export function", re: /export\s+function\s+([A-Za-z0-9_]+)/g },
  { kind: "export const", re: /export\s+const\s+([A-Za-z0-9_]+)/g },
  { kind: "export let", re: /export\s+let\s+([A-Za-z0-9_]+)/g },
  { kind: "export class", re: /export\s+class\s+([A-Za-z0-9_]+)/g },
  { kind: "export interface", re: /export\s+interface\s+([A-Za-z0-9_]+)/g },
  { kind: "export type", re: /export\s+type\s+([A-Za-z0-9_]+)/g },
  { kind: "export enum", re: /export\s+enum\s+([A-Za-z0-9_]+)/g },
  { kind: "export default", re: /export\s+default\s+(?:async\s+function\s+([A-Za-z0-9_]+)|function\s+([A-Za-z0-9_]+)|class\s+([A-Za-z0-9_]+)|([A-Za-z0-9_]+))/g },

  // NEW: export { A, B } (виведемо як "named exports")
  { kind: "export {..}", re: /export\s*\{\s*([^}]+)\s*\}\s*(?:from\s*["'][^"']+["'])?\s*;?/g },

  // NEW: export * from
  { kind: "export * from", re: /export\s+\*\s+from\s+["']([^"']+)["']\s*;?/g },
];

// env/config ключі
const RE_ENV = [
  /process\.env\.([A-Za-z0-9_]+)/g,
  /import\.meta\.env\.([A-Za-z0-9_]+)/g,
];

// ключові файли (підсвітимо в нотатках)
const IMPORTANT_FILES = [
  // entry
  "src/index.ts",

  // bot core
  "src/bot/wizard.ts",
  "src/bot/ui.ts",
  "src/bot/texts.ts",
  "src/bot/core/session.ts",
  "src/bot/core/flowTypes.ts",
  "src/bot/core/helpers.ts",
  "src/bot/core/auth.ts",
  "src/bot/core/flowRegistry.ts",
  "src/bot/core/cb.ts",

  // flows (те, що вже зробили на Етапі 3)
  "src/bot/flows/dayStatus.flow.ts",
  "src/bot/flows/closeDay.flow.ts",
  "src/bot/flows/logistics.flow.ts",
  "src/bot/flows/road.flow.ts",

  // google core
  "src/google/client.ts",
  "src/google/drive.ts",
  "src/config.ts",

  // NEW google/sheets structure
  "src/google/sheets/names.ts",
  "src/google/sheets/types.ts",
  "src/google/sheets/headers.ts",
  "src/google/sheets/core.ts",
  "src/google/sheets/utils.ts",

  // dictionaries + checklist + working (Етап 3)
  "src/google/sheets/dictionaries.ts",
  "src/google/sheets/checklist.ts",
  "src/google/sheets/working.ts",
];


function isIgnoredDir(name: string) {
  return IGNORE_DIRS.has(name);
}

function walk(dir: string, out: string[] = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (isIgnoredDir(e.name)) continue;
      walk(full, out);
    } else {
      const ext = path.extname(e.name);
      if (!INCLUDE_EXT.has(ext)) continue;
      out.push(full);
    }
  }
  return out;
}

function rel(p: string) {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

function getLineNumber(text: string, index: number) {
  // line numbers 1-based
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function extractExports(text: string): ExportItem[] {
  const items: ExportItem[] = [];

  for (const spec of RE_EXPORTS) {
    const re = new RegExp(spec.re.source, spec.re.flags);
    let m: RegExpExecArray | null;

    while ((m = re.exec(text))) {
      // special case: export { a, b as c }
      if (spec.kind === "export {..}") {
        const list = (m[1] || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => x.split(/\s+as\s+/i).pop()!.trim()); // беремо фінальне ім'я

        for (const name of list) {
          items.push({ kind: spec.kind, name, line: getLineNumber(text, m.index) });
        }
        continue;
      }

      // special case: export * from "..."
      if (spec.kind === "export * from") {
        const from = m[1] || "";
        items.push({ kind: spec.kind, name: `* (${from})`, line: getLineNumber(text, m.index) });
        continue;
      }

      const name = m[1] || m[2] || m[3] || m[4] || "default";
      items.push({ kind: spec.kind, name, line: getLineNumber(text, m.index) });
    }
  }

  const seen = new Set<string>();
  return items
    .filter((x) => {
      const k = `${x.kind}:${x.name}:${x.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}


function extractEnvKeys(text: string): string[] {
  const keys: string[] = [];

  for (const re0 of RE_ENV) {
    const re = new RegExp(re0.source, re0.flags);
    let m: RegExpExecArray | null;

    while ((m = re.exec(text))) {
      if (m[1]) keys.push(m[1]);
    }
  }

  return Array.from(new Set(keys)).sort();
}

function detectNotes(fileRel: string, text: string): string[] {
  const notes: string[] = [];

  if (IMPORTANT_FILES.includes(fileRel)) notes.push("⭐ key file");

  if (fileRel === "src/index.ts") notes.push("entrypoint (bot старт)");
  if (fileRel.endsWith("/wizard.ts")) notes.push("router/меню/flow registry");
  if (fileRel.endsWith("/core/auth.ts")) notes.push("auth/roles (КОРИСТУВАЧІ)");

  // NEW: google/sheets/*
  if (fileRel.includes("src/google/sheets/working.")) notes.push("Sheets working layer (events/upsert + refresh checklist)");
  if (fileRel.includes("src/google/sheets/checklist.")) notes.push("checklist вычисления + getDayStatusRow");
  if (fileRel.includes("src/google/sheets/dictionaries.")) notes.push("dictionaries fetch (objects/employees/etc)");

  // NEW: flows
  if (fileRel.endsWith("/flows/dayStatus.flow.ts")) notes.push("DAY_STATUS flow (view + refresh + submit)");
  if (fileRel.endsWith("/flows/closeDay.flow.ts")) notes.push("CLOSE_DAY flow (close day wizard)");
  if (fileRel.endsWith("/flows/logistics.flow.ts")) notes.push("LOGISTICS flow");
  if (fileRel.endsWith("/flows/road.flow.ts")) notes.push("ROAD flow");

  // generic heuristics
  if (text.includes("SHEET_NAMES")) notes.push("uses SHEET_NAMES");
  if (text.includes("ensureSession(")) notes.push("uses sessions");
  if (text.includes("append") || text.includes("upsert")) notes.push("writes to Sheets");

  return Array.from(new Set(notes));
}


function format(summary: FileSummary[]) {
  const byImportant = [...summary].sort((a, b) => {
    const ai = IMPORTANT_FILES.includes(a.file) ? 0 : 1;
    const bi = IMPORTANT_FILES.includes(b.file) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return a.file.localeCompare(b.file);
  });

  const allEnv = Array.from(new Set(byImportant.flatMap((x) => x.envKeys))).sort();

  const lines: string[] = [];
  lines.push(`# Project Snapshot`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## What this is`);
  lines.push(`- Quick overview of project structure`);
  lines.push(`- Exported functions/types/constants by file`);
  lines.push(`- Env/config keys referenced in code`);
  lines.push(``);
  lines.push(`## Entrypoints / key files`);
  for (const f of IMPORTANT_FILES) {
    const exists = fs.existsSync(path.join(ROOT, f));
    lines.push(`- ${exists ? "✅" : "⚠️"} \`${f}\``);
  }
  lines.push(``);

  lines.push(`## Env / config keys used in code`);
  if (allEnv.length === 0) {
    lines.push(`(none found via process.env/import.meta.env scans)`);
  } else {
    for (const k of allEnv) lines.push(`- \`${k}\``);
  }
  lines.push(``);

  lines.push(`## Files & exports`);
  for (const f of byImportant) {
    lines.push(`### \`${f.file}\``);
    if (f.notes.length) lines.push(`Notes: ${f.notes.join(", ")}`);
    if (f.exports.length === 0) {
      lines.push(`- (no exports detected)`);
    } else {
      for (const ex of f.exports) {
        const ln = ex.line ? `L${ex.line}` : "";
        lines.push(`- ${ex.kind} **${ex.name}** ${ln}`.trim());
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}

async function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error("❌ No src/ folder found at:", SRC_DIR);
    process.exit(1);
  }

  const files = walk(SRC_DIR);
  const summary: FileSummary[] = [];

  for (const abs of files) {
    const fileRel = rel(abs);
    const text = fs.readFileSync(abs, "utf8");

    summary.push({
      file: fileRel,
      exports: extractExports(text),
      envKeys: extractEnvKeys(text),
      notes: detectNotes(fileRel, text),
    });
  }

  const md = format(summary);
  fs.writeFileSync(OUT_FILE, md, "utf8");

  console.log(`✅ Snapshot written to: ${rel(OUT_FILE)}`);
  console.log(`\n--- Paste this into a new chat ---\n`);
  console.log(md);
}

main().catch((e) => {
  console.error("❌ Snapshot failed:", e?.stack || e);
  process.exit(1);
});


