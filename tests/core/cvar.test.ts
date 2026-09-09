import { describe, expect, test } from "bun:test";

import { CvarFlag, CvarRegistry } from "../../src/core/cvar.ts";
import { infoParse } from "../../src/core/text.ts";
import { infoSetValueForKey } from "../../src/core/info-string.ts";
import { ZoneArena } from "../../src/core/zone.ts";
import type { ZoneAllocation } from "../../src/core/zone.ts";
import { SourceZoneStrings } from "../../src/core/zone-strings.ts";
import type { ZoneString } from "../../src/core/zone-strings.ts";

class ObservedZoneStrings extends SourceZoneStrings {
  readonly events: string[] = [];

  override copy(value: string): ZoneString {
    this.events.push(`copy ${value}`);
    return super.copy(value);
  }

  override free(value: ZoneString | null): void {
    this.events.push(`free ${value === null ? "NULL" : value.value}`);
    super.free(value);
  }
}

class ObservedZoneArena extends ZoneArena {
  readonly observedAllocations: ZoneAllocation[] = [];

  override allocate(size: number, tag: number, clear = false): ZoneAllocation {
    const allocation = super.allocate(size, tag, clear);
    this.observedAllocations.push(allocation);
    return allocation;
  }
}

describe("CvarRegistry", () => {
  test("name identity folds ASCII while preserving distinct source high bytes and VM indices", () => {
    const cvars = new CvarRegistry();
    const upper = cvars.bindVm("\xc4Name", "1", CvarFlag.Archive | CvarFlag.UserInfo | CvarFlag.Latch);
    const lower = cvars.bindVm("\xe4Name", "2", CvarFlag.Archive | CvarFlag.UserInfo);
    expect(lower).not.toBe(upper);
    expect(cvars.bindVm("\xc4NAME", "1", CvarFlag.None)).toBe(upper);
    expect(cvars.indexCount).toBe(2);
    expect(cvars.find("\xc4name")).not.toBe(cvars.find("\xe4name"));
    expect(cvars.set("\xc4NAME", "3").latchedValue).toBe("3");
    expect(cvars.applyLatched("\xc4nAME")[0]?.value).toBe("3");
    expect(cvars.readVm(lower)?.value).toBe("2");
    expect(cvars.reset("\xc4name", true)?.value).toBe("1");
    cvars.clearModified("\xc4NAME");
    expect(cvars.get("\xc4name")?.modified).toBe(false);
    expect(cvars.get("\xe4name")?.modified).toBe(true);
    expect(cvars.infoString(CvarFlag.UserInfo)).toBe("\\\xc4Name\\1\\\xe4Name\\2");
    cvars.register("CL_CDKEY", "hidden", CvarFlag.Archive);
    expect(cvars.archiveCommands()).toEqual(['seta \xe4Name "2"', 'seta \xc4Name "1"']);
    const written: string[] = [];
    cvars.writeVariables(text => { written.push(text); });
    expect(written).toEqual(['seta \xe4Name "2"\n', 'seta \xc4Name "1"\n']);
  });

  test("source cvar lookup ends at NUL and rejects nonbyte names before it", () => {
    const cvars = new CvarRegistry();
    cvars.register("Name", "1", CvarFlag.Latch);
    expect(cvars.get("NAME\0\u0100")?.name).toBe("Name");
    expect(cvars.find("NAME\0ignored;")).toBe(cvars.find("name"));
    cvars.set("name", "2");
    expect(cvars.applyLatched("NAME\0ignored")[0]?.value).toBe("2");
    cvars.addFlags("NAME\0ignored", CvarFlag.Archive);
    cvars.clearModified("NAME\0ignored");
    expect(cvars.get("name")?.modified).toBe(false);
    expect(cvars.get("name")?.flags).toBe(CvarFlag.Archive | CvarFlag.Latch);
    expect(cvars.reset("NAME\0ignored", true)?.value).toBe("1");
    expect(() => cvars.get("\u0100")).toThrow("source bytes");
    expect(() => cvars.find("\u0100")).toThrow("source bytes");
  });

  test("restart removes only the distinct high-byte user cvar and retains allocated indices", () => {
    const cvars = new CvarRegistry();
    const retained = cvars.bindVm("\xc4Name", "1", CvarFlag.None);
    cvars.set("\xe4Name", "2");
    const removed = cvars.bindVm("\xe4NAME", "2", CvarFlag.UserCreated);
    cvars.resetAll();
    expect(cvars.get("\xe4name")).toBeUndefined();
    expect(cvars.readVm(removed)).toBeUndefined();
    expect(cvars.readVm(retained)?.name).toBe("\xc4Name");
    expect(cvars.bindVm("\xe4Name", "3", CvarFlag.None)).toBe(2);
  });

  test("source strings allocate name, current and reset separately and survive only with their zone", () => {
    const zone = new ZoneArena(4096, "small"), strings = new ObservedZoneStrings(zone);
    const cvars = new CvarRegistry(undefined, undefined, strings);
    cvars.register("1", "0");
    expect(zone.memoryRemaining()).toBe(4096);
    strings.events.length = 0;
    const saved = cvars.register("name", "value");
    expect(strings.events).toEqual(["copy name", "copy value", "copy value"]);
    expect(zone.memoryRemaining()).toBe(4096 - 96);
    strings.events.length = 0;
    cvars.set("name", "other", true);
    expect(strings.events).toEqual(["free value", "copy other"]);
    expect(zone.memoryRemaining()).toBe(4096 - 96);
    zone.dispose();
    expect(() => cvars.get("name")).toThrow("no longer valid");
    expect(saved.value).toBe("value");
  });

  test("name, current, reset and pending reads consume their actual source allocation bytes", () => {
    const zone = new ObservedZoneArena(4096, "small");
    const cvars = new CvarRegistry(undefined, undefined, new SourceZoneStrings(zone));
    cvars.register("name", "value", CvarFlag.Latch | CvarFlag.Archive);
    cvars.set("name", "pending");
    const [name, current, reset, pending] = zone.observedAllocations;
    if (name === undefined || current === undefined || reset === undefined || pending === undefined) {
      throw new Error("Expected the four source string allocations");
    }
    name.bytes[0] = 78;
    current.bytes[0] = 86;
    reset.bytes[0] = 82;
    pending.bytes[0] = 80;
    const state = cvars.get("name");
    expect(state?.name).toBe("Name");
    expect(state?.value).toBe("Value");
    expect(state?.resetValue).toBe("Ralue");
    expect(state?.latchedValue).toBe("Pending");
    expect(cvars.archiveCommands()).toEqual(['seta Name "Pending"']);
  });

  test("source reset promotion frees before copying and forced sets free pending strings first", () => {
    const zone = new ZoneArena(4096, "small"), strings = new ObservedZoneStrings(zone);
    const cvars = new CvarRegistry(undefined, undefined, strings);
    cvars.set("user", "custom");
    strings.events.length = 0;
    cvars.register("user", "default", CvarFlag.Latch);
    expect(strings.events).toEqual(["free custom", "copy default"]);
    cvars.set("user", "pending");
    strings.events.length = 0;
    cvars.set("user", "forced", true);
    expect(strings.events).toEqual(["free pending", "free custom", "copy forced"]);
    expect(cvars.get("user")?.resetValue).toBe("default");
    cvars.register("empty", "");
    strings.events.length = 0;
    cvars.register("empty", "filled");
    expect(strings.events).toEqual(["free ", "copy filled"]);
    zone.checkHeap();
  });

  test("source latch replacement frees before print and Cvar_Get frees its detached latch after copying", () => {
    const zone = new ZoneArena(4096, "small"), strings = new ObservedZoneStrings(zone);
    const cvars = new CvarRegistry(() => { strings.events.push("print"); }, undefined, strings);
    cvars.register("latched", "start", CvarFlag.Latch);
    cvars.set("latched", "first");
    strings.events.length = 0;
    cvars.set("latched", "second");
    expect(strings.events).toEqual(["free first", "print", "copy second"]);
    strings.events.length = 0;
    expect(cvars.register("latched", "start").value).toBe("second");
    expect(strings.events).toEqual(["free start", "copy second", "free second"]);
    expect(cvars.get("latched")?.latchedValue).toBeUndefined();
    zone.checkHeap();
  });

  test("failed latch print retains the source freed pointer without allocating its replacement", () => {
    const zone = new ZoneArena(4096, "small"), strings = new SourceZoneStrings(zone);
    let fail = false;
    const cvars = new CvarRegistry(() => { if (fail) throw new Error("print stopped"); }, undefined, strings);
    cvars.register("latched", "start", CvarFlag.Latch);
    cvars.set("latched", "first");
    const remaining = zone.memoryRemaining();
    fail = true;
    expect(() => cvars.set("latched", "second")).toThrow("print stopped");
    expect(zone.memoryRemaining()).toBe(remaining + 32);
    expect(() => cvars.get("latched")).toThrow("no longer valid");
    zone.checkHeap();
  });

  test("failed Cvar_Get forced-set trace detaches but does not free its pending allocation", () => {
    const zone = new ZoneArena(4096, "small"), strings = new ObservedZoneStrings(zone);
    let fail = false;
    const cvars = new CvarRegistry(undefined, () => { if (fail) throw new Error("trace stopped"); }, strings);
    cvars.register("latched", "start", CvarFlag.Latch);
    cvars.set("latched", "pending");
    const remaining = zone.memoryRemaining();
    strings.events.length = 0;
    fail = true;
    expect(() => cvars.register("latched", "start")).toThrow("trace stopped");
    expect(strings.events).toEqual([]);
    expect(zone.memoryRemaining()).toBe(remaining);
    expect(cvars.get("latched")?.latchedValue).toBeUndefined();
    expect(cvars.get("latched")?.value).toBe("start");
  });

  test("restart releases user strings in source order while retaining the consumed index", () => {
    const zone = new ZoneArena(4096, "small"), strings = new ObservedZoneStrings(zone);
    const cvars = new CvarRegistry(undefined, undefined, strings);
    cvars.set("user", "custom");
    cvars.addFlags("user", CvarFlag.Latch);
    cvars.set("user", "pending");
    strings.events.length = 0;
    cvars.resetAll();
    expect(strings.events).toEqual(["free user", "free custom", "free pending", "free custom"]);
    expect(zone.memoryRemaining()).toBe(4096);
    expect(cvars.get("user")).toBeUndefined();
    expect(cvars.readVm(0)).toBeUndefined();
    expect(cvars.indexCount).toBe(1);
    zone.checkHeap();
  });

  test("cheat reset clears its latch before the source forced-set callback can abort", () => {
    const zone = new ZoneArena(4096, "small"), strings = new ObservedZoneStrings(zone);
    let fail = false;
    const cvars = new CvarRegistry(undefined, () => { if (fail) throw new Error("trace stopped"); }, strings);
    cvars.register("cheat", "start", CvarFlag.Latch | CvarFlag.Cheat);
    cvars.set("cheat", "active", true);
    cvars.set("cheat", "pending");
    strings.events.length = 0;
    fail = true;
    expect(() => cvars.setCheatsEnabled(false)).toThrow("trace stopped");
    expect(strings.events).toEqual(["free pending"]);
    expect(cvars.get("cheat")?.value).toBe("active");
    expect(cvars.get("cheat")?.latchedValue).toBeUndefined();
    zone.checkHeap();
  });

  test("failed source allocation consumes its cvar index before the allocation", () => {
    const zone = new ZoneArena(128, "small");
    const cvars = new CvarRegistry(undefined, undefined, new SourceZoneStrings(zone));
    cvars.register("first", "0");
    expect(zone.memoryRemaining()).toBe(32);
    expect(() => cvars.register("second", "0")).toThrow("small zone");
    expect(cvars.indexCount).toBe(2);
    expect(cvars.get("second")).toBeUndefined();
  });

  test("developer traces precede validation, equality and protection decisions", () => {
    const printed: string[] = [];
    const cvars = new CvarRegistry(text => { printed.push(text); }, text => { printed.push(text); });
    cvars.register("rom", "1", CvarFlag.ReadOnly);
    cvars.set("ROM", "1"); cvars.set("ROM", "2"); cvars.set("bad;name", "3");
    cvars.set("nul\0ignored", "4\0ignored");
    expect(printed).toEqual(["Cvar_Set2: ROM 1\n", "Cvar_Set2: ROM 2\n", "ROM is read only.\n",
      "Cvar_Set2: bad;name 3\n", "invalid cvar name string: bad;name\n", "Cvar_Set2: nul 4\n"]);
    expect(cvars.get("BADNAME")?.value).toBe("3");
    expect(cvars.get("rom")?.value).toBe("1");
  });

  test("Cvar_Get warns after flag promotion and before applying the current latch", () => {
    const printed: string[] = [];
    const cvars = new CvarRegistry(text => { printed.push(text); }, text => {
      printed.push(text);
      if (text.startsWith("Warning:")) {
        expect(cvars.get("latched")?.flags).toBe(CvarFlag.Latch | CvarFlag.Archive);
        expect(cvars.get("latched")?.latchedValue).toBe("2");
        cvars.set("latched", "3");
      }
    });
    cvars.register("latched", "1", CvarFlag.Latch);
    cvars.set("latched", "2"); printed.length = 0;
    expect(cvars.register("latched", "other", CvarFlag.Archive).value).toBe("3");
    expect(printed).toEqual(['Warning: cvar "latched" given initial values: "1" and "other"\n',
      "Cvar_Set2: latched 3\n", "latched will be changed upon restarting.\n", "Cvar_Set2: latched 3\n"]);
    printed.length = 0;
    cvars.register("latched", ""); cvars.register("latched", "1");
    cvars.register("empty", ""); cvars.register("empty", "filled");
    expect(printed).toEqual([]);
    cvars.set("user", "custom"); printed.length = 0;
    cvars.register("user", "default", CvarFlag.Archive);
    expect(printed).toEqual([]);
    expect(cvars.get("user")?.resetValue).toBe("default");
  });

  test("set and Linux-glibc reset traces run before lookup and reset resolution", () => {
    const printed: string[] = [];
    const cvars = new CvarRegistry(text => { printed.push(text); }, text => {
      printed.push(text);
      if (text === "Cvar_Set2: inserted next\n") cvars.register("inserted", "locked", CvarFlag.ReadOnly);
      if (text === "Cvar_Set2: RESET (null)\n") cvars.register("reset", "default");
    });
    expect(cvars.set("inserted", "next").value).toBe("locked");
    expect(cvars.reset("RESET")?.value).toBe("default");
    expect(cvars.reset("missing")).toBeUndefined();
    expect(cvars.reset("bad;reset")).toBeUndefined();
    expect(printed).toEqual(["Cvar_Set2: inserted next\n", "inserted is read only.\n",
      "Cvar_Set2: RESET (null)\n", "Cvar_Set2: missing (null)\n",
      "Cvar_Set2: bad;reset (null)\n", "invalid cvar name string: bad;reset\n"]);
  });

  test("prints canonical protection and latch decisions without echoing unchanged or forced sets", () => {
    const printed: string[] = [], cvars = new CvarRegistry(text => { printed.push(text); });
    cvars.register("rom", "1", CvarFlag.ReadOnly | CvarFlag.Init);
    cvars.register("init", "1", CvarFlag.Init);
    cvars.register("latch", "1", CvarFlag.Latch | CvarFlag.Cheat);
    cvars.register("cheat", "1", CvarFlag.Cheat);
    cvars.setCheatsEnabled(false);
    cvars.set("ROM", "2"); cvars.set("init", "2"); cvars.set("latch", "2"); cvars.set("cheat", "2");
    cvars.set("rom", "1"); cvars.set("latch", "2"); cvars.set("cheat", "3", true);
    expect(printed).toEqual(["ROM is read only.\n", "init is write protected.\n", "latch will be changed upon restarting.\n", "cheat is cheat protected.\n"]);
    expect(cvars.get("latch")?.latchedValue).toBe("2");
    expect(cvars.get("cheat")?.value).toBe("3");
  });
  test("keeps source allocated-index count after user cvar deletion and retains unchanged-value pending latch", () => {
    const cvars = new CvarRegistry();
    cvars.register("latched", "1", CvarFlag.Latch); cvars.set("latched", "2");
    cvars.set("temporary", "value");
    expect(cvars.indexCount).toBe(2);
    cvars.resetAll();
    expect(cvars.get("temporary")).toBeUndefined();
    expect(cvars.get("latched")?.latchedValue).toBe("2");
    expect(cvars.indexCount).toBe(2);
    cvars.set("temporary", "new"); expect(cvars.indexCount).toBe(3);
    for (let index = 3; index < 1024; index++) cvars.register(`limit${index}`, "0");
    expect(() => cvars.register("one-too-many", "0")).toThrow("MAX_CVARS");
    expect(cvars.get("one-too-many")).toBeUndefined();
    expect(cvars.indexCount).toBe(1024);
  });
  test("a live source sv_cheats cvar owns protection without resetting unrelated cheat values", () => {
    const cvars = new CvarRegistry();
    cvars.register("sv_cheats", "1", CvarFlag.ReadOnly | CvarFlag.SystemInfo);
    cvars.register("first", "1", CvarFlag.Cheat); cvars.register("second", "2", CvarFlag.Cheat);
    cvars.set("first", "3"); cvars.set("sv_cheats", "0", true);
    expect(cvars.set("second", "4").value).toBe("2"); expect(cvars.get("first")?.value).toBe("3");
    cvars.setCheatsEnabled(false); expect(cvars.get("first")?.value).toBe("1");
    cvars.set("sv_cheats", "1", true); expect(cvars.set("second", "4").value).toBe("4");
  });
  test("stores native atof results at the source float32 boundary", () => {
    const cvars = new CvarRegistry();
    expect(cvars.register("hex", "0x1p+1").numericValue).toBe(2);
    expect(cvars.register("rounded", "16777217").numericValue).toBe(16777216);
    expect(cvars.set("rounded", "0.1").numericValue).toBe(Math.fround(0.1));
    expect(cvars.register("infinite", "-inf").numericValue).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(cvars.register("nan-value", "nan(123)").numericValue)).toBe(true);
    expect(Object.is(cvars.register("negative-zero", "-0x1p-1075").numericValue, -0)).toBe(true);
    cvars.register("latched", "1", CvarFlag.Latch);
    expect(cvars.set("latched", "0x1.8p+1").numericValue).toBe(1);
    expect(cvars.register("latched", "1").numericValue).toBe(3);
    expect(cvars.reset("latched")?.numericValue).toBe(3);
    cvars.applyLatched("latched");
    expect(cvars.get("latched")?.numericValue).toBe(1);
  });

  test("cvar integer writes use C-locale whitespace through register, latch, reset and VM update", () => {
    const cvars = new CvarRegistry();
    const mirror = cvars.registerVm("integer", "\u00a01", CvarFlag.Latch);
    expect(cvars.get("integer")?.integerValue).toBe(0);
    expect(mirror.integerValue).toBe(0);
    expect(cvars.set("integer", " \t\r\n\v\f-17tail", true).integerValue).toBe(-17);
    mirror.update();
    expect(mirror.integerValue).toBe(-17);
    expect(cvars.set("integer", "\u00a02").integerValue).toBe(-17);
    expect(cvars.register("integer", "\u00a01").integerValue).toBe(0);
    mirror.update();
    expect(mirror.integerValue).toBe(0);
    expect(cvars.set("integer", "23", true).integerValue).toBe(23);
    expect(cvars.reset("integer", true)?.integerValue).toBe(0);
    mirror.update();
    expect(mirror.integerValue).toBe(0);
  });

  test("numeric cvar fields retain their stored values until the source current-string write", () => {
    const zone = new ObservedZoneArena(4096, "small");
    const cvars = new CvarRegistry(undefined, undefined, new SourceZoneStrings(zone));
    const mirror = cvars.registerVm("number", "123.5", CvarFlag.Latch);
    const current = zone.observedAllocations[1];
    if (current === undefined) throw new Error("Expected the current cvar string allocation");
    current.bytes[0] = 57;
    expect(cvars.get("number")).toMatchObject({ value: "923.5", numericValue: 123.5, integerValue: 123 });
    expect(cvars.set("number", "923.5", true)).toMatchObject({ numericValue: 123.5, integerValue: 123, modificationCount: 1 });
    mirror.update();
    expect(mirror.value).toBe("123.5");
    expect(mirror.integerValue).toBe(123);
    expect(cvars.set("number", "0x1.8p+2", true)).toMatchObject({ numericValue: 6, integerValue: 0 });
    mirror.update();
    expect(mirror.numericValue).toBe(6);
    expect(mirror.integerValue).toBe(0);
    expect(cvars.set("number", "7.5")).toMatchObject({ numericValue: 6, integerValue: 0 });
    expect(cvars.register("number", "123.5")).toMatchObject({ numericValue: 7.5, integerValue: 7 });
    expect(cvars.reset("number", true)).toMatchObject({ numericValue: 123.5, integerValue: 123 });
    zone.checkHeap();
  });

  test("validates cvar byte values before mutation and copies only the C string", () => {
    const cvars = new CvarRegistry();
    expect(() => cvars.register("invalid", "\u0100")).toThrow("source bytes");
    expect(cvars.get("invalid")).toBeUndefined();
    const before = cvars.register("valid", "1", CvarFlag.Latch);
    expect(() => cvars.set("valid", "\u0100")).toThrow("source bytes");
    expect(cvars.get("valid")).toEqual(before);
    expect(cvars.set("valid", "2\0\u0100", true).value).toBe("2");
    expect(cvars.register("byte", "\xe9").numericValue).toBe(0);
  });

  test("per-variable modified clearing preserves change counters, latches and global flags", () => {
    const cvars = new CvarRegistry();
    cvars.register("master", "old", CvarFlag.Archive | CvarFlag.Latch);
    cvars.set("master", "new");
    const before = cvars.get("master"), flags = cvars.modifiedFlags;
    if (before === undefined) throw new Error("Missing cvar fixture");
    cvars.clearModified("MASTER");
    expect(cvars.get("master")).toEqual({ ...before, modified: false });
    expect(cvars.modifiedFlags).toBe(flags);
    cvars.set("master", "later");
    expect(cvars.get("master")?.modified).toBe(true);
    expect(() => cvars.clearModified("missing")).toThrow("unregistered cvar");
  });
  test("seta flag attachment preserves pending latches, defaults and modified bookkeeping", () => {
    const cvars = new CvarRegistry();
    cvars.register("sv_maxclients", "8", CvarFlag.Latch);
    const before = cvars.set("sv_maxclients", "16");
    const flags = cvars.modifiedFlags;
    cvars.addFlags("SV_MAXCLIENTS", CvarFlag.Archive);
    expect(cvars.get("sv_maxclients")).toEqual({ ...before, flags: before.flags | CvarFlag.Archive });
    expect(cvars.modifiedFlags).toBe(flags);
    expect(cvars.archiveCommands()).toEqual(['seta sv_maxclients "16"']);
    expect(() => cvars.addFlags("missing", CvarFlag.Archive)).toThrow("unregistered cvar");
  });
  test("masked source flag clearing preserves unrelated changes and per-variable modified state", () => {
    const cvars = new CvarRegistry();
    cvars.register("server", "0", CvarFlag.ServerInfo); cvars.register("system", "0", CvarFlag.SystemInfo); cvars.register("archive", "0", CvarFlag.Archive);
    cvars.set("server", "1"); cvars.set("system", "1"); cvars.set("archive", "1");
    cvars.clearModifiedFlags(CvarFlag.ServerInfo);
    expect(cvars.modifiedFlags).toBe(CvarFlag.SystemInfo | CvarFlag.Archive); expect(cvars.get("server")?.modified).toBe(true);
    cvars.set("server", "2"); cvars.clearModifiedFlags(CvarFlag.SystemInfo);
    expect(cvars.modifiedFlags).toBe(CvarFlag.ServerInfo | CvarFlag.Archive);
  });
  test("latches engine values and archives the pending value", () => {
    const cvars = new CvarRegistry();
    cvars.register("r_mode", "3", CvarFlag.Archive | CvarFlag.Latch);

    const pending = cvars.set("R_MODE", "4");
    expect(pending.value).toBe("3");
    expect(pending.latchedValue).toBe("4");
    expect(pending.modificationCount).toBe(2);
    expect(cvars.archiveCommands()).toEqual(['seta r_mode "4"']);

    expect(cvars.applyLatched("r_mode")).toEqual([
      {
        name: "r_mode",
        value: "4",
        resetValue: "3",
        latchedValue: undefined,
        flags: CvarFlag.Archive | CvarFlag.Latch,
        modified: true,
        modificationCount: 3,
        numericValue: 4,
        integerValue: 4,
      },
    ]);
  });

  test("register applies a pending latch like Cvar_Get", () => {
    const cvars = new CvarRegistry();
    cvars.register("fs_game", "", CvarFlag.Latch);
    cvars.set("fs_game", "missionpack");

    expect(cvars.register("fs_game", "", CvarFlag.Latch).value).toBe("missionpack");
    expect(cvars.get("FS_GAME")?.latchedValue).toBeUndefined();
  });

  test("registration applies a pending latch through canonical forced-set modified bookkeeping", () => {
    const cvars = new CvarRegistry();
    cvars.register("pending", "1", CvarFlag.Archive | CvarFlag.Latch);
    cvars.set("pending", "2"); cvars.clearModifiedFlags(CvarFlag.Archive | CvarFlag.Latch);
    expect(cvars.register("pending", "1").value).toBe("2");
    expect(cvars.modifiedFlags).toBe(CvarFlag.Archive | CvarFlag.Latch);
    expect(cvars.get("pending")?.modificationCount).toBe(3);
  });

  test("canonical name normalization preserves empty and C-string names without redirecting literal lookup", () => {
    const printed: string[] = [], cvars = new CvarRegistry(text => { printed.push(text); });
    expect(cvars.register("", "empty").name).toBe("");
    expect(cvars.register("name\0ignored;", "one").name).toBe("name");
    expect(cvars.set("bad\\name", "value").name).toBe("BADNAME");
    expect(cvars.register('bad"name', "reset").name).toBe("BADNAME");
    expect(printed).toEqual(["invalid cvar name string: bad\\name\n", 'invalid cvar name string: bad"name\n']);
    expect(cvars.get("bad\\name")).toBeUndefined();
    expect(cvars.get("BADNAME")?.value).toBe("value");
    expect(() => cvars.set("bad\u0100", "value")).toThrow("source bytes");
  });

  test("enforces read-only, init, and cheat-protected writes", () => {
    const cvars = new CvarRegistry();
    cvars.register("version", "1.32b", CvarFlag.ReadOnly);
    cvars.register("dedicated", "0", CvarFlag.Init);
    cvars.register("g_gravity", "800", CvarFlag.Cheat);
    cvars.setCheatsEnabled(false);

    expect(cvars.set("version", "changed").value).toBe("1.32b");
    expect(cvars.set("dedicated", "1").value).toBe("0");
    expect(cvars.set("g_gravity", "100").value).toBe("800");
    expect(cvars.set("version", "forced", true).value).toBe("forced");
  });

  test("disabling cheats clears pending and active cheat values", () => {
    const cvars = new CvarRegistry();
    cvars.register("g_speed", "320", CvarFlag.Cheat | CvarFlag.Latch);
    cvars.set("g_speed", "500");
    cvars.applyLatched();
    cvars.set("g_speed", "600");

    cvars.setCheatsEnabled(false);
    expect(cvars.get("g_speed")?.value).toBe("320");
    expect(cvars.get("g_speed")?.latchedValue).toBeUndefined();
  });

  test("tracks filtered info strings and modified flag consumption", () => {
    const cvars = new CvarRegistry();
    cvars.register("name", "Ranger", CvarFlag.UserInfo | CvarFlag.Archive);
    cvars.register("sv_hostname", "Arena", CvarFlag.ServerInfo);
    cvars.set("name", "Sarge");

    expect(Array.from(infoParse(cvars.infoString(CvarFlag.UserInfo)))).toEqual([["name", "Sarge"]]);
    expect(cvars.modifiedFlags & CvarFlag.UserInfo).toBe(CvarFlag.UserInfo);
    expect(cvars.takeModifiedFlags() & CvarFlag.Archive).toBe(CvarFlag.Archive);
    expect(cvars.modifiedFlags).toBe(CvarFlag.None);
  });

  test("uses the source linked-list order for info and archive output", () => {
    const cvars = new CvarRegistry();
    cvars.register("first", "1", CvarFlag.UserInfo | CvarFlag.Archive);
    cvars.register("second", "2", CvarFlag.UserInfo | CvarFlag.Archive);

    expect(cvars.infoString(CvarFlag.UserInfo)).toBe("\\first\\1\\second\\2");
    expect(cvars.infoString(CvarFlag.UserInfo, 8192)).toBe("\\second\\2\\first\\1");
    expect(cvars.archiveCommands()).toEqual(['seta second "2"', 'seta first "1"']);
  });

  test("common info strings count source bytes and preserve diagnostic callback order", () => {
    const diagnostics: string[] = [];
    const cvars = new CvarRegistry(text => {
      diagnostics.push(text);
      cvars.set("later", "new");
    });
    cvars.register("later", "old", CvarFlag.ServerInfo);
    cvars.register("high", "\xe9".repeat(600), CvarFlag.ServerInfo);
    cvars.register("bad", "x;y", CvarFlag.ServerInfo);
    expect(cvars.infoString(CvarFlag.ServerInfo)).toBe(`\\later\\new\\high\\${"\xe9".repeat(600)}`);
    expect(diagnostics).toEqual(["Can't use keys or values with a semicolon\n"]);
  });

  test("live info traversal reads later cvars after earlier diagnostic callbacks", () => {
    const cvars = new CvarRegistry();
    cvars.register("later", "old", CvarFlag.ServerInfo);
    cvars.register("bad", "x;y", CvarFlag.ServerInfo);
    const detached = cvars.snapshots(CvarFlag.ServerInfo);
    const diagnostics: string[] = [];
    let info = "";
    cvars.visit(CvarFlag.ServerInfo, value => {
      if (value.nameString === null || value.currentString === null) throw new Error("Expected a linked cvar record");
      info = infoSetValueForKey(info, value.nameString.value, value.currentString.value, message => {
        diagnostics.push(message);
        cvars.set("later", "new");
        cvars.register("new-head", "not-visited", CvarFlag.ServerInfo);
      });
    });
    expect(info).toBe("\\later\\new");
    expect(detached.find(value => value.name === "later")?.value).toBe("old");
    expect(diagnostics).toEqual(["Can't use keys or values with a semicolon\n"]);
  });

  test("adopts defaults for user-created cvars and returns detached snapshots", () => {
    const cvars = new CvarRegistry();
    const created = cvars.set("cg_fov", "110");
    expect(created.flags).toBe(CvarFlag.UserCreated);

    const registered = cvars.register("cg_fov", "90", CvarFlag.Archive);
    expect(registered.value).toBe("110");
    expect(registered.resetValue).toBe("90");
    expect(registered.flags & CvarFlag.UserCreated).toBe(0);
    expect(cvars.reset("cg_fov")?.value).toBe("90");
    expect(created.value).toBe("110");
  });
});
