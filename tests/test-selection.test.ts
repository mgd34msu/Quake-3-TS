import { expect, test } from "bun:test";
import { usesGlTestFlag } from "../tools/test-selection.ts";

test("GL selection recognizes canonical environment access in executable test code", () => {
  for (const source of [
    "const enabled = process.env['QUAKE_GL_TEST'] === '1';",
    "if (process.env.QUAKE_GL_TEST === '1') run();",
    "function enabled() { return process.env[`QUAKE_GL_TEST`]; }",
  ]) expect(usesGlTestFlag("fixture.test.ts", source)).toBe(true);
});

test("GL selection excludes fixture strings, comments, unrelated properties and CPU tests", () => {
  for (const source of [
    "const fixture = `if (process.env['QUAKE_GL_TEST']) run();`;",
    "// process.env['QUAKE_GL_TEST']\nrun();",
    "const label = 'QUAKE_GL_TEST';",
    "const value = settings.env['QUAKE_GL_TEST'];",
    "const data = process.env['Q3_DATA'];",
  ]) expect(usesGlTestFlag("fixture.test.ts", source)).toBe(false);
});
