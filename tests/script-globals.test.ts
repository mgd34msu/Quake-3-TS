import { describe, expect, test } from "bun:test";
import { ScriptGlobalDefines, ScriptPreprocessor, ScriptSourceReader, type IncludeResolver } from "../src/script/preprocessor.ts";

const resolver: IncludeResolver = { resolve: () => undefined };

describe("native preprocessor global ownership", () => {
  test("copies the reversed duplicate chain and undefines only its visible head", () => {
    const globals = new ScriptGlobalDefines();
    expect(globals.add("VALUE 1")).toBe(true);
    expect(globals.add("VALUE 2")).toBe(true);
    expect(globals.add("VALUE 3")).toBe(true);
    const snapshot = globals.snapshot();
    globals.clear();
    expect(globals.add("VALUE 9")).toBe(true);
    const stream = ScriptPreprocessor.create({ path: "one.c", text: "VALUE\n#undef VALUE\nVALUE\n#define VALUE 4\nVALUE\n#undef VALUE\nVALUE" }, resolver, { globalDefines: snapshot });
    expect(stream.all().map(token => token.text)).toEqual(["1", "2", "4", "3"]);
    expect(ScriptPreprocessor.create({ path: "two.c", text: "VALUE" }, resolver, { globalDefines: snapshot }).all().map(token => token.text)).toEqual(["1"]);
    expect(ScriptPreprocessor.create({ path: "three.c", text: "VALUE" }, resolver, { globalDefines: globals.snapshot() }).all().map(token => token.text)).toEqual(["9"]);
  });

  test("parses at add time with extern locations and retains no failed definition", () => {
    const globals = new ScriptGlobalDefines();
    expect(globals.add("BROKEN(a,a) a")).toBe(false);
    expect(globals.diagnostics[0]?.message).toBe("two the same define parameters");
    expect(globals.diagnostics[0]?.location.path).toBe("*extern");
    expect(globals.add("GOOD(x) x + 1\nignored tokens")).toBe(true);
    const count = globals.diagnostics.length;
    const stream = ScriptPreprocessor.create({ path: "one.c", text: "BROKEN GOOD(2)" }, resolver, { globalDefines: globals.snapshot() });
    expect(stream.all().map(token => token.text)).toEqual(["BROKEN", "2", "+", "1"]);
    expect(globals.diagnostics.length).toBe(count);
  });

  test("does not implicitly call PC_AddBuiltinDefines for source or global parsing", () => {
    const root = { path: "one.c", text: "__LINE__\n#define __LINE__ 17\n__LINE__" };
    expect(ScriptPreprocessor.create(root, resolver).all().map(token => token.text)).toEqual(["__LINE__", "17"]);
    const globals = new ScriptGlobalDefines();
    expect(globals.add("__LINE__ 8")).toBe(true);
    expect(ScriptPreprocessor.create({ path: "one.c", text: "__LINE__" }, resolver, { globalDefines: globals.snapshot() }).all().map(token => token.text)).toEqual(["8"]);
    expect(ScriptPreprocessor.create({ path: "one.c", text: "__LINE__" }, resolver, { globalDefines: globals.snapshot(), installBuiltins: true }).all().map(token => token.text)).toEqual(["1"]);
  });

  test("reports a recursive global definition before publication and preserves diagnostic reentry order", () => {
    const globals = new ScriptGlobalDefines(issue => {
      expect(issue.message).toBe("recursive define (removed recursion)");
      const before = ScriptPreprocessor.create({ path: "before.c", text: "VALUE" }, resolver, { globalDefines: globals.snapshot() });
      expect(before.all().map(token => token.text)).toEqual(["1"]);
      globals.clear();
      expect(globals.add("VALUE 2")).toBe(true);
    });
    expect(globals.add("VALUE 1")).toBe(true);
    expect(globals.add("VALUE VALUE 3")).toBe(true);
    const after = ScriptPreprocessor.create({ path: "after.c", text: "VALUE\n#undef VALUE\nVALUE" }, resolver, { globalDefines: globals.snapshot() });
    expect(after.all().map(token => token.text)).toEqual(["2", "3"]);
  });

  test("an include shares its source snapshot even when the global owner changes during its open", () => {
    const globals = new ScriptGlobalDefines();
    globals.add("VALUE 1");
    const sourceResolver: IncludeResolver = { resolve: () => {
      globals.clear(); globals.add("VALUE 9");
      return { path: "included.h", text: "VALUE\n#undef VALUE\n#define VALUE 3" };
    } };
    const stream = ScriptPreprocessor.create({ path: "root.c", text: 'VALUE\n#include "included.h"\nVALUE' }, sourceResolver, { globalDefines: globals.snapshot() });
    expect(stream.all().map(token => token.text)).toEqual(["1", "1", "3"]);
    expect(ScriptPreprocessor.create({ path: "next.c", text: "VALUE" }, resolver, { globalDefines: globals.snapshot() }).all().map(token => token.text)).toEqual(["9"]);
  });

  test("an incremental source captures globals at open while includes share its later local definitions", () => {
    const globals = new ScriptGlobalDefines();
    globals.add("VALUE 1");
    const sourceResolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: "VALUE\n#undef VALUE\n#define VALUE 3" }) };
    const reader = ScriptSourceReader.open({ path: "root.c", text: 'VALUE\n#include "child.h"\nVALUE' }, sourceResolver, { globalDefines: globals.snapshot() });
    globals.clear();
    globals.add("VALUE 9");
    expect(reader.next()?.token.text).toBe("1");
    expect(reader.next()?.token.text).toBe("1");
    expect(reader.next()?.token.text).toBe("3");
    expect(reader.next()).toBeUndefined();
    expect(ScriptSourceReader.open({ path: "next.c", text: "VALUE" }, resolver, { globalDefines: globals.snapshot() }).next()?.token.text).toBe("9");
  });
});
