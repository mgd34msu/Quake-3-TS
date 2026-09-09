// Prints an apply_patch migration for test-only Draw2D fixtures.
import { readFileSync } from "node:fs";
import ts from "typescript";

const excluded = new Set([
  "tests/draw2d.test.ts", "tests/picture-material.test.ts", "tests/tess-state.test.ts", "tests/render-commands.test.ts",
  "tests/client-level.test.ts", "tests/client-session.test.ts", "tests/cgame-mission-hud.test.ts", "tests/ui-runtime.test.ts",
  "tests/menu.test.ts", "tests/builtin-images.test.ts", "tests/cgame-draw-icons.test.ts", "tests/cgame-effects.test.ts",
  "tests/engine-ui-model.test.ts", "tests/engine-ui-cinematics.test.ts",
]);
const sharedResources = new Set([
  "tests/cgame-hud.test.ts", "tests/cgame-hud-corners.test.ts", "tests/cgame-draw-status.test.ts",
  "tests/cgame-scoreboard.test.ts", "tests/cgame-info.test.ts", "tests/cgame-draw-tools.test.ts", "tests/material-remap.test.ts",
  "tests/cgame-mission-owner-draw.test.ts",
]);
const stateClocks = new Set([
  "tests/cgame-hud.test.ts", "tests/cgame-hud-corners.test.ts", "tests/cgame-draw-status.test.ts", "tests/cgame-scoreboard.test.ts",
  "tests/cgame-mission-owner-draw.test.ts",
]);

interface Insertion { readonly position: number; readonly text: string }

const search = Bun.spawnSync(["rg", "--files", "tests", "-g", "*.ts"]);
if (search.exitCode !== 0) throw new Error(new TextDecoder().decode(search.stderr));
const paths = new TextDecoder().decode(search.stdout).trim().split("\n").filter(path => !excluded.has(path)).sort();
const sections: string[] = [];

for (const path of paths) {
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const insertions: Insertion[] = [];
  const drawClasses = new Set(["Draw2D"]);
  let needsTessImport = false;

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined || statement.heritageClauses === undefined) continue;
    for (const clause of statement.heritageClauses) for (const type of clause.types) {
      if (ts.isIdentifier(type.expression) && type.expression.text === "Draw2D") drawClasses.add(statement.name.text);
    }
  }

  function tessExpression(node: ts.NewExpression): string {
    if (!sharedResources.has(path)) { needsTessImport = true; return "new SourceTessState()"; }
    if (path !== "tests/cgame-info.test.ts") return "resources.tess";
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return line < 156 ? "value.resources.tess" : "resources.tess";
  }

  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && drawClasses.has(node.expression.text)) {
      const args = node.arguments;
      if (args !== undefined && args.length >= 3 && args.length < 6) {
        const last = args[args.length - 1];
        if (last === undefined) throw new Error(`Missing Draw2D argument in ${path}`);
        const clock = stateClocks.has(path)
          ? "{ milliseconds: () => state.time, cinematicMilliseconds: () => state.time }"
          : "{ milliseconds: () => 0, cinematicMilliseconds: () => 0 }";
        const tess = tessExpression(node);
        if (args.length === 3) insertions.push({ position: last.end, text: `, ${clock}, 1, ${tess}` });
        else if (args.length === 4) insertions.push({ position: args[2]?.end ?? last.end, text: `, ${clock}` }, { position: last.end, text: `, ${tess}` });
        else insertions.push({ position: last.end, text: `, ${tess}` });
      }
    }
    if (ts.isVariableDeclaration(node) && node.type !== undefined && ts.isTypeReferenceNode(node.type)
      && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "PictureAsset"
      && node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)
      && !node.initializer.properties.some(property => property.name !== undefined && property.name.getText(source) === "kind")) {
      insertions.push({ position: node.initializer.getStart(source) + 1, text: ' kind: "image",' });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  if (needsTessImport) {
    const drawImport = source.statements.find(statement => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "../src/render/draw2d.ts");
    if (drawImport === undefined) throw new Error(`Missing Draw2D import in ${path}`);
    insertions.push({ position: drawImport.end, text: '\nimport { SourceTessState } from "../src/render/tess-state.ts";' });
  }
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
    hunks.push(`@@\n-${oldLine}\n+${newLine.replaceAll("\n", "\n+")}`);
  }
  sections.push(`*** Update File: ${path}\n${hunks.join("\n")}`);
}

if (sections.length === 0) process.stderr.write("All Draw2D fixtures are migrated.\n");
else process.stdout.write(`*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`);
