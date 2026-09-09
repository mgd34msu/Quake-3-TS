// Prints an apply_patch migration for preexisting single-texture DrawBatch literals.
import { readFileSync } from "node:fs";
import ts from "typescript";

const excludedFiles = new Set([
  "src/render/types.ts", "src/render/picture-material.ts", "src/render/draw2d.ts", "src/render/world.ts",
  "src/render/commands.ts", "src/render/material.ts", "src/render/material-iterator.ts", "src/render/material-finish.ts",
  "tests/draw2d.test.ts", "tests/picture-material.test.ts", "tests/render-commands.test.ts", "tests/tess-state.test.ts",
  "tests/world-tess.test.ts", "tests/material-finish.test.ts", "tests/raster-multitexture.test.ts",
]);

interface Insertion { readonly position: number; readonly text: string }

function isExcluded(path: string): boolean {
  return excludedFiles.has(path) || path.startsWith("src/render/gl/") || path.startsWith("src/render/cpu/");
}

function propertyName(property: ts.ObjectLiteralElementLike, source: ts.SourceFile): string | null {
  if (property.name === undefined) return null;
  return property.name.getText(source);
}

function isJsonSerialization(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || !ts.isPropertyAccessExpression(parent.expression)) return false;
  return ts.isIdentifier(parent.expression.expression) && parent.expression.expression.text === "JSON"
    && parent.expression.name.text === "stringify";
}

const search = Bun.spawnSync(["rg", "--files", "src", "tests", "tools", "-g", "*.ts"]);
if (search.exitCode !== 0) throw new Error(new TextDecoder().decode(search.stderr));
const paths = new TextDecoder().decode(search.stdout).trim().split("\n").filter(path => !isExcluded(path)).sort();
const sections: string[] = [];

for (const path of paths) {
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const insertions: Insertion[] = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node) && !isJsonSerialization(node)
      && !node.properties.some(ts.isSpreadAssignment)) {
      const primitive = node.properties.find(property => propertyName(property, source) === "primitive");
      const fields = new Set(node.properties.map(property => propertyName(property, source)).filter(name => name !== null));
      if (primitive !== undefined && ts.isPropertyAssignment(primitive) && ts.isStringLiteral(primitive.initializer)
        && (primitive.initializer.text === "triangles" || primitive.initializer.text === "lines")
        && !fields.has("texturing") && fields.has("vertices") && fields.has("indices") && fields.has("texture") && fields.has("state")) {
        insertions.push({ position: primitive.getStart(source), text: 'texturing: "single", ' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (insertions.length === 0) continue;

  const changes = new Map<number, Insertion[]>();
  for (const insertion of insertions) {
    const start = original.lastIndexOf("\n", insertion.position - 1) + 1;
    const lineInsertions = changes.get(start) ?? [];
    lineInsertions.push(insertion);
    changes.set(start, lineInsertions);
  }
  const hunks: string[] = [];
  for (const start of [...changes.keys()].sort((left, right) => left - right)) {
    const end = original.indexOf("\n", start), oldLine = original.slice(start, end === -1 ? original.length : end);
    const lineInsertions = changes.get(start);
    if (lineInsertions === undefined) throw new Error(`Missing generated line in ${path}`);
    let newLine = oldLine;
    for (const insertion of lineInsertions.sort((left, right) => right.position - left.position)) {
      const offset = insertion.position - start;
      newLine = newLine.slice(0, offset) + insertion.text + newLine.slice(offset);
    }
    hunks.push(`@@\n-${oldLine}\n+${newLine}`);
  }
  sections.push(`*** Update File: ${path}\n${hunks.join("\n")}`);
}

if (sections.length === 0) process.stderr.write("All preexisting DrawBatch literals declare single texturing.\n");
else process.stdout.write(`*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`);
