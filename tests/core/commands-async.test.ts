import { describe, expect, test } from "bun:test";

import { waitForCall } from "../../src/core/call-steps.ts";
import type { CallSteps } from "../../src/core/call-steps.ts";
import { CommandBuffer } from "../../src/core/commands.ts";
import type {
  AsyncCommandHandler,
  CallCommandHandler,
  CommandContext,
  CommandFallbackResolver,
  CommandHandler,
} from "../../src/core/commands.ts";
import { CvarRegistry } from "../../src/core/cvar.ts";
import { EntityPool } from "../../src/game/entities.ts";
import { GameServerCommandRuntime } from "../../src/game/server-commands.ts";
import type { ServerCommandCapability } from "../../src/game/server-commands.ts";

function resolveSynchronously(handler: CommandHandler): CommandFallbackResolver {
  return () => ({ kind: "sync", handler });
}

describe("CommandBuffer asynchronous execution", () => {
  test("one call handler runs direct and awaited commands in source order", async () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    commands.registerCalls("game", function* (context): CallSteps {
      context.assertActive();
      trace.push(`before:${context.args.join(" ")}`);
      if (context.args[0] === "external") {
        yield* waitForCall(async () => {
          context.assertActive();
          trace.push("external-call");
          await Promise.resolve();
          commands.assertCurrentExecution();
        });
      }
      context.assertActive();
      trace.push("after");
      return undefined;
    });
    expect(commands.executeNow("game typed")).toBe(1);
    commands.append("game typed");
    expect(commands.execute()).toBe(1);
    commands.append("game typed;game external;game typed");
    expect(await commands.executeAsync()).toBe(3);
    expect(await commands.executeNowAsync("game external")).toBe(1);
    expect(trace).toEqual([
      "before:typed", "after", "before:typed", "after", "before:typed", "after", "before:external", "external-call", "after",
      "before:typed", "after", "before:external", "external-call", "after",
    ]);
  });

  test("synchronous calls consume their command and publish their prefix without starting a lazy wait", async () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    commands.registerCalls("game", function* (context): CallSteps {
      trace.push(`prefix:${context.args.join(" ")}`);
      yield* waitForCall(async () => { trace.push("wait-started"); });
      trace.push("after");
      return undefined;
    });
    commands.register("record", () => { trace.push("record"); });
    expect(() => commands.executeNow("game immediate")).toThrow("Cannot synchronously finish an asynchronous call");
    commands.append("game buffered;record");
    expect(() => commands.execute()).toThrow("Cannot synchronously finish an asynchronous call");
    await Promise.resolve();
    expect(trace).toEqual(["prefix:immediate", "prefix:buffered"]);
    expect(commands.pendingText).toBe("record");
    expect(commands.registeredNames()[0]).toBe("game");
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["prefix:immediate", "prefix:buffered", "record"]);
  });

  test("call fallback runs directly and awaits nested commands in the same owned scope", async () => {
    const trace: string[] = [], contexts: CommandContext[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const fallback: CallCommandHandler = function* (context): CallSteps {
      contexts.push(context);
      context.assertActive();
      if (context.args[0] === "external") {
        yield* waitForCall(() => commands.executeNowAsync("child"));
      }
      context.assertActive();
      commands.assertCurrentExecution();
      trace.push(`game:${context.args.join(" ")}`);
      return undefined;
    };
    const commands = new CommandBuffer({ resolveFallback: () => ({ kind: "calls", handler: fallback }) });
    commands.registerFallbackName("game");
    commands.registerAsync("child", async context => {
      entered.resolve();
      await gate.promise;
      context.assertActive();
      trace.push("child");
    });
    expect(commands.executeNow("GAME typed")).toBe(1);
    commands.append("game external;game typed");
    const execution = commands.executeAsync();
    await entered.promise;
    expect(() => commands.executeNow("game typed")).toThrow("overlapping command execution");
    expect(trace).toEqual(["game:typed"]);
    expect(commands.pendingText).toBe("game typed");
    gate.resolve();
    expect(await execution).toBe(2);
    expect(trace).toEqual(["game:typed", "child", "game:external", "game:typed"]);
    for (const context of contexts) expect(() => context.assertActive()).toThrow("closed command execution context");
  });

  test("call body errors survive lazy waits and release the command execution", async () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    const waitFailure = new Error("wait failure"), bodyFailure = new Error("body failure");
    commands.registerCalls("fail", function* (context): CallSteps {
      if (context.args[0] === "wait") {
        try {
          yield* waitForCall(() => Promise.reject(waitFailure));
        } catch (error) {
          expect(error).toBe(waitFailure);
          context.assertActive();
          trace.push("caught-wait");
        }
      } else if (context.args[0] === "resume") {
        yield* waitForCall(() => Promise.resolve());
      }
      context.assertActive();
      throw bodyFailure;
    });
    commands.register("record", () => { trace.push("record"); });
    expect(() => commands.executeNow("fail direct")).toThrow(bodyFailure);
    await expect(commands.executeNowAsync("fail wait")).rejects.toBe(bodyFailure);
    commands.append("fail resume;record");
    await expect(commands.executeAsync()).rejects.toBe(bodyFailure);
    expect(commands.pendingText).toBe("record");
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["caught-wait", "record"]);
  });

  test("rejected owned child entry consumes no shared work and does not close its awaited parent", async () => {
    let permitted = true;
    const trace: string[] = [], gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const commands = new CommandBuffer({ maxCommandsPerExecute: 2, maxRecursion: 2,
      assertExecutionEntry: () => { if (!permitted) throw new Error("Execution owner rejected entry"); } });
    commands.register("record", () => { trace.push("record"); });
    commands.registerAsync("parent", async context => {
      entered.resolve(); await gate.promise;
      permitted = false;
      expect(() => commands.executeNow("record")).toThrow("Execution owner rejected entry");
      await expect(commands.executeNowAsync("record")).rejects.toThrow("Execution owner rejected entry");
      permitted = true;
      context.assertActive(); expect(commands.executeNow("record")).toBe(1);
    });
    const parent = commands.executeNowAsync("parent");
    await entered.promise; gate.resolve();
    expect(await parent).toBe(1); expect(trace).toEqual(["record"]);
    expect(commands.executeNow("record")).toBe(1); expect(trace).toEqual(["record", "record"]);
  });

  test("awaits the current command before reading the next buffered command", async () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.registerAsync("map", async context => {
      trace.push(`loading:${context.args.join(" ")}`);
      entered.resolve();
      await gate.promise;
      trace.push("loaded");
    });
    commands.register("status", () => { trace.push("status"); });
    commands.append("map q3dm1;status");
    const execution = commands.executeAsync();
    await entered.promise;
    expect(trace).toEqual(["loading:q3dm1"]);
    expect(commands.pendingText).toBe("status");
    gate.resolve();
    expect(await execution).toBe(2);
    expect(trace).toEqual(["loading:q3dm1", "loaded", "status"]);
  });

  test("applies insert and append mutations at their call order during an awaited command", async () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.register("record", context => { trace.push(context.args.join(" ")); });
    commands.registerAsync("exec", async context => {
      context.insert("record before-await");
      entered.resolve();
      await gate.promise;
      context.insert("record loaded-config");
      context.append("record handler-append;");
    });
    commands.append("exec;record original;");
    const execution = commands.executeAsync();
    await entered.promise;
    commands.insert("record external-insert");
    commands.append("record external-append;");
    gate.resolve();
    expect(await execution).toBe(7);
    expect(trace).toEqual(["loaded-config", "external-insert", "before-await", "original", "external-append", "handler-append"]);
  });

  test("synchronous entry rejects an async command without invoking or consuming it", async () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    commands.register("record", () => { trace.push("record"); });
    commands.registerAsync("load", async () => { trace.push("load"); });
    expect(() => commands.executeNow("load immediate")).toThrow("asynchronous command");
    commands.append("record;load buffered;record");
    expect(() => commands.execute()).toThrow("asynchronous command");
    expect(trace).toEqual(["record"]);
    expect(commands.pendingText).toBe("load buffered;record");
    expect(await commands.executeAsync()).toBe(2);
    expect(trace).toEqual(["record", "load", "record"]);
  });

  test("rejects unrelated drains while allowing synchronous listip reentry after an await", async () => {
    const trace: string[] = [];
    const commands = new CommandBuffer({
      resolveFallback: resolveSynchronously(context => { trace.push(`cvar:${context.raw.trim()}`); }),
    });
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.register("listip", () => {
      trace.push("listip-before");
      expect(commands.executeNow("g_banIPs\n")).toBe(1);
      trace.push("listip-after");
    });
    commands.registerAsync("load", async () => {
      entered.resolve();
      await gate.promise;
      expect(commands.executeNow("listip")).toBe(1);
      trace.push("load-after");
    });
    commands.append("load;listip");
    const execution = commands.executeAsync();
    await entered.promise;
    expect(() => commands.execute()).toThrow("overlapping command execution");
    expect(() => commands.executeNow("listip")).toThrow("overlapping command execution");
    await expect(commands.executeAsync()).rejects.toThrow("overlapping command execution");
    await expect(commands.executeNowAsync("listip")).rejects.toThrow("overlapping command execution");
    expect(commands.pendingText).toBe("listip");
    expect(trace).toEqual([]);
    gate.resolve();
    expect(await execution).toBe(2);
    expect(trace).toEqual(["listip-before", "cvar:g_banIPs", "listip-after", "load-after", "listip-before", "cvar:g_banIPs", "listip-after"]);
  });

  test("nested awaited immediate execution shares limits without admitting sibling drains", async () => {
    const commands = new CommandBuffer({ maxCommandsPerExecute: 3 }), trace: string[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.register("record", () => { trace.push("record"); });
    commands.registerAsync("child", async () => {
      entered.resolve();
      await gate.promise;
      commands.executeNow("record");
    });
    commands.registerAsync("parent", async () => {
      const child = commands.executeNowAsync("child");
      await expect(commands.executeNowAsync("record")).rejects.toThrow("overlapping command execution");
      expect(await child).toBe(1);
    });
    commands.append("parent;record");
    const execution = commands.executeAsync();
    await entered.promise;
    gate.resolve();
    await expect(execution).rejects.toThrow("work limit 3");
    expect(trace).toEqual(["record"]);
    expect(commands.pendingText).toBe("record");
    expect(await commands.executeAsync()).toBe(1);
    expect(trace).toEqual(["record", "record"]);
  });

  test("real game listip synchronously reads the engine cvar during an awaited outer command", async () => {
    const cvars = new CvarRegistry(), trace: string[] = [];
    let game: GameServerCommandRuntime | undefined;
    const cvarHandler: CommandHandler = context => {
      const name = context.argv[0];
      if (name === undefined) throw new Error("Command fallback requires a parsed command");
      const cvar = cvars.get(name);
      if (cvar === undefined) throw new Error(`Unknown cvar command ${name}`);
      trace.push(`${cvar.name}=${cvar.value}`);
    };
    const gameHandler: CommandHandler = context => {
      const name = context.argv[0];
      if (name === undefined) throw new Error("Command fallback requires a parsed command");
      trace.push("game-before");
      if (game === undefined || !game.consoleCommand(context.argv)) throw new Error(`Unhandled game command ${name}`);
      trace.push("game-after");
    };
    const commands = new CommandBuffer({ resolveFallback: lookup => cvars.get(lookup.name) === undefined
      ? { kind: "sync", handler: gameHandler }
      : { kind: "sync", handler: cvarHandler } });
    const unexpected = (): never => { throw new Error("listip does not use entity or packet services"); };
    const pool = new EntityPool({ print: text => { trace.push(text); }, product: "baseq3", maxClients: 1, mapStartTime: 0,
      time: () => 0, link: unexpected, unlink: unexpected });
    const unavailable: ServerCommandCapability = { kind: "unavailable", reason: "listip requires no bot, memory or podium services" };
    game = new GameServerCommandRuntime(pool, cvars, {
      readVmCvar: name => {
        const cvar = cvars.get(name);
        if (cvar === undefined) throw new Error(`Unregistered game cvar ${name}`);
        return cvar;
      },
      print: text => { trace.push(text); }, sendServerCommand: unexpected, setTeam: unexpected,
      executeConsoleNow: text => { commands.executeNow(text); }, bots: unavailable, memory: unavailable, podium: unavailable,
    });
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.registerAsync("load", async () => {
      entered.resolve();
      await gate.promise;
      cvars.set("g_banIPs", "192.168.*.* ");
      commands.executeNow("listip");
      trace.push("load-return");
    });
    const execution = commands.executeNowAsync("load");
    await entered.promise;
    gate.resolve();
    expect(await execution).toBe(1);
    expect(trace).toEqual(["game-before", "g_banIPs=192.168.*.* ", "game-after", "load-return"]);
  });

  test("classifies fallback handlers before consumption and awaits them in source order", async () => {
    const trace: string[] = [];
    const fallback: AsyncCommandHandler = async context => {
      trace.push(`start:${context.args.join(" ")}`);
      if (context.args[0] === "fail") throw new Error("remote command failed");
      await Promise.resolve();
      trace.push(`finish:${context.args.join(" ")}`);
    };
    const commands = new CommandBuffer({ resolveFallback: lookup => lookup.name.toLowerCase() === "remote"
      ? { kind: "async", handler: fallback }
      : undefined });
    commands.registerFallbackName("remote");
    commands.register("record", context => { trace.push(`record:${context.args.join(" ")}`); });
    const before = commands.registeredNames();

    expect(() => commands.executeNow("REMOTE immediate")).toThrow("asynchronous command");
    expect(trace).toEqual([]);
    expect(commands.registeredNames()).toEqual(before);
    commands.append("remote awaited;record after");
    expect(() => commands.execute()).toThrow("asynchronous command");
    expect(commands.pendingText).toBe("remote awaited;record after");
    expect(commands.registeredNames()).toEqual(before);
    expect(await commands.executeAsync()).toBe(2);
    expect(trace).toEqual(["start:awaited", "finish:awaited", "record:after"]);
    expect(commands.registeredNames()).toEqual(["record", "remote", "wait"]);

    commands.append("remote fail;record retained");
    await expect(commands.executeAsync()).rejects.toThrow("remote command failed");
    expect(commands.pendingText).toBe("record retained");
    expect(trace).toEqual(["start:awaited", "finish:awaited", "record:after", "start:fail"]);
    expect(commands.execute()).toBe(1);
    expect(trace.at(-1)).toBe("record:retained");
  });

  test("nonempty asynchronous EXEC_NOW remains one command and ignores buffered wait", async () => {
    const commands = new CommandBuffer(), trace: string[][] = [];
    commands.registerAsync("record", async context => { trace.push([...context.args]); });
    commands.append("wait 2;record buffered");
    expect(await commands.executeAsync()).toBe(1);
    expect(await commands.executeNowAsync('record "quoted;arg";record unsplit\n')).toBe(1);
    expect(trace).toEqual([["quoted;arg", ";record", "unsplit"]]);
    expect(commands.pendingText).toBe("record buffered");
    expect(await commands.executeNowAsync(" ")).toBe(0);
    expect(await commands.executeNowAsync("")).toBe(0);
    expect(await commands.executeNowAsync(null)).toBe(1);
    expect(trace.at(-1)).toEqual(["buffered"]);
  });

  test("async drains preserve signed wait and NUL/high-byte source text", async () => {
    const commands = new CommandBuffer(), trace: string[][] = [];
    commands.registerAsync("record", async context => { trace.push([...context.args]); });
    commands.append("wait -1;record buffered\0;record excluded");
    expect(await commands.executeAsync()).toBe(1);
    expect(await commands.executeAsync()).toBe(0);
    expect(await commands.executeNowAsync('record one\xfftwo "quoted\xffbyte"\0 excluded')).toBe(1);
    expect(trace).toEqual([["one", "two", "quoted\xffbyte"]]);
    expect(await commands.executeNowAsync("wait 100 ignored")).toBe(1);
    expect(await commands.executeNowAsync("\0ignored")).toBe(0);
    expect(await commands.executeAsync()).toBe(1);
    expect(trace.at(-1)).toEqual(["buffered"]);
    await expect(commands.executeNowAsync("record \u0100")).rejects.toThrow("source byte");
  });

  test("async drains retain newline and long-line truncation semantics", async () => {
    const commands = new CommandBuffer(), trace: string[][] = [];
    commands.registerAsync("record", async context => { trace.push([...context.args]); });
    commands.append('record "first\nrecord second\r\n');
    expect(await commands.executeAsync()).toBe(2);
    commands.append(`record ${"x".repeat(1016)}Zrecord tail`);
    expect(await commands.executeAsync()).toBe(2);
    expect(trace).toEqual([["first"], ["second"], ["x".repeat(1016)], ["tail"]]);
  });

  test("failed async commands release execution ownership and retain following text", async () => {
    const commands = new CommandBuffer(), trace: string[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.registerAsync("fail", async () => { entered.resolve(); await gate.promise; });
    commands.register("record", () => { trace.push("record"); });
    commands.append("fail;record");
    const execution = commands.executeAsync();
    await entered.promise;
    gate.reject(new Error("read failed"));
    await expect(execution).rejects.toThrow("read failed");
    expect(trace).toEqual([]);
    expect(commands.pendingText).toBe("record");
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["record"]);
  });

  test("bounds nested async recursion and recovers after rejection", async () => {
    const commands = new CommandBuffer({ maxRecursion: 2 });
    commands.registerAsync("again", async () => { await commands.executeNowAsync("again"); });
    await expect(commands.executeNowAsync("again")).rejects.toThrow("recursion limit 2");
    commands.unregister("again");
    commands.register("again", () => {});
    expect(commands.executeNow("again")).toBe(1);
  });

  test("escaped callbacks and retained command contexts cannot mutate a completed execution", async () => {
    const commands = new CommandBuffer(), trace: string[] = [], contexts: CommandContext[] = [];
    const gate = Promise.withResolvers<void>(), escaped: Promise<void>[] = [];
    commands.register("record", () => { trace.push("record"); });
    commands.registerAsync("capture", async context => {
      contexts.push(context);
      escaped.push(gate.promise.then(() => {
        expect(() => commands.executeNow("record")).toThrow("closed command execution context");
        expect(() => commands.append("record")).toThrow("closed command execution context");
        expect(() => commands.insert("record")).toThrow("closed command execution context");
        expect(() => commands.register("late", () => {})).toThrow("closed command execution context");
        expect(() => commands.registerAsync("late", async () => {})).toThrow("closed command execution context");
        expect(() => commands.registerCalls("late", function* (): CallSteps { return undefined; })).toThrow("closed command execution context");
        expect(() => commands.registerFallbackName("late")).toThrow("closed command execution context");
        expect(() => commands.unregister("record")).toThrow("closed command execution context");
      }));
    });
    expect(await commands.executeNowAsync("capture")).toBe(1);
    const context = contexts[0];
    if (context === undefined) throw new Error("Capture command did not publish its context");
    expect(() => context.append("record")).toThrow("closed command execution context");
    expect(() => context.insert("record")).toThrow("closed command execution context");
    gate.resolve();
    await Promise.all(escaped);
    expect(commands.pendingText).toBe("");
    expect(trace).toEqual([]);
    expect(commands.executeNow("record")).toBe(1);
  });

  test("an unawaited child prevents successful root completion and cannot run remaining commands", async () => {
    const commands = new CommandBuffer(), trace: string[] = [], children: Promise<number>[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.register("record", () => { trace.push("record"); });
    commands.registerAsync("child", async () => {
      entered.resolve();
      await gate.promise;
      commands.executeNow("record");
    });
    commands.registerAsync("parent", async () => { children.push(commands.executeNowAsync("child")); });
    commands.append("parent;record");
    const execution = commands.executeAsync();
    await entered.promise;
    await expect(execution).rejects.toThrow("Nested command execution must be awaited");
    expect(commands.pendingText).toBe("record");
    expect(() => commands.execute()).toThrow("overlapping command execution");
    const child = children[0];
    if (child === undefined) throw new Error("Parent command did not start its child");
    gate.resolve();
    await expect(child).rejects.toThrow("closed command execution context");
    expect(trace).toEqual([]);
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["record"]);
  });

  test("a synchronous handler cannot launch an unawaited async child during an async drain", async () => {
    const commands = new CommandBuffer(), children: Promise<number>[] = [], trace: string[] = [];
    const gate = Promise.withResolvers<void>();
    commands.registerAsync("child", async () => { await gate.promise; });
    commands.register("parent", () => { children.push(commands.executeNowAsync("child")); });
    commands.register("record", () => { trace.push("record"); });
    commands.append("parent;record");
    await expect(commands.executeAsync()).rejects.toThrow("Nested command execution must be awaited");
    expect(commands.pendingText).toBe("record");
    const child = children[0];
    if (child === undefined) throw new Error("Parent command did not start its child");
    gate.resolve();
    await expect(child).rejects.toThrow("closed command execution context");
    expect(commands.execute()).toBe(1);
    expect(trace).toEqual(["record"]);
  });

  test("a child escaping between handler return and drain completion still rejects the root", async () => {
    const commands = new CommandBuffer(), children: Promise<number>[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    commands.registerAsync("child", async () => { entered.resolve(); await gate.promise; });
    commands.registerAsync("parent", async () => {
      queueMicrotask(() => { queueMicrotask(() => { children.push(commands.executeNowAsync("child")); }); });
    });
    commands.append("parent");
    const execution = commands.executeAsync();
    await entered.promise;
    await expect(execution).rejects.toThrow("Nested command execution must be awaited");
    const child = children[0];
    if (child === undefined) throw new Error("Escaped callback did not start its child");
    gate.resolve();
    await expect(child).rejects.toThrow("closed command execution context");
    expect(commands.execute()).toBe(0);
  });

  test("a throwing synchronous handler releases the async drain and shared work budget", async () => {
    const commands = new CommandBuffer({ maxCommandsPerExecute: 1 }), trace: string[] = [];
    commands.register("fail", () => { throw new Error("native command failed"); });
    commands.register("record", () => { trace.push("record"); });
    commands.append("fail;record");
    await expect(commands.executeAsync()).rejects.toThrow("native command failed");
    expect(commands.pendingText).toBe("record");
    expect(await commands.executeAsync()).toBe(1);
    expect(trace).toEqual(["record"]);
  });

  test("separate buffers do not share execution ownership", async () => {
    const first = new CommandBuffer(), second = new CommandBuffer(), trace: string[] = [];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    first.registerAsync("load", async () => { entered.resolve(); await gate.promise; trace.push("first"); });
    second.register("record", () => { trace.push("second"); });
    const execution = first.executeNowAsync("load");
    await entered.promise;
    expect(second.executeNow("record")).toBe(1);
    gate.resolve();
    expect(await execution).toBe(1);
    expect(trace).toEqual(["second", "first"]);
  });

  test("handler domains share exact-case registration while dispatch remains case-insensitive", async () => {
    const printed: string[] = [];
    const commands = new CommandBuffer({ print: text => { printed.push(text); } });
    commands.registerAsync("Load", async () => {});
    commands.register("load", () => {});
    commands.registerAsync("LOAD", async () => {});
    const before = commands.registeredNames();
    commands.register("load", () => {});
    commands.registerAsync("LOAD", async () => {});
    commands.registerCalls("Load", function* (): CallSteps { return undefined; });
    expect(commands.registeredNames()).toEqual(before);
    expect(printed).toEqual(["Cmd_AddCommand: load already defined\n", "Cmd_AddCommand: LOAD already defined\n", "Cmd_AddCommand: Load already defined\n"]);
    commands.registerCalls("two;commands", function* (): CallSteps { return undefined; });
    expect(commands.registeredNames()).toEqual(["two;commands", ...before]);
    expect(commands.unregister("two;commands")).toBe(true);
    expect(commands.registeredNames()).toEqual(before);
    commands.registerAsync("two;commands", async () => {});
    expect(commands.registeredNames()).toEqual(["two;commands", ...before]);
    expect(commands.unregister("two;commands")).toBe(true);
    expect(commands.registeredNames()).toEqual(before);
    expect(() => commands.executeNow("load")).toThrow("asynchronous command");
    expect(commands.unregister("load")).toBe(true);
    expect(commands.unregister("load")).toBe(false);
    expect(commands.unregister("LOAD")).toBe(true);
    await expect(commands.executeNowAsync("LOAD")).resolves.toBe(1);
  });

  test("sync handler types exclude Promises, void-only functions and ignored return values", () => {
    const asyncRejected: AsyncCommandHandler extends CommandHandler ? false : true = true;
    const voidRejected: (() => void) extends CommandHandler ? false : true = true;
    const numberRejected: (() => number) extends CommandHandler ? false : true = true;
    expect([asyncRejected, voidRejected, numberRejected]).toEqual([true, true, true]);
  });
});
