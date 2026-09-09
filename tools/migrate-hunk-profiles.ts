// Prints an apply_patch migration for existing unaccounted inspection fixtures.
import { readFileSync } from "node:fs";
import ts from "typescript";

const search = Bun.spawnSync(["rg", "--files", "-g", "*.ts", "src", "tests", "tools"]);
if (search.exitCode !== 0) throw new Error(new TextDecoder().decode(search.stderr));
const paths = new TextDecoder().decode(search.stdout).trim().split("\n").sort();
const sections: string[] = [];
for (const path of paths) {
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const insertions: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const expression = node.expression;
      const expected = ts.isNewExpression(node) && ts.isIdentifier(expression)
        ? expression.text === "CollisionWorld" ? 1 : expression.text === "SceneModelRegistry" ? 2 : -1
        : ts.isCallExpression(node) && ts.isPropertyAccessExpression(expression)
          && ts.isIdentifier(expression.expression) && expression.expression.text === "RendererResources"
          && expression.name.text === "create" ? 1 : -1;
      const args = node.arguments;
      if (args !== undefined && args.length === expected) {
        const last = args[args.length - 1];
        if (last === undefined) throw new Error(`Missing constructor argument in ${path}`);
        insertions.push(last.end);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (insertions.length === 0) continue;
  let updated = original;
  for (const position of insertions.sort((left, right) => right - left)) {
    updated = updated.slice(0, position) + ', { kind: "unaccounted" }' + updated.slice(position);
  }
  const before = original.split("\n"), after = updated.split("\n"), hunks: string[] = [];
  for (let index = 0; index < before.length; index++) {
    const oldLine = before[index], newLine = after[index];
    if (oldLine === undefined || newLine === undefined) throw new Error(`Line count changed in ${path}`);
    if (oldLine !== newLine) hunks.push(`@@\n-${oldLine}\n+${newLine}`);
  }
  sections.push(`*** Update File: ${path}\n${hunks.join("\n")}`);
}
if (sections.length > 0) process.stdout.write(`*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`);
else process.stderr.write("All hunk profiles are explicit.\n");
