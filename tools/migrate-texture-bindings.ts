// Prints, or explicitly applies, deterministic TextureBinding migration hunks.
import { readFileSync } from "node:fs";
import ts from "typescript";

interface Edit { readonly start: number; readonly end: number; readonly text: string }

const excluded = new Set([
  "src/platform/gl.ts", "src/render/types.ts", "src/render/gl/renderer.ts", "src/render/cpu/rasterizer.ts",
  "src/render/world.ts", "src/render/material.ts", "src/render/material-finish.ts", "src/render/picture-material.ts",
  "src/render/sky.ts", "src/render/draw2d.ts", "tests/draw2d.test.ts", "tests/picture-material.test.ts",
  "tests/raster-retain-binding.test.ts", "tests/sky.test.ts", "tests/material.test.ts", "tests/material-finish.test.ts",
  "tests/fog.test.ts", "tests/scene-effects.test.ts", "tests/world-material-registration.test.ts",
  "tests/material-registry-order.test.ts",
]);

function namedProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) return property;
  }
  return undefined;
}

function stringValue(property: ts.PropertyAssignment | undefined): string | undefined {
  return property !== undefined && ts.isStringLiteral(property.initializer) ? property.initializer.text : undefined;
}

function singleLine(source: string, start: number, end: number): boolean {
  return !source.slice(start, end).includes("\n");
}

function removal(source: string, property: ts.PropertyAssignment): Edit | undefined {
  let start = property.getStart();
  let end = property.end;
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
  return singleLine(source, start, end) ? { start, end, text: "" } : undefined;
}

function binding(expression: ts.Expression, wrap: string, filter: string): string {
  if (expression.kind === ts.SyntaxKind.NullKeyword) return '{ kind: "white" }';
  return `{ kind: "image", image: ${expression.getText()}, sampling: { wrap: "${wrap}", filter: "${filter}" } }`;
}

function isBinding(expression: ts.Expression): boolean {
  if (ts.isConditionalExpression(expression)) return isBinding(expression.whenTrue) && isBinding(expression.whenFalse);
  if (!ts.isObjectLiteralExpression(expression)) return false;
  const kind = stringValue(namedProperty(expression, "kind"));
  return kind === "image" || kind === "white" || kind === "retain-current-texture";
}

function samplingFromState(state: ts.Expression): { readonly wrap: string; readonly filter: string; readonly removals: readonly ts.PropertyAssignment[] } | undefined {
  if (ts.isIdentifier(state) && state.text === "OPAQUE_STATE") return { wrap: "repeat", filter: "linear", removals: [] };
  if (!ts.isObjectLiteralExpression(state)) return undefined;
  const wrapProperty = namedProperty(state, "wrap");
  const filterProperty = namedProperty(state, "filter");
  const hasUnresolvedSampler = state.properties.some(property => property.name !== undefined
    && (property.name.getText() === "wrap" || property.name.getText() === "filter")
    && (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)));
  if (hasUnresolvedSampler) return undefined;
  const hasOpaqueSpread = state.properties.some(property => ts.isSpreadAssignment(property)
    && ts.isIdentifier(property.expression) && property.expression.text === "OPAQUE_STATE");
  const wrap = stringValue(wrapProperty) ?? (hasOpaqueSpread ? "repeat" : undefined);
  const filter = stringValue(filterProperty) ?? (hasOpaqueSpread ? "linear" : undefined);
  if (wrap === undefined || filter === undefined) return undefined;
  return { wrap, filter, removals: [wrapProperty, filterProperty].filter(property => property !== undefined) };
}

const apply = process.argv.slice(2).includes("--apply");
const search = Bun.spawnSync(["rg", "--files", "-g", "*.ts", "src", "tests", "tools"]);
if (search.exitCode !== 0) throw new Error(new TextDecoder().decode(search.stderr));
const paths = new TextDecoder().decode(search.stdout).trim().split("\n").filter(path => !excluded.has(path)).sort();
const sections: string[] = [];

for (const path of paths) {
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const texturing = stringValue(namedProperty(node, "texturing"));
      const texture = namedProperty(node, "texture");
      const state = namedProperty(node, "state");
      if ((texturing === "single" || texturing === "pair") && texture !== undefined) {
        if (texture.initializer.kind === ts.SyntaxKind.NullKeyword) {
          edits.push({ start: texture.initializer.getStart(), end: texture.initializer.end, text: binding(texture.initializer, "repeat", "linear") });
        } else if (state !== undefined && !isBinding(texture.initializer)) {
          const sampling = samplingFromState(state.initializer);
          if (sampling !== undefined && singleLine(original, texture.initializer.getStart(), texture.initializer.end)) {
            const removals = sampling.removals.map(property => removal(original, property));
            if (removals.every(edit => edit !== undefined)) {
              edits.push({ start: texture.initializer.getStart(), end: texture.initializer.end,
                text: binding(texture.initializer, sampling.wrap, sampling.filter) });
              for (const edit of removals) if (edit !== undefined) edits.push(edit);
            }
          }
        }
      }
      const second = namedProperty(node, "secondTexture");
      if (texturing === "pair" && second !== undefined && ts.isObjectLiteralExpression(second.initializer)) {
        const image = namedProperty(second.initializer, "image");
        const environment = namedProperty(second.initializer, "environment");
        const wrap = stringValue(namedProperty(second.initializer, "wrap"));
        const filter = stringValue(namedProperty(second.initializer, "filter"));
        if (image !== undefined && environment !== undefined && wrap !== undefined && filter !== undefined
          && singleLine(original, second.initializer.getStart(), second.initializer.end)) {
          edits.push({ start: second.initializer.getStart(), end: second.initializer.end,
            text: `{ binding: ${binding(image.initializer, wrap, filter)}, environment: ${environment.initializer.getText()} }` });
        }
      }
      const kind = stringValue(namedProperty(node, "kind"));
      const frames = namedProperty(node, "frames");
      if (kind === "images" && frames !== undefined && ts.isArrayLiteralExpression(frames.initializer)
        && frames.initializer.elements.length === 1 && singleLine(original, frames.getStart(), frames.end)) {
        const image = frames.initializer.elements[0];
        if (image !== undefined) edits.push({ start: frames.getStart(), end: frames.end,
          text: `playback: { kind: "single", image: ${image.getText()} }` });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (edits.length === 0) continue;
  let updated = original;
  for (const edit of edits.sort((left, right) => right.start - left.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  const before = original.split("\n"), after = updated.split("\n");
  if (before.length !== after.length) throw new Error(`Migration changed line count in ${path}`);
  const hunks: string[] = [];
  for (let index = 0; index < before.length; index++) {
    const oldLine = before[index], newLine = after[index];
    if (oldLine === undefined || newLine === undefined) throw new Error(`Missing generated line in ${path}`);
    if (oldLine !== newLine) hunks.push(`@@\n-${oldLine}\n+${newLine}`);
  }
  if (hunks.length > 0) sections.push(`*** Update File: ${path}\n${hunks.join("\n")}`);
}

if (sections.length === 0) process.stderr.write("All deterministic texture bindings are migrated.\n");
else {
  const patch = `*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`;
  if (!apply) process.stdout.write(patch);
  else {
    const result = Bun.spawnSync(["apply_patch"], { stdin: new TextEncoder().encode(patch) });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    process.stdout.write(new TextDecoder().decode(result.stdout));
  }
}
