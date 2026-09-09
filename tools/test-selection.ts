import ts from "typescript";

/** Inspect code, not fixture strings or comments containing another test's code. */
export function usesGlTestFlag(path: string, text: string): boolean {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  function visit(node: ts.Node): void {
    if ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node))
      && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "env"
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process") {
      if (ts.isPropertyAccessExpression(node)) found ||= node.name.text === "QUAKE_GL_TEST";
      else if (ts.isStringLiteralLike(node.argumentExpression)) found ||= node.argumentExpression.text === "QUAKE_GL_TEST";
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
