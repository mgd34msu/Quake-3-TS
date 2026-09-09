// Prints, or explicitly applies, required VFS root option migration hunks.
import { readFileSync } from "node:fs";
import ts from "typescript";

interface Insertion { readonly position: number; readonly text: string }

const excluded = new Set([
  "src/assets/vfs.ts", "tests/vfs.test.ts", "src/engine/server-engine.ts", "tests/server-engine.test.ts", "tools/verify-server.ts",
]);

function namedProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find(property => property.name?.getText() === name);
}

function dataPathExpression(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
}

function stable(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression) || ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true;
  if (ts.isPropertyAccessExpression(expression)) return stable(expression.expression);
  if (ts.isElementAccessExpression(expression)) return stable(expression.expression) && stable(expression.argumentExpression);
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && stable(expression.left) && stable(expression.right);
}

const apply = process.argv.slice(2).includes("--apply");
const search = Bun.spawnSync(["rg", "--files", "-g", "*.ts", "src", "tests", "tools"]);
if (search.exitCode !== 0) throw new Error(new TextDecoder().decode(search.stderr));
const paths = new TextDecoder().decode(search.stdout).trim().split("\n").filter(path => !excluded.has(path)).sort();
const sections: string[] = [];
const manual: string[] = [];

for (const path of paths) {
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const insertions: Insertion[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "VirtualFileSystem"
      && (node.expression.name.text === "openInspection" || node.expression.name.text === "openTracked")) {
      const options = node.arguments[0];
      if (options === undefined || !ts.isObjectLiteralExpression(options)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        manual.push(`${path}:${line}: options are not an object literal`);
      } else if (namedProperty(options, "homePath") === undefined || namedProperty(options, "cdPath") === undefined) {
        const property = namedProperty(options, "dataPath");
        const expression = property === undefined ? undefined : dataPathExpression(property);
        if (property === undefined || expression === undefined || !stable(expression)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          manual.push(`${path}:${line}: dataPath expression requires single-evaluation handling`);
        } else {
          insertions.push({ position: property.end, text: `, homePath: ${expression.getText(source)}, cdPath: null` });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (insertions.length === 0) continue;
  const changes = new Map<number, Insertion[]>();
  for (const insertion of insertions) {
    const start = original.lastIndexOf("\n", insertion.position - 1) + 1;
    const values = changes.get(start) ?? [];
    values.push(insertion);
    changes.set(start, values);
  }
  const hunks: string[] = [];
  for (const start of [...changes.keys()].sort((left, right) => left - right)) {
    const lineEnd = original.indexOf("\n", start);
    const oldLine = original.slice(start, lineEnd === -1 ? original.length : lineEnd);
    let newLine = oldLine;
    const values = changes.get(start);
    if (values === undefined) throw new Error(`Missing generated insertion for ${path}`);
    for (const insertion of values.sort((left, right) => right.position - left.position)) {
      const offset = insertion.position - start;
      newLine = newLine.slice(0, offset) + insertion.text + newLine.slice(offset);
    }
    hunks.push(`@@\n-${oldLine}\n+${newLine}`);
  }
  sections.push(`*** Update File: ${path}\n${hunks.join("\n")}`);
}

if (manual.length > 0) process.stderr.write(`Manual VFS root migrations:\n${manual.join("\n")}\n`);
if (sections.length === 0) process.stderr.write("All deterministic VFS roots are explicit.\n");
else {
  const patch = `*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`;
  if (!apply) process.stdout.write(patch);
  else {
    const result = Bun.spawnSync(["apply_patch"], { stdin: new TextEncoder().encode(patch) });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    process.stdout.write(new TextDecoder().decode(result.stdout));
  }
}
