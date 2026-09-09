// Prints, or explicitly applies, the AssetReader import migration.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

interface Replacement { readonly start: number; readonly end: number; readonly text: string }

function readerModule(path: string): string {
  const value = relative(dirname(path), "src/assets/reader.ts");
  return value.startsWith(".") ? value : `./${value}`;
}

function removal(source: string, specifier: ts.ImportSpecifier): Replacement | undefined {
  let start = specifier.getStart();
  let end = specifier.end;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === ",") {
    end++;
    while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  } else {
    let cursor = start - 1;
    while (cursor >= 0 && (source[cursor] === " " || source[cursor] === "\t")) cursor--;
    if (source[cursor] !== ",") return undefined;
    start = cursor;
  }
  return source.slice(start, end).includes("\n") ? undefined : { start, end, text: "" };
}

const apply = process.argv.slice(2).includes("--apply");
const search = Bun.spawnSync(["rg", "--files", "-g", "*.ts", "src", "tests", "tools"]);
if (search.exitCode !== 0) throw new Error(new TextDecoder().decode(search.stderr));
const paths = new TextDecoder().decode(search.stdout).trim().split("\n").sort();
const sections: string[] = [];
const unsupported: string[] = [];

for (const path of paths) {
  if (path === "src/render/world.ts" || path === "src/assets/reader.ts" || path === "tools/migrate-asset-reader.ts") continue;
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const replacements: Replacement[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || resolve(dirname(path), statement.moduleSpecifier.text) !== resolve("src/render/world.ts")) continue;
    const clause = statement.importClause;
    const imports = clause?.namedBindings;
    if (clause === undefined || imports === undefined || !ts.isNamedImports(imports)) continue;
    const specifier = imports.elements.find(value => value.name.text === "AssetReader");
    if (specifier === undefined) continue;
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    if ((!clause.isTypeOnly && !specifier.isTypeOnly) || specifier.propertyName !== undefined) {
      unsupported.push(`${path}:${line}: unsupported AssetReader import form`);
      continue;
    }
    const imported = `import type { AssetReader } from "${readerModule(path)}";`;
    if (statement.getText(source).includes("\n")) unsupported.push(`${path}:${line}: multiline import`);
    else if (imports.elements.length === 1 && clause.name === undefined) {
      replacements.push({ start: statement.getStart(source), end: statement.end, text: imported });
    } else {
      const removed = removal(original, specifier);
      if (removed === undefined) unsupported.push(`${path}:${line}: unsupported mixed import`);
      else {
        const statementText = statement.getText(source);
        const localStart = removed.start - statement.getStart(source), localEnd = removed.end - statement.getStart(source);
        replacements.push({ start: statement.getStart(source), end: statement.end,
          text: `${statementText.slice(0, localStart)}${statementText.slice(localEnd)}\n${imported}` });
      }
    }
  }
  if (replacements.length === 0) continue;
  const hunks: string[] = [];
  for (const replacement of replacements) {
    const oldLine = original.slice(replacement.start, replacement.end);
    if (oldLine.includes("\n")) throw new Error(`Unexpected multiline AssetReader import in ${path}`);
    hunks.push(`@@\n-${oldLine}\n+${replacement.text.replaceAll("\n", "\n+")}`);
  }
  sections.push(`*** Update File: ${path}\n${hunks.join("\n")}`);
}

if (unsupported.length > 0) process.stderr.write(`Unsupported AssetReader imports:\n${unsupported.join("\n")}\n`);
if (sections.length === 0) process.stderr.write("All AssetReader imports use the asset boundary.\n");
else {
  const patch = `*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`;
  if (!apply) process.stdout.write(patch);
  else {
    const result = Bun.spawnSync(["apply_patch"], { stdin: new TextEncoder().encode(patch) });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    process.stdout.write(new TextDecoder().decode(result.stdout));
  }
}
