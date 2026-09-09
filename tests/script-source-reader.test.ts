import { describe, expect, test } from "bun:test";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { allocateScriptSource, NumberFlag, Punctuation, ScriptLanguageError, type ScriptDiagnostic } from "../src/script/lexer.ts";
import type { ScriptMemory } from "../src/script/memory.ts";
import {
  ScriptGlobalDefines,
  ScriptPreprocessor,
  ScriptSourceReader,
  type IncludeRequest,
  type IncludeResolver,
  type ScriptTokenRecord,
} from "../src/script/preprocessor.ts";

const noIncludes: IncludeResolver = { resolve: () => undefined };

function drain(reader: ScriptSourceReader): readonly ScriptTokenRecord[] {
  const records: ScriptTokenRecord[] = [];
  while (true) {
    const record = reader.next();
    if (record === undefined) return records;
    records.push(record);
  }
}

describe("incremental botlib source reader", () => {
  test("dollar evalfloat rounds token text without rounding numeric metadata", () => {
    const reader = ScriptSourceReader.open({ path: "rounding.c", text: "$evalfloat(9.0 / 8.0) $evalfloat(11.0 / 8.0)" }, noIncludes);
    const records = drain(reader);
    expect(records).toMatchObject([
      { token: { text: "1.12" }, subtype: NumberFlag.Decimal | NumberFlag.Float | NumberFlag.Long, integerValue: 1, floatValue: 1.125 },
      { token: { text: "1.38" }, subtype: NumberFlag.Decimal | NumberFlag.Float | NumberFlag.Long, integerValue: 1, floatValue: 1.375 },
    ]);
    reader.dispose();
  });

  test("source records and hash words govern published filenames, macro lookup and skip", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const events: string[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        events.push(`allocate:${size}:${clear}`);
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { events.push(`free:${allocations.indexOf(allocation)}`); owner.free(allocation); },
    };
    const globals = new ScriptGlobalDefines();
    globals.add("A 7");
    const filename = "r".repeat(80);
    const reader = ScriptSourceReader.open({ path: filename, text: "A A remaining" }, noIncludes, {
      memory, globalDefines: globals.snapshot(),
    });
    expect(events).toEqual(["allocate:2162:true", "allocate:1024:false", "allocate:3144:false", "allocate:4096:true", "allocate:34:false", "allocate:1068:false"]);
    const record = allocations[2], hash = allocations[3];
    if (record === undefined || hash === undefined) throw new Error("source record and hash allocations missing");
    const sourceView = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.length);
    const hashView = new DataView(hash.bytes.buffer, hash.bytes.byteOffset, hash.bytes.length);
    expect(reader.position.filename).toBe("r".repeat(64));
    expect(sourceView.getUint32(2052, true)).toBe(1);
    expect(sourceView.getUint32(2064, true)).toBe(1);
    expect(sourceView.getInt32(2072, true)).toBe(0);
    expect(hashView.getUint32(560 * 4, true)).toBe(1);
    record.bytes[0] = 88;
    expect(reader.position.filename).toBe("X" + "r".repeat(63));
    expect(reader.currentScriptFilename).toBe(filename);
    expect(reader.next()?.token.text).toBe("7");
    hashView.setUint32(560 * 4, 0, true);
    expect(reader.next()?.token.text).toBe("A");
    sourceView.setInt32(2072, 1, true);
    expect(reader.next()).toBeUndefined();
    reader.dispose();
    expect(events.slice(6)).toEqual(["allocate:1068:false", "free:6", "free:1", "free:0", "free:3", "free:2"]);
    zone.checkHeap();
    zone.dispose();
  });

  test("source and define-hash allocation failures retain their reached initialization", () => {
    for (const failedSize of [3144, 4096]) {
      const zone = new ZoneArena(16384);
      const owner = new BotMemory(undefined, zone);
      const allocations: BotMemoryAllocation[] = [];
      const events: string[] = [];
      const failure = new Error(`allocation ${failedSize} aborted`);
      const memory: ScriptMemory = {
        allocate(size, kind, clear) {
          events.push(`allocate:${size}:${clear}`);
          if (size === failedSize) throw failure;
          const allocation = owner.allocate(size, kind, clear);
          allocations.push(allocation);
          return allocation;
        },
        free(allocation) { events.push("free"); owner.free(allocation); },
      };
      expect(() => ScriptSourceReader.open({ path: "root.c", text: "value" }, noIncludes, { memory })).toThrow(failure);
      expect(events).toEqual(failedSize === 3144
        ? ["allocate:2154:true", "allocate:1024:false", "allocate:3144:false"]
        : ["allocate:2154:true", "allocate:1024:false", "allocate:3144:false", "allocate:4096:true"]);
      expect(allocations.map(allocation => allocation.bytes.length)).toEqual(failedSize === 3144 ? [2154, 1024] : [2154, 1024, 3144]);
      if (failedSize === 4096) {
        const record = allocations[2];
        if (record === undefined) throw new Error("source allocation must precede its hash table");
        const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.length);
        expect(new TextDecoder().decode(record.bytes.subarray(0, 7))).toBe("root.c\0");
        expect(view.getUint32(2052, true)).toBe(1);
        expect(view.getUint32(2064, true)).toBe(0);
        expect(view.getUint32(2068, true)).toBe(0);
        expect(view.getInt32(2072, true)).toBe(0);
      }
      zone.checkHeap();
      zone.dispose();
    }
  });

  test("indent records control else selection and pop before their replacement allocation", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const reader = ScriptSourceReader.open({ path: "root.c", text: "#if 1\ninside\n#else\nother\n#endif\nafter" }, noIncludes, { memory });
    expect(reader.next()?.token.text).toBe("inside");
    const record = allocations[2], firstIndent = allocations[6];
    if (record === undefined || firstIndent === undefined) throw new Error("source conditional allocations missing");
    const sourceView = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.length);
    const indentView = new DataView(firstIndent.bytes.buffer, firstIndent.bytes.byteOffset, firstIndent.bytes.length);
    expect(firstIndent.bytes.length).toBe(16);
    expect(Array.from(new Int32Array(firstIndent.bytes.buffer, firstIndent.bytes.byteOffset, 4))).toEqual([1, 0, 1, 0]);
    expect(sourceView.getUint32(2068, true)).toBe(1);
    indentView.setInt32(4, 1, true);
    sourceView.setInt32(2072, 1, true);
    expect(reader.next()?.token.text).toBe("other");
    expect(freed).toEqual([4, 5, 6]);
    expect(sourceView.getUint32(2068, true)).toBe(2);
    expect(sourceView.getInt32(2072, true)).toBe(0);
    const secondIndent = allocations[7];
    if (secondIndent === undefined) throw new Error("else must allocate a new indent");
    expect(Array.from(new Int32Array(secondIndent.bytes.buffer, secondIndent.bytes.byteOffset, 4))).toEqual([2, 0, 1, 0]);
    expect(reader.next()?.token.text).toBe("after");
    expect(freed).toEqual([4, 5, 6, 7]);
    expect(sourceView.getUint32(2068, true)).toBe(0);
    reader.dispose();
    expect(freed).toEqual([4, 5, 6, 7, 1, 0, 3, 2]);
    zone.checkHeap();
    zone.dispose();
  });

  test("an else allocation abort leaves its previous indent freed and skip restored", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    let indentCount = 0;
    const failure = new Error("else allocation aborted");
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        if (size === 16 && ++indentCount === 2) {
          expect(freed).toEqual([4, 5, 6]);
          throw failure;
        }
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const reader = ScriptSourceReader.open({ path: "root.c", text: "#if 0\nignored\n#else\nother" }, noIncludes, { memory });
    expect(() => reader.next()).toThrow(failure);
    const record = allocations[2];
    if (record === undefined) throw new Error("source record missing after indent allocation abort");
    const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.length);
    expect(view.getUint32(2068, true)).toBe(0);
    expect(view.getInt32(2072, true)).toBe(0);
    expect(freed).toEqual([4, 5, 6]);
    reader.dispose();
    expect(freed).toEqual([4, 5, 6, 1, 0, 3, 2]);
    zone.checkHeap();
    zone.dispose();
  });

  test("FreeMemory(source) releases only the record and leaves its owned descendants", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const reader = ScriptSourceReader.open({ path: "root.c", text: "#if 1\ninside" }, noIncludes, { memory });
    expect(reader.next()?.token.text).toBe("inside");
    reader.disposeRecordOnly();
    reader.dispose();
    expect(freed).toEqual([4, 5, 2]);
    expect(() => reader.next()).toThrow("freed");
    for (const [index, allocation] of allocations.entries()) {
      if (freed.includes(index)) expect(() => allocation.bytes).toThrow("freed");
      else expect(allocation.bytes.length).toBeGreaterThan(0);
    }
    zone.checkHeap();
    zone.dispose();
  });

  test("a compressed NUL before end_p pops its script while retaining the unmatched indent and skip", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const resolver: IncludeResolver = { resolve: () => {
      const text = "#if 0\nskipped\n\n";
      const storage = allocateScriptSource(text.length, "child.h", memory);
      storage.copyText(text);
      storage.compress();
      expect(storage.length).toBeLessThan(storage.buffer.length);
      return storage;
    } };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "child.h"\nafter' }, resolver, { memory });
    expect(reader.next()).toBeUndefined();
    expect(reader.diagnostics).toEqual([]);
    expect(reader.currentScriptFilename).toBe("root.c");
    expect(freed).toEqual([6, 7, 5, 4]);
    const record = allocations[2];
    if (record === undefined) throw new Error("source record missing");
    const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.length);
    expect(view.getUint32(2052, true)).toBe(1);
    expect(view.getUint32(2068, true)).toBe(1);
    expect(view.getInt32(2072, true)).toBe(1);
    reader.dispose();
    expect(freed).toEqual([6, 7, 5, 4, 1, 0, 8, 3, 2]);
    zone.checkHeap();
    zone.dispose();
  });

  test("a returned include lexer error frees that script and resumes its parent", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const reports: ScriptDiagnostic[] = [];
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "child.h"\nafter' }, {
      resolve: () => ({ path: "child.h", text: "@" }),
    }, { memory, report: diagnostic => { reports.push(diagnostic); } });
    expect(reader.next()?.token.text).toBe("after");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.location.path).toBe("child.h");
    expect(reports[0]?.severity).toBe("error");
    expect(freed).toEqual([5, 4]);
    reader.dispose();
    expect(freed).toEqual([5, 4, 1, 0, 3, 2]);
    zone.checkHeap();
    zone.dispose();
  });

  test("string concatenation retains its current string after a returned lookahead error", () => {
    const reports: ScriptDiagnostic[] = [];
    const reader = ScriptSourceReader.open({ path: "root.c", text: '"kept"\n#error stop\n;' }, noIncludes, {
      report: diagnostic => { reports.push(diagnostic); },
    });
    expect(reader.next()?.token.text).toBe('"kept"');
    expect(reports.map(diagnostic => diagnostic.message)).toEqual(["#error directive: stop"]);
    expect(reader.next()?.token.text).toBe(";");
    reader.dispose();
  });

  test("string lookahead propagates the original ScriptLanguageError from report and include callbacks", () => {
    const failure = new ScriptLanguageError({
      severity: "error", message: "callback aborted", location: { path: "callback", line: 1, column: 1 },
    }, []);
    for (const text of ['"kept"\n#error stop', '"kept"\n#include "bad.h"']) {
      const reader = ScriptSourceReader.open({ path: "root.c", text }, { resolve: () => { throw failure; } }, {
        report: () => { throw failure; },
      });
      let caught: unknown;
      try { reader.next(); } catch (error) { caught = error; }
      expect(caught).toBe(failure);
      reader.dispose();
    }
  });

  test("FreeSource releases an unfinished include stack before the retained root", () => {
    const zone = new ZoneArena(32768);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const resolver: IncludeResolver = { resolve: request => ({
      path: request.requestedPath,
      text: request.requestedPath === "outer.h" ? '#if 1\n#include "inner.h"\nouter' : "#if 1\ninside",
    }) };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "outer.h"\nafter' }, resolver, {
      memory, report: () => { throw new Error("FreeSource must not synthesize EOF warnings"); },
    });
    expect(reader.next()?.token.text).toBe("inside");
    expect(allocations).toHaveLength(14);
    expect(freed).toEqual([6, 7, 11, 12]);
    reader.dispose();
    reader.dispose();
    expect(freed).toEqual([6, 7, 11, 12, 10, 9, 5, 4, 1, 0, 13, 8, 3, 2]);
    expect(() => reader.next()).toThrow("freed");
    for (const allocation of allocations) expect(() => allocation.bytes).toThrow("freed");
    zone.checkHeap();
    zone.dispose();
  });

  test("a throwing include EOF warning retains its source stack until explicit disposal", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const failure = new Error("warning callback aborted");
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: "#if 1\ninside" }) };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "child.h"\nafter' }, resolver, {
      memory,
      report(diagnostic) {
        expect(diagnostic.message).toBe("missing #endif");
        expect(reader.currentScriptFilename).toBe("child.h");
        expect(freed).toEqual([6, 7]);
        throw failure;
      },
    });
    expect(reader.next()?.token.text).toBe("inside");
    expect(() => reader.next()).toThrow(failure);
    expect(freed).toEqual([6, 7]);
    expect(reader.currentScriptFilename).toBe("child.h");
    expect(allocations).toHaveLength(9);
    reader.dispose();
    expect(freed).toEqual([6, 7, 5, 4, 1, 0, 8, 3, 2]);
    zone.checkHeap();
    zone.dispose();
  });

  test("global definition memory follows strlen and frees after returned parse diagnostics before publication", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const events: string[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        events.push(`allocate:${size}`);
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) {
        events.push(`free:${allocations.indexOf(allocation)}`);
        expect(globals.snapshot().definitions).toHaveLength(0);
        owner.free(allocation);
      },
    };
    const globals = new ScriptGlobalDefines(diagnostic => {
      events.push(`report:${diagnostic.message}`);
      expect(events.filter(event => event.startsWith("free:"))).toEqual(["free:4"]);
    }, memory);
    expect(globals.add("BAD(a,a) a")).toBe(false);
    expect(events).toEqual(["allocate:2159", "allocate:1024", "allocate:4096", "allocate:36", "allocate:1068", "free:4", "allocate:1068", "report:two the same define parameters", "free:2", "free:1", "free:0"]);
    events.length = 0;
    expect(globals.add("VALUE 7\0ignored")).toBe(true);
    expect(events).toEqual(["allocate:2156", "allocate:1024", "allocate:4096", "allocate:38", "allocate:1068", "free:8", "free:7", "free:6"]);
    expect(globals.snapshot().definitions).toHaveLength(1);
    expect(ScriptSourceReader.open({ path: "root.c", text: "VALUE" }, noIncludes, { globalDefines: globals.snapshot() }).next()?.token.text).toBe("7");
    globals.clear();
    expect(events.slice(-2)).toEqual(["free:10", "free:9"]);
    const failedDefine = allocations[3], failedParameter = allocations[5];
    if (failedDefine === undefined || failedParameter === undefined) throw new Error("failed global definition records missing");
    expect(failedDefine.bytes.length).toBe(36);
    expect(failedParameter.bytes.length).toBe(1068);
    zone.checkHeap();
    zone.dispose();
  });

  test("a throwing global diagnostic prevents temporary script frees and global publication", () => {
    const zone = new ZoneArena(16384);
    const owner = new BotMemory(undefined, zone);
    const allocations: BotMemoryAllocation[] = [];
    const freed: number[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) {
        const allocation = owner.allocate(size, kind, clear);
        allocations.push(allocation);
        return allocation;
      },
      free(allocation) { freed.push(allocations.indexOf(allocation)); owner.free(allocation); },
    };
    const failure = new ScriptLanguageError({
      severity: "error", message: "diagnostic callback aborted", location: { path: "callback", line: 1, column: 1 },
    }, []);
    const globals = new ScriptGlobalDefines(diagnostic => {
      expect(diagnostic.message).toBe("recursive define (removed recursion)");
      expect(allocations.map(allocation => allocation.bytes.length)).toEqual([2162, 1024, 4096, 38, 1068]);
      throw failure;
    }, memory);
    expect(() => globals.add("VALUE VALUE 7")).toThrow(failure);
    expect(freed).toEqual([]);
    expect(globals.snapshot().definitions).toHaveLength(0);
    expect(allocations.map(allocation => allocation.bytes.length)).toEqual([2162, 1024, 4096, 38, 1068]);
    zone.checkHeap();
    zone.dispose();
  });

  test("opens without lexing later input and resolves each include at its reached read", () => {
    const files = new Map<string, string>();
    const requests: IncludeRequest[] = [];
    const resolver: IncludeResolver = { resolve: request => {
      requests.push(request);
      const text = files.get(request.requestedPath);
      return text === undefined ? undefined : { path: `opened/${request.requestedPath}`, text };
    } };
    const reader = ScriptSourceReader.open({ path: "root.c", text: 'first\n#include "later.h"\nafter\n' }, resolver);
    expect(requests).toEqual([]);
    expect(reader.position).toEqual({ filename: "root.c", line: 1 });
    expect(reader.next()?.token.text).toBe("first");
    expect(requests).toEqual([]);
    files.set("later.h", "\n\ninside");
    expect(reader.next()?.token.text).toBe("inside");
    expect(requests).toEqual([{ kind: "quoted", fromPath: "root.c", requestedPath: "later.h" }]);
    expect(reader.position).toEqual({ filename: "root.c", line: 3 });
    expect(reader.currentScriptFilename).toBe("opened/later.h");
    files.delete("later.h");
    expect(reader.next()?.token.text).toBe("after");
    expect(reader.currentScriptFilename).toBe("root.c");
    expect(reader.next()).toBeUndefined();
    expect(reader.position).toEqual({ filename: "root.c", line: 4 });
    expect(reader.next()).toBeUndefined();
    expect(reader.position).toEqual({ filename: "root.c", line: 4 });
  });

  test("delivers a valid prefix before a missing include while eager create still throws", () => {
    const source = { path: "missing.c", text: 'valid\n#include "absent.h"\n' };
    const reports: ScriptDiagnostic[] = [];
    const reader = ScriptSourceReader.open(source, noIncludes, { report: diagnostic => { reports.push(diagnostic); } });
    expect(reader.next()?.token.text).toBe("valid");
    expect(reports).toEqual([]);
    expect(() => reader.next()).toThrow("file absent.h not found");
    expect(reader.diagnostics).toEqual(reports);
    expect(reports).toHaveLength(1);
    expect(reader.position).toEqual({ filename: "missing.c", line: 2 });
    expect(() => ScriptPreprocessor.create(source, noIncludes)).toThrow("file absent.h not found");
  });

  test("delivers a valid prefix before malformed trailing text without converting the error to EOF", () => {
    const source = { path: "malformed.c", text: 'valid\n"unterminated' };
    const reader = ScriptSourceReader.open(source, noIncludes);
    expect(reader.next()?.token.text).toBe("valid");
    expect(reader.diagnostics).toEqual([]);
    expect(() => reader.next()).toThrow(ScriptLanguageError);
    expect(reader.diagnostics[0]?.message).toBe("missing trailing quote");
    expect(reader.position).toEqual({ filename: "malformed.c", line: 2 });
    expect(() => ScriptPreprocessor.create(source, noIncludes)).toThrow("missing trailing quote");
  });

  test("reads quoted and system include filenames before later root tokens", () => {
    const resolver: IncludeResolver = { resolve: request => ({ path: request.requestedPath, text: "included" }) };
    const source = { path: "root.c", text: '#include "quoted.h" quotedTail\n#include <system.h> systemTail' };
    expect(drain(ScriptSourceReader.open(source, resolver)).map(record => record.token.text))
      .toEqual(["included", "quotedTail", "included", "systemTail"]);
  });

  test("string lookahead retains the root filename and active include line with queued tokens", () => {
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: '"second"\nthird\n' }) };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '"first"\n#include "child.h"\nstop\n' }, resolver);
    const first = reader.next();
    expect(first).toMatchObject({ token: { text: '"firstsecond"', length: 13 }, subtype: 7, integerValue: 0, floatValue: 0 });
    expect(reader.position).toEqual({ filename: "root.c", line: 2 });
    expect(reader.currentScriptFilename).toBe("child.h");
    expect(reader.next()?.token.text).toBe("third");
    expect(reader.position).toEqual({ filename: "root.c", line: 2 });
    expect(reader.next()?.token.text).toBe("stop");
    expect(reader.position).toEqual({ filename: "root.c", line: 3 });
    expect(reader.currentScriptFilename).toBe("root.c");
  });

  test("string lookahead pops exhausted includes and retains the root frame at EOF", () => {
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: '"child"\n\n' }) };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "child.h"\n\n' }, resolver);
    expect(reader.next()?.token.text).toBe('"child"');
    expect(reader.position).toEqual({ filename: "root.c", line: 3 });
    expect(reader.currentScriptFilename).toBe("root.c");
    expect(reader.next()).toBeUndefined();
    expect(reader.position).toEqual({ filename: "root.c", line: 3 });
  });

  test("eager and incremental paths share macro, include and adjacent string behavior", () => {
    const source = { path: "root.c", text: '#define VALUE "b"\n#define UNUSED 1\n"a" VALUE\n#include "child.h"\nlast' };
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: '"c" more' }) };
    const records = drain(ScriptSourceReader.open(source, resolver));
    expect(records.map(record => record.token.text)).toEqual(['"abc"', "more", "last"]);
    expect(records[0]?.subtype).toBe(3);
    expect(ScriptPreprocessor.create(source, resolver).all()).toEqual(records.map(record => record.token));
  });

  test("closes an include's final conditional before popping its lexer", () => {
    const source = { path: "root.c", text: '#define VALUE 1\n#include "child.h"\nafter' };
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: "#ifdef VALUE\ninside\n#endif" }) };
    const reader = ScriptSourceReader.open(source, resolver);
    expect(drain(reader).map(record => record.token.text)).toEqual(["inside", "after"]);
    expect(reader.diagnostics).toEqual([]);
  });

  test("uses the live parent conditional when a child's final hash reads its name from the parent", () => {
    const source = { path: "root.c", text: '#if 1\n#include "child.h"endif\nafter' };
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: "#" }) };
    const reader = ScriptSourceReader.open(source, resolver);
    expect(reader.next()?.token.text).toBe("after");
    expect(reader.position).toEqual({ filename: "root.c", line: 3 });
    expect(reader.currentScriptFilename).toBe("root.c");
    expect(reader.next()).toBeUndefined();
    expect(reader.diagnostics).toEqual([]);
  });

  test("uses the live parent filename for an include directive read after its child hash", () => {
    const requests: IncludeRequest[] = [];
    const resolver: IncludeResolver = { resolve: request => {
      requests.push(request);
      return request.requestedPath === "child.h"
        ? { path: "child.h", text: "#" }
        : { path: "next.h", text: "included" };
    } };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "child.h"include "next.h"' }, resolver);
    expect(reader.next()?.token.text).toBe("included");
    expect(requests).toEqual([
      { kind: "quoted", fromPath: "root.c", requestedPath: "child.h" },
      { kind: "quoted", fromPath: "root.c", requestedPath: "next.h" },
    ]);
  });

  test("reports missing include conditionals on the reached EOF before restoring the parent", () => {
    const reports: ScriptDiagnostic[] = [];
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: "#if 1\ninside\n" }) };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "child.h"\nafter' }, resolver, {
      report: diagnostic => { reports.push(diagnostic); },
    });
    expect(reader.next()?.token.text).toBe("inside");
    expect(reports).toEqual([]);
    expect(reader.currentScriptFilename).toBe("child.h");
    expect(reader.next()?.token.text).toBe("after");
    expect(reports).toMatchObject([{ message: "missing #endif", location: { path: "child.h", line: 3 } }]);
    expect(reader.currentScriptFilename).toBe("root.c");
    expect(reader.next()).toBeUndefined();
    expect(reports).toHaveLength(1);
  });

  test("preserves the source skipped-string lookahead that can cross an endif", () => {
    const source = { path: "skip.c", text: '#ifdef SELECTED\n#define NAME "yes"\n#else\n#define NAME "no"\n#endif\nafter NAME' };
    const options = { initialDefines: ["SELECTED"] };
    const records = drain(ScriptSourceReader.open(source, noIncludes, options));
    expect(records.map(record => record.token.text)).toEqual(['"no"', "after", '"yes"']);
    expect(ScriptPreprocessor.create(source, noIncludes, options).all()).toEqual(records.map(record => record.token));
  });

  test("retains left subtypes through pasted names and strings and zeroes ordinary nonnumeric fields", () => {
    const reader = ScriptSourceReader.open({ path: "paste.c", text: '#define JOIN(a,b) a ## b\nJOIN(menu,Def) JOIN("x","yz") \'z\' + 12.5' }, noIncludes);
    const records = drain(reader);
    expect(records.map(record => record.token.text)).toEqual(["menuDef", '"xyz"', "'z'", "+", "12.5"]);
    expect(records.map(record => [record.subtype, record.integerValue, record.floatValue])).toEqual([
      [4, 0, 0],
      [3, 0, 0],
      [3, 0, 0],
      [Punctuation.Add, 0, 0],
      [NumberFlag.Decimal | NumberFlag.Float, 12, 12.5],
    ]);
  });

  test("publishes the lexer NumberValue fields without normalizing malformed numeric text", () => {
    const reader = ScriptSourceReader.open({ path: "numbers.c", text: "1.2.3 10." }, noIncludes);
    expect(reader.next()).toMatchObject({ token: { text: "1.2.3" }, subtype: NumberFlag.Decimal | NumberFlag.Float, integerValue: 0, floatValue: 1.2 });
    expect(reader.next()).toMatchObject({ token: { text: "10." }, subtype: NumberFlag.Decimal | NumberFlag.Float, integerValue: 5, floatValue: 5.2 });
  });

  test("reports expanded-macro errors at the live root source rather than the definition", () => {
    const reports: ScriptDiagnostic[] = [];
    const resolver: IncludeResolver = { resolve: () => ({ path: "child.h", text: "#define FUN(x) x\n#define ALIAS FUN" }) };
    const reader = ScriptSourceReader.open({ path: "root.c", text: '#include "child.h"\nALIAS' }, resolver, {
      report: diagnostic => { reports.push(diagnostic); },
    });
    expect(() => reader.next()).toThrow("define FUN missing parms");
    expect(reports).toMatchObject([{ severity: "error", location: { path: "root.c", line: 2 } }]);
    expect(reader.diagnostics).toEqual(reports);
  });

  test("omits nested opening parentheses and ends arguments at the first inner closing parenthesis", () => {
    const source = { path: "arguments.c", text: "#define F(x) x\nF((one))" };
    const reader = ScriptSourceReader.open(source, noIncludes);
    expect(drain(reader).map(record => record.token.text)).toEqual(["one", ")"]);
    expect(reader.diagnostics).toEqual([]);
    expect(ScriptPreprocessor.create(source, noIncludes).all().map(token => token.text)).toEqual(["one", ")"]);
  });

  test("unread records retain metadata without rewinding the current source position", () => {
    const reader = ScriptSourceReader.open({ path: "read.c", text: "one\nsecond\n" }, noIncludes);
    const first = reader.next();
    const second = reader.next();
    if (first === undefined || second === undefined) throw new Error("fixture tokens are missing");
    reader.unreadLast();
    reader.unread(first);
    expect(reader.position).toEqual({ filename: "read.c", line: 2 });
    expect(reader.next()).toEqual(first);
    expect(reader.next()).toEqual(second);
    expect(reader.next()).toBeUndefined();
  });

  test("qualifies source-uninitialized evaluation and stringizing records while keeping eager typed values", () => {
    const sources = ["#eval 7", "$evalint(-5)", "#define TEXT(x) #x\nTEXT(word)"];
    for (const text of sources) {
      const source = { path: "uninitialized.c", text };
      expect(ScriptPreprocessor.create(source, noIncludes).all().length).toBeGreaterThan(0);
      expect(() => ScriptSourceReader.open(source, noIncludes).next()).toThrow("source token profile is unsupported");
    }
    const evaluated = ScriptSourceReader.open({ path: "dollar.c", text: "$evalfloat(3.0 / 2.0)" }, noIncludes).next();
    expect(evaluated).toMatchObject({ token: { text: "1.50" }, subtype: NumberFlag.Decimal | NumberFlag.Float | NumberFlag.Long, integerValue: 1, floatValue: 1.5 });
  });
});
