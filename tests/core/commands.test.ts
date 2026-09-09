import { describe, expect, test } from "bun:test";

import { CommandBuffer } from "../../src/core/commands.ts";
import type { CommandFallbackResolver, CommandHandler } from "../../src/core/commands.ts";
import { SourceZoneStrings } from "../../src/core/zone-strings.ts";
import { ZoneArena, ZoneTag } from "../../src/core/zone.ts";
import type { ZoneAllocation } from "../../src/core/zone.ts";

class ObservedCommandZone extends ZoneArena {
  readonly trace: string[] = [];
  readonly allocated: ZoneAllocation[] = [];

  override allocate(size: number, tag: number, clear = false): ZoneAllocation {
    this.trace.push(`allocate:${size}:${tag}:${clear}`);
    const allocation = super.allocate(size, tag, clear);
    this.allocated.push(allocation);
    return allocation;
  }

  override free(allocation: ZoneAllocation | null): void {
    this.trace.push(`free:${allocation?.bytes.length ?? "null"}`);
    super.free(allocation);
  }
}

function resolveSynchronously(handler: CommandHandler): CommandFallbackResolver {
  return () => ({ kind: "sync", handler });
}

describe("CommandBuffer", () => {
  test("retained arguments follow fixed token bytes while empty tokenizations leave storage intact", () => {
    const commands = new CommandBuffer();
    commands.tokenize("cvarlist a*");
    const filter = commands.argumentReference(1);
    commands.tokenize("echo zzzzb*");
    expect(commands.argumentReference(1).value).toBe("zzzzb*");
    expect(filter.value).toBe("b*");
    for (const input of [null, "", " // no tokens", "/* no tokens */"]) {
      expect(commands.tokenize(input)).toEqual([]);
      expect(filter.value).toBe("b*");
    }
    commands.tokenize('prefix "" tail');
    const empty = commands.argumentReference(1), missing = commands.argumentReference(3);
    expect(empty.value).toBe("");
    expect(empty.offset(1).value).toBe("tail");
    commands.tokenize("x");
    expect(empty.offset(1).value).toBe("tail");
    expect(missing.value).toBe("");
    expect(() => missing.offset(1)).toThrow("Undefined native command token pointer");
    expect(() => filter.offset(-100)).toThrow("Undefined native command token pointer");
  });

  test("source commands use actual record and name allocations in Cmd_Add/Remove order", () => {
    const zone = new ObservedCommandZone(2048, "small");
    const printed: string[] = [];
    const commands = new CommandBuffer({ strings: new SourceZoneStrings(zone), waitRegistration: "manual",
      print: text => { printed.push(text); } });
    const trace: string[] = [];
    commands.register("alpha", () => { trace.push("called"); });
    expect(zone.trace).toEqual(["allocate:12:4:false", "allocate:6:4:false"]);
    expect(zone.memoryRemaining()).toBe(2048 - 36 - 32);
    const record = zone.allocated[0], name = zone.allocated[1];
    if (record === undefined || name === undefined) throw new Error("Expected actual command allocations");
    expect([...name.bytes]).toEqual([97, 108, 112, 104, 97, 0]);
    name.bytes.set([111, 109, 101, 103, 97]);
    expect(commands.registeredNames()).toEqual(["omega"]);
    commands.register("omega", () => {});
    commands.registerFallbackName("omega");
    expect(printed).toEqual(["Cmd_AddCommand: omega already defined\n"]);
    expect(zone.trace).toHaveLength(2);
    commands.executeNow("OMEGA");
    expect(trace).toEqual(["called"]);
    expect(commands.unregister("OMEGA")).toBe(false);
    expect(commands.unregister("omega")).toBe(true);
    expect(zone.trace).toEqual(["allocate:12:4:false", "allocate:6:4:false", "free:6", "free:12"]);
    expect(commands.registeredNames()).toEqual([]);
    expect(zone.memoryRemaining()).toBe(2048);
    expect(() => record.bytes).toThrow("no longer valid");
    expect(() => name.bytes).toThrow("no longer valid");
    zone.checkHeap();
  });

  test("static digit command names still own a record and reject a freed record", () => {
    const zone = new ObservedCommandZone(1024, "small");
    const commands = new CommandBuffer({ strings: new SourceZoneStrings(zone), waitRegistration: "manual" });
    commands.register("7", () => {});
    expect(zone.trace).toEqual(["allocate:12:4:false"]);
    expect(commands.unregister("7")).toBe(true);
    expect(zone.trace).toEqual(["allocate:12:4:false", "free:12"]);
    commands.register("7", () => {});
    zone.freeTags(ZoneTag.Small);
    expect(() => commands.registeredNames()).toThrow("no longer valid");
    expect(() => commands.executeNow("7")).toThrow("no longer valid");
  });

  test("name allocation failure leaves the preceding record allocated and unpublished", () => {
    const zone = new ObservedCommandZone(128, "small");
    const commands = new CommandBuffer({ strings: new SourceZoneStrings(zone), waitRegistration: "manual" });
    expect(() => commands.register("alpha", () => {})).toThrow("failed on allocation");
    expect(zone.trace).toEqual(["allocate:12:4:false", "allocate:6:4:false"]);
    expect(zone.memoryRemaining()).toBe(32);
    expect(commands.registeredNames()).toEqual([]);
    zone.checkHeap();
  });

  test("completion entries move before fallback resolution without a second move after it", () => {
    const zone = new ZoneArena(2048, "small"), trace: string[] = [];
    const commands = new CommandBuffer({ strings: new SourceZoneStrings(zone), waitRegistration: "manual",
      resolveFallback: () => {
        trace.push(commands.registeredNames().join(","));
        commands.register("created", () => {});
        return { kind: "sync", handler: () => { trace.push(commands.registeredNames().join(",")); } };
      },
    });
    commands.registerFallbackName("ghost");
    commands.register("later", () => {});
    commands.executeNow("GHOST");
    expect(trace).toEqual(["ghost,later", "created,ghost,later"]);
    expect(commands.unregister("ghost")).toBe(true);
    expect(commands.registeredNames()).toEqual(["created", "later"]);
    expect(commands.unregister("later")).toBe(true);
    expect(commands.unregister("created")).toBe(true);
    expect(zone.memoryRemaining()).toBe(2048);
    zone.checkHeap();
  });

  test("execution entry rejection preserves empty, immediate, buffered and wait drains", async () => {
    let permitted = false;
    const trace: string[] = [];
    const commands = new CommandBuffer({ assertExecutionEntry: () => {
      if (!permitted) throw new Error("Command owner is not current");
    }, resolveFallback: resolveSynchronously(context => { trace.push(context.raw); }) });
    commands.register("record", context => { trace.push(context.args.join(" ")); });
    commands.registerAsync("async", async () => { trace.push("async"); });
    expect(() => commands.execute()).toThrow("Command owner is not current");
    await expect(commands.executeAsync()).rejects.toThrow("Command owner is not current");
    permitted = true;
    commands.append("wait 2;record pending"); expect(commands.execute()).toBe(1);
    const names = commands.registeredNames();
    permitted = false;
    for (const text of [null, "", " ", "record forbidden", "unknown", "async"] satisfies readonly (string | null)[]) {
      expect(() => commands.executeNow(text)).toThrow("Command owner is not current");
      await expect(commands.executeNowAsync(text)).rejects.toThrow("Command owner is not current");
      expect(commands.pendingText).toBe("record pending");
      expect(commands.registeredNames()).toEqual(names);
    }
    expect(() => commands.execute()).toThrow("Command owner is not current");
    await expect(commands.executeAsync()).rejects.toThrow("Command owner is not current");
    expect(trace).toEqual([]);
    permitted = true;
    expect(await commands.executeAsync()).toBe(0);
    expect(commands.pendingText).toBe("record pending");
    expect(commands.execute()).toBe(1); expect(trace).toEqual(["pending"]);
  });

  test("manual wait registration follows the caller's native Cmd_Init point", () => {
    const printed: string[] = [];
    const commands = new CommandBuffer({ waitRegistration: "manual", print: text => { printed.push(text); } });
    expect(commands.registeredNames()).toEqual([]);
    commands.register("echo", () => {}); commands.registerWaitCommand();
    expect(commands.registeredNames()).toEqual(["wait", "echo"]);
    commands.registerWaitCommand();
    expect(printed).toEqual(["Cmd_AddCommand: wait already defined\n"]);
    commands.append("wait 1;echo"); expect(commands.execute()).toBe(1); expect(commands.pendingText).toBe("echo");
  });
  test("owns immutable source-order name snapshots and moves dispatched commands to the head", async () => {
    const commands = new CommandBuffer();
    commands.register("FIRST", () => {}); commands.register("second", () => {});
    commands.registerAsync("async", async () => {});
    const before = commands.registeredNames();
    expect(before).toEqual(["async", "second", "FIRST", "wait"]);
    expect(Object.isFrozen(before)).toBe(true);
    commands.executeNow("first");
    expect(commands.registeredNames()).toEqual(["FIRST", "async", "second", "wait"]);
    expect(() => commands.executeNow("async")).toThrow("asynchronous command");
    expect(commands.registeredNames()).toEqual(["FIRST", "async", "second", "wait"]);
    await commands.executeNowAsync("async");
    expect(commands.registeredNames()).toEqual(["async", "FIRST", "second", "wait"]);
    expect(commands.unregister("first")).toBe(false);
    commands.unregister("FIRST");
    expect(commands.registeredNames()).toEqual(["async", "second", "wait"]);
    expect(before).toEqual(["async", "second", "FIRST", "wait"]);
  });
  test("splits buffered comments before tokenization while preserving quoted semicolons", () => {
    const unknown: string[] = [];
    const commands = new CommandBuffer({ resolveFallback: resolveSynchronously(context => { unknown.push(context.raw); }) });
    const trace: string[][] = [];
    commands.register("record", (context) => { trace.push(Array.from(context.args)); });
    commands.append('record one; record "two;still" // ; ignored\nrecord ""\nrecord three/* ; ignored */;record four');

    expect(commands.execute()).toBe(7);
    expect(trace).toEqual([
      ["one"],
      ["two;still"],
      [""],
      ["three"],
      ["four"],
    ]);
    expect(commands.pendingText).toBe("");
    expect(unknown).toEqual([" ignored", " ignored */"]);
  });

  test("insert runs before already buffered text while append runs after it", () => {
    const commands = new CommandBuffer();
    const trace: string[] = [];
    commands.register("record", (context) => { trace.push(context.args.join(" ")); });
    commands.register("expand", (context) => {
      context.append("record appended");
      context.insert("record inserted");
    });
    commands.append("expand;record existing;");

    commands.execute();
    expect(trace).toEqual(["inserted", "existing", "appended"]);
  });

  test("wait delays the remainder for the requested frame count", () => {
    const commands = new CommandBuffer();
    const trace: string[] = [];
    commands.register("record", (context) => { trace.push(context.args.join(" ")); });
    commands.append("record first;wait 2;record last");

    expect(commands.execute()).toBe(2);
    expect(trace).toEqual(["first"]);
    expect(commands.execute()).toBe(0);
    expect(trace).toEqual(["first"]);
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["first", "last"]);
  });

  test("bounds command work while leaving unexecuted text buffered", () => {
    const commands = new CommandBuffer({ maxCommandsPerExecute: 2 });
    const trace: string[] = [];
    commands.register("record", (context) => { trace.push(context.args.join(" ")); });
    commands.append("record one;record two;record three");

    expect(() => commands.execute()).toThrow("command execution exceeded work limit 2");
    expect(trace).toEqual(["one", "two"]);
    expect(commands.pendingText).toBe("record three");
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["one", "two", "three"]);
  });

  test("bounds recursive execution caused by handlers", () => {
    const commands = new CommandBuffer({ maxRecursion: 2 });
    commands.register("loop", () => {
      commands.insert("loop");
      commands.execute();
    });
    commands.append("loop");

    expect(() => commands.execute()).toThrow("command execution exceeded recursion limit 2");
  });

  test("passes unknown commands to the configured fallback", () => {
    const trace: string[] = [];
    const commands = new CommandBuffer({
      resolveFallback: resolveSynchronously(context => { trace.push(context.raw); }),
    });
    commands.append("not_local 1 2");

    commands.execute();
    expect(trace).toEqual(["not_local 1 2"]);
  });

  test("preserves source registration order for case variants and fallthrough names", () => {
    const trace: string[] = [];
    let commands: CommandBuffer | undefined;
    const fallback: CommandHandler = context => {
      if (commands === undefined) throw new Error("Command fixture is not initialized");
      trace.push(`head:${commands.registeredNames()[0] ?? ""}`);
      trace.push(`fallback:${context.argv[0] ?? ""}`);
    };
    commands = new CommandBuffer({ resolveFallback: resolveSynchronously(fallback) });
    commands.register("Case", () => { trace.push("old"); });
    commands.register("case", () => { trace.push("new"); });
    commands.registerFallbackName("ghost");
    commands.register("later", () => { trace.push("later"); });
    expect(commands.registeredNames()).toEqual(["later", "ghost", "case", "Case", "wait"]);

    expect(commands.executeNow("GHOST")).toBe(1);
    expect(trace).toEqual(["head:ghost", "fallback:GHOST"]);
    expect(commands.registeredNames()).toEqual(["ghost", "later", "case", "Case", "wait"]);
    expect(commands.executeNow("CASE")).toBe(1);
    expect(trace).toEqual(["head:ghost", "fallback:GHOST", "new"]);

    expect(commands.unregister("case")).toBe(true);
    expect(commands.executeNow("case")).toBe(1);
    expect(trace).toEqual(["head:ghost", "fallback:GHOST", "new", "old"]);
  });

  test("warns about executable duplicates and retains the existing handler while NULL-style duplicates are silent", () => {
    const printed: string[] = [], called: string[] = [];
    const commands = new CommandBuffer({ print: text => { printed.push(text); },
      resolveFallback: resolveSynchronously(context => { called.push(`fallback:${context.raw}`); }) });
    commands.register("known", () => { called.push("original"); });
    commands.register("later", () => {});
    const before = commands.registeredNames();
    commands.register("known", () => { called.push("replacement"); });
    commands.registerFallbackName("known");
    expect(commands.registeredNames()).toEqual(before);
    expect(commands.registeredNames().filter(name => name === "known")).toHaveLength(1);
    commands.executeNow("known");
    expect(called).toEqual(["original"]);

    commands.registerFallbackName("completion");
    commands.registerFallbackName("completion");
    expect(commands.registeredNames().filter(name => name === "completion")).toHaveLength(1);
    commands.register("completion", () => { called.push("replacement"); });
    commands.executeNow("completion");
    expect(called).toEqual(["original", "fallback:completion"]);
    expect(printed).toEqual(["Cmd_AddCommand: known already defined\n", "Cmd_AddCommand: completion already defined\n"]);
  });

  test("source registration lists and removes names independent of tokenization", () => {
    const commands = new CommandBuffer(), called: string[] = [];
    for (const name of ["", "two words", "two;commands", "\"quoted\"", "\u00c0"]) {
      commands.register(name, () => { called.push(name); });
    }
    commands.registerFallbackName("completion name");
    expect(commands.registeredNames()).toEqual(["completion name", "\u00c0", "\"quoted\"", "two;commands", "two words", "", "wait"]);
    const completed: string[] = [];
    commands.completeNames(name => { completed.push(name); });
    expect(completed).toEqual([...commands.registeredNames()]);
    commands.executeNow('"two words"');
    expect(called).toEqual(["two words"]);
    for (const name of completed.slice(0, -1)) expect(commands.unregister(name)).toBe(true);
    expect(commands.registeredNames()).toEqual(["wait"]);
  });

  test("registration and removal consume source byte strings through the first NUL", () => {
    const printed: string[] = [], commands = new CommandBuffer({ print: text => { printed.push(text); } });
    commands.register("name\0ignored", () => {});
    commands.register("name", () => {});
    commands.registerFallbackName("other\0ignored");
    expect(commands.registeredNames()).toEqual(["other", "name", "wait"]);
    expect(printed).toEqual(["Cmd_AddCommand: name already defined\n"]);
    expect(commands.unregister("name\0ignored")).toBe(true);
    expect(commands.unregister("other\0ignored")).toBe(true);
    expect(() => commands.register("\u0100", () => {})).toThrow("requires source bytes");
    expect(() => commands.registerFallbackName("\u0100")).toThrow("requires source bytes");
    expect(() => commands.unregister("\u0100")).toThrow("requires source bytes");
  });

  test("default source execution completes finite buffers beyond 4096 commands", async () => {
    const commands = new CommandBuffer();
    let calls = 0;
    commands.register("x", () => { calls++; });
    commands.append("x;".repeat(4097));
    expect(commands.execute()).toBe(4097);
    expect(calls).toBe(4097);
    expect(commands.pendingText).toBe("");
    commands.registerAsync("y", async () => { calls++; });
    commands.append("y;".repeat(4097));
    expect(await commands.executeAsync()).toBe(4097);
    expect(calls).toBe(8194);
    expect(commands.pendingText).toBe("");
  });

  test("default source execution completes finite sync and async nesting beyond depth eight", async () => {
    const commands = new CommandBuffer();
    let calls = 0;
    commands.register("nested", () => {
      calls++;
      if (calls < 16) commands.executeNow("nested");
    });
    expect(commands.executeNow("nested")).toBe(1);
    expect(calls).toBe(16);
    calls = 0;
    commands.registerAsync("nestedAsync", async () => {
      calls++;
      if (calls < 16) await commands.executeNowAsync("nestedAsync");
    });
    expect(await commands.executeNowAsync("nestedAsync")).toBe(1);
    expect(calls).toBe(16);
  });

  test("explicit diagnostic execution limits require positive integers", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new CommandBuffer({ maxCommandsPerExecute: value })).toThrow("positive integer");
      expect(() => new CommandBuffer({ maxRecursion: value })).toThrow("positive integer");
    }
  });

  test("EXEC_NOW executes one unsplit command without draining pending text or observing wait", () => {
    const commands = new CommandBuffer(), trace: string[][] = [];
    commands.register("record", context => { trace.push([...context.args]); });
    commands.append("wait 2;record buffered");
    expect(commands.execute()).toBe(1);
    expect(commands.executeNow("record immediate;record not-separate")).toBe(1);
    expect(trace).toEqual([["immediate;record", "not-separate"]]);
    expect(commands.pendingText).toBe("record buffered");
    expect(commands.executeNow(" ")).toBe(0);
    expect(commands.executeNow("")).toBe(0);
    expect(commands.executeNow(null)).toBe(1);
    expect(trace.at(-1)).toEqual(["buffered"]);
  });

  test("immediate nested execution shares work and recursion limits and preserves queued order", () => {
    const commands = new CommandBuffer({ maxCommandsPerExecute: 3 }), trace: string[] = [];
    commands.register("record", context => { trace.push(context.args.join(" ")); });
    commands.register("nested", () => { commands.executeNow("record immediate"); commands.insert("record inserted"); });
    commands.append("nested;record buffered");
    expect(() => commands.execute()).toThrow("work limit 3");
    expect(trace).toEqual(["immediate", "inserted"]);
    expect(commands.pendingText).toBe("record buffered");
    commands.execute();
    expect(trace).toEqual(["immediate", "inserted", "buffered"]);
    const recursive = new CommandBuffer({ maxRecursion: 2 });
    recursive.register("again", () => { recursive.executeNow("again"); });
    expect(() => recursive.executeNow("again")).toThrow("recursion limit 2");
  });

  test("newlines split even unfinished quoted commands and long lines drop the boundary byte", () => {
    const commands = new CommandBuffer(), trace: string[][] = [];
    commands.register("record", context => { trace.push([...context.args]); });
    commands.append('record "first\nrecord second\r\n');
    expect(commands.execute()).toBe(2);
    expect(trace).toEqual([["first"], ["second"]]);
    commands.append(`record ${"x".repeat(1016)}Zrecord tail`);
    expect(commands.execute()).toBe(2);
    expect(trace.slice(2)).toEqual([["x".repeat(1016)], ["tail"]]);
  });

  test("wait uses native signed atoi only with exactly one argument", () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    commands.register("record", context => { trace.push(context.args.join(" ")); });
    commands.append("wait -1;record pending");
    expect(commands.execute()).toBe(1);
    for (let frame = 0; frame < 3; frame++) expect(commands.execute()).toBe(0);
    expect(commands.pendingText).toBe("record pending");
    commands.executeNow("wait 100 ignored");
    expect(commands.execute()).toBe(0);
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["pending"]);
  });

  test("native command text stops at NUL and treats signed high bytes as unquoted whitespace", () => {
    const commands = new CommandBuffer(), trace: string[][] = [];
    commands.register("record", context => { trace.push([...context.args]); });
    commands.append("record buffered\0;record excluded");
    commands.executeNow('record one\xfftwo "quoted\xffbyte"\0 excluded');
    expect(trace).toEqual([["one", "two", "quoted\xffbyte"]]);
    commands.executeNow("\0excluded");
    expect(trace.at(-1)).toEqual(["buffered"]);
    expect(() => commands.executeNow("record \u0100")).toThrow("source byte");
  });

  test("source overflow warnings leave pending bytes intact and insert permits the byte append reserves", () => {
    const printed: string[] = [];
    const appended = new CommandBuffer({ print: text => { printed.push(text); } });
    const inserted = new CommandBuffer({ print: text => { printed.push(text); } });
    appended.append("x".repeat(16383));
    appended.append("y\0ignored");
    expect(appended.pendingText).toBe("x".repeat(16383));
    inserted.append("tail");
    inserted.insert("x".repeat(16379));
    expect(inserted.pendingText).toBe(`${"x".repeat(16379)}\ntail`);
    inserted.insert("");
    inserted.append("");
    expect(inserted.pendingText).toBe(`${"x".repeat(16379)}\ntail`);
    expect(printed).toEqual(["Cbuf_AddText: overflow\n", "Cbuf_InsertText overflowed\n", "Cbuf_AddText: overflow\n"]);
  });

  test("overflow returns after its print callback without overwriting callback command-buffer changes", () => {
    for (const operation of ["append", "insert"] satisfies readonly ("append" | "insert")[]) {
      const printed: string[] = [], called: string[] = [];
      const commands = new CommandBuffer({ maxBufferLength: 8,
        resolveFallback: resolveSynchronously(context => { called.push(context.raw); }),
        print: text => {
          printed.push(text);
          expect(commands.pendingText).toBe("first");
          commands.execute();
          commands.append("later");
        } });
      commands.append("first");
      commands[operation]("bad");
      expect(called).toEqual(["first"]);
      expect(commands.pendingText).toBe("later");
      expect(printed).toEqual([operation === "append" ? "Cbuf_AddText: overflow\n" : "Cbuf_InsertText overflowed\n"]);
      commands.execute();
      expect(called).toEqual(["first", "later"]);
    }
  });
});
