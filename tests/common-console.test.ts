import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CvarFlag } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { runCalls } from "../src/core/call-steps.ts";
import { EditField } from "../src/core/edit-field.ts";
import { ZoneTag } from "../src/core/zone.ts";
import type { CommandHandler } from "../src/core/commands.ts";
import type { HunkAccountingProfile } from "../src/render/hunk-accounting.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { acquireClientModule, acquireGameModule } from "../src/engine/client-modules.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { QvmGame } from "../src/engine/qvm-game.ts";
import { QvmUi } from "../src/engine/qvm-ui.ts";
import { QvmOpcode } from "../src/assets/qvm.ts";
import type { CommonBuildProfile } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { COMMON_JOURNAL_ABI } from "../src/engine/common-journal.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { sourceZip } from "./pk3-source-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";
import type { SourceZipEntry } from "./pk3-source-fixture.ts";

const homes: string[] = [], opened: CommonConsole[] = [];
const productId = SOURCE_PRODUCT_ID;
afterEach(() => { for (const common of opened.splice(0)) common.close(); for (const path of homes.splice(0)) rmSync(path, { recursive: true }); });

async function fixture(startupText = "", build: CommonBuildProfile = { kind: "dedicated" }, entries: readonly SourceZipEntry[] = [],
  prepareHome: (homePath: string) => void = () => {}, startupPrint: (text: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "q3-common-console-")); homes.push(root);
  const dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true }); mkdirSync(join(homePath, "baseq3"), { recursive: true });
  writeFileSync(join(dataPath, "baseq3", "default.cfg"), "set cfg_order default\n");
  writeFileSync(join(dataPath, "baseq3", "productid.txt"), productId);
  if (entries.length > 0) writeFileSync(join(dataPath, "baseq3", "pak0.pk3"), sourceZip(entries));
  prepareHome(homePath);
  const printed: string[] = [], unknown: string[] = [], startup = new StartupCommands(startupText);
  let printObserver: (text: string) => void = () => {};
  let permitted = true;
  const unknownHandler: CommandHandler = context => { unknown.push(context.raw); };
  const common = await CommonConsole.open({ roots: { dataPath, homePath, cdPath: dataPath, product: "baseq3" },
    startup, random: new LinuxNativeRandom(1), build, platformPrint: text => { printed.push(text); printObserver(text); startupPrint(text); },
    assertCommandEntry: () => { if (!permitted) throw new Error("Unrelated engine operation is active"); },
    assertOwnerEntry: () => { if (!permitted) throw new Error("Unrelated engine operation is active"); },
    resolveCommand: () => ({ kind: "sync", handler: unknownHandler }) }, owner => { opened.push(owner); return undefined; });
  return { common, root, dataPath, homePath, printed, unknown, startup, permit(value: boolean): void { permitted = value; },
    observePrint(observer: (text: string) => void): void { printObserver = observer; } };
}

async function execute(common: CommonConsole, text: string): Promise<void> { common.commands.append(text); await common.commands.executeAsync(); }
async function replay(common: CommonConsole, printed: string[]): Promise<CommonConsole> {
  const roots = { ...common.roots };
  common.close();
  return CommonConsole.open({ roots, startup: new StartupCommands("+set journal 2"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: text => { printed.push(text); }, assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
    resolveCommand: () => undefined }, owner => { opened.push(owner); return undefined; });
}
function deferred() {
  let finish: () => void = () => { throw new Error("Deferred is not initialized"); };
  const promise = new Promise<void>(resolve => { finish = resolve; });
  return { promise, finish };
}

describe("common console ownership and native initialization prerequisites", () => {
  test("VM_Init registers source controls and Hunk_Clear clears the same common VM table at its tail", async () => {
    const f = await fixture("+set vm_ui 1");
    expect(f.common.cvars.get("vm_game")).toBeUndefined();
    expect(f.common.commands.registeredNames()).not.toContain("vminfo");
    expect(() => f.common.initVm()).toThrow("runtime registration");
    f.common.registerRuntimeCvars("vm-init", async () => undefined);
    const early = f.common.vm.reserve("early"); early.bindTypeScript();
    f.common.initVm();
    expect(early.binding.kind).toBe("freed");
    expect(f.common.cvars.get("vm_ui")).toMatchObject({ value: "1", resetValue: "2", flags: CvarFlag.Archive });
    for (const name of ["vm_game", "vm_cgame"]) {
      expect(f.common.cvars.get(name)).toMatchObject({ value: "2", resetValue: "2", flags: CvarFlag.Archive });
    }
    expect(f.common.commands.registeredNames().slice(0, 2)).toEqual(["vminfo", "vmprofile"]);
    expect(() => f.common.initVm()).toThrow("exactly once");
    const ui = f.common.vm.reserve("ui"); ui.bindTypeScript(); ui.called();
    f.printed.length = 0;
    await execute(f.common, "vminfo\nvmprofile\n");
    expect(f.printed.join("")).toBe("Registered virtual machines:\nui : TypeScript replacement\n");
    const order: string[] = [];
    f.common.hunk.attachServer({
      shutdownGameProgs(): void { order.push("shutdown"); expect(ui.binding.kind).toBe("typescript"); },
      clearVm(): void { order.push("clear"); expect(ui.binding.kind).toBe("typescript"); },
    });
    f.observePrint(text => { if (text === "Hunk_Clear: reset the hunk ok\n") { order.push("print"); expect(ui.binding.kind).toBe("typescript"); } });
    await f.common.hunk.clear();
    expect(order).toEqual(["shutdown", "print", "clear"]);
    expect(ui.binding.kind).toBe("freed");
    const game = f.common.vm.reserve("qagame"); game.bindTypeScript();
    f.common.shutdown();
    expect(game.binding.kind).toBe("typescript");
    f.common.close();
    expect(game.binding.kind).toBe("freed");
  });

  test("an aborted hunk shutdown keeps the reached VM and allocation alive", async () => {
    const f = await fixture();
    f.common.registerRuntimeCvars("vm-abort", async () => undefined); f.common.initVm();
    const game = f.common.vm.reserve("qagame"); game.bindTypeScript();
    const allocation = f.common.hunk.accounting.reserve("vm-abort", "fixture", 32, "high");
    const order: string[] = [];
    f.common.hunk.attachServer({
      shutdownGameProgs(): void { order.push("shutdown"); throw new CommonError("drop", "authored shutdown abort"); },
      clearVm(): void { order.push("clear"); },
    });
    await expect(f.common.hunk.clear()).rejects.toThrow("authored shutdown abort");
    expect(order).toEqual(["shutdown"]);
    expect(game.binding.kind).toBe("typescript");
    expect(allocation.bytes.length).toBe(32);
  });

  test("common vmprofile follows real nested GAME and UI calls through acquired symbols", async () => {
    const code = new BinaryWriter(32);
    code.u8(QvmOpcode.OP_ENTER); code.i32(16);
    code.u8(QvmOpcode.OP_LOCAL); code.i32(24);
    code.u8(QvmOpcode.OP_LOAD4);
    code.u8(QvmOpcode.OP_ARG); code.u8(8);
    code.u8(QvmOpcode.OP_CONST); code.i32(-501);
    code.u8(QvmOpcode.OP_CALL);
    code.u8(QvmOpcode.OP_LEAVE); code.i32(16);
    const bytes = code.finish(), image = new BinaryWriter(32 + bytes.length);
    for (const word of [0x12721444, 7, 32, bytes.length, 32 + bytes.length, 0, 0, 2048]) image.i32(word);
    image.bytes(bytes);
    const entries: SourceZipEntry[] = [];
    for (const [role, name] of [["ui", "uiEntry"], ["qagame", "gameEntry"]] satisfies readonly (readonly [string, string])[]) {
      entries.push({ name: new TextEncoder().encode(`vm/${role}.qvm`), data: image.finish(), method: 0, utf8: false });
      entries.push({ name: new TextEncoder().encode(`vm/${role}.map`), data: new TextEncoder().encode(`0 0 ${name}\n`), method: 0, utf8: false });
    }
    const f = await fixture("+set developer 1", { kind: "dedicated" }, entries);
    f.common.registerRuntimeCvars("vm-profile", async () => undefined); f.common.initVm();
    const files = f.common.files.current, registry = f.common.vm;
    const loading = { print: (text: string): void => { f.common.output.print(text); },
      hunk: { kind: "source-hunk", accounting: f.common.hunk.accounting } satisfies HunkAccountingProfile };
    const uiModule = acquireClientModule({ files, product: "baseq3", role: "ui", registry, ...loading });
    if (uiModule === null || uiModule.mode !== "bytecode") throw new Error("Authored UI must select bytecode");
    const ui = new QvmUi(uiModule.image, async call => {
      const command = call.words.getInt32(4, true);
      if (command === 5) await runCalls(game.calls.runFrame(123));
      return command === 0 ? 6 : 0;
    }, new ClientStaticState(), () => undefined, { kind: "source-hunk", accounting: f.common.hunk.accounting }, uiModule.registration);
    uiModule.releaseImage();
    ui.loadSymbols({ developer: 1, files, print: text => { f.common.output.print(text); } });
    uiModule.completeLoading();
    const gameModule = acquireGameModule({ files, product: "baseq3", registry, ...loading });
    if (gameModule === null || gameModule.mode !== "bytecode") throw new Error("Authored GAME must select bytecode");
    const game: QvmGame = new QvmGame(gameModule.image, "baseq3", async call => {
      if (call.words.getInt32(4, true) === 8) {
        await execute(f.common, "vmprofile\n");
        await ui.isFullscreen();
        await execute(f.common, "vmprofile\n");
      }
      return 0;
    }, () => undefined, { kind: "source-hunk", accounting: f.common.hunk.accounting }, gameModule.registration);
    gameModule.releaseImage();
    game.loadSymbols({ developer: 1, files, print: text => { f.common.output.print(text); } });
    gameModule.completeLoading();
    expect(f.common.files.fileMemory.loadStack).toBe(0);
    expect(QvmUi.registered(uiModule.registration)).toBe(ui);
    expect(QvmGame.registered(gameModule.registration)).toBe(game);
    await ui.initialize(); await game.initialize(0, 1);
    f.printed.length = 0;
    await ui.refresh(100);
    await execute(f.common, "vmprofile\n");
    const profile = f.printed.join("");
    expect(profile.match(/gameEntry\n/g)?.length).toBe(1);
    expect(profile.match(/uiEntry\n/g)?.length).toBe(2);
    expect(profile.indexOf("gameEntry")).toBeLessThan(profile.indexOf("uiEntry"));
    expect(profile.match(/percentages are undefined/g)?.length).toBe(3);
    expect(profile).not.toContain("%");
    await ui.shutdown(); ui.retire();
    f.printed.length = 0;
    await execute(f.common, "vmprofile\n");
    expect(f.printed).toEqual([]);
    await runCalls(game.calls.shutdown(false)); game.disposeResources();
  });

  test("touch memory checks the heap before the clock and prints after timed live reads with owner checks", async () => {
    const f = await fixture();
    f.common.registerRuntimeCvars("touch-memory", async () => undefined);
    const arena = f.common.hunk.arena;
    if (arena === null) throw new Error("Missing initialized hunk");
    const hunk = arena.allocate(32, "low");
    const allocation = f.common.mainZone.allocate(300, ZoneTag.General);
    const view = new DataView(allocation.bytes.buffer);
    expect(allocation.bytes.byteOffset).toBe(52);
    let samples = 0;
    const clock = { milliseconds(): number {
      samples++;
      new DataView(hunk.bytes.buffer).setInt32(hunk.byteOffset, 13, true);
      view.setInt32(allocation.bytes.byteOffset + 236, 7, true);
      return samples === 1 ? 0x7ffffffe : -0x7fffffff;
    } };
    expect(f.common.touchMemory(clock)).toBe(344);
    expect(samples).toBe(2);
    expect(f.printed.at(-1)).toBe("Com_TouchMemory: 3 msec\n");
    view.setInt32(allocation.bytes.byteOffset - 20, 328, true);
    expect(() => f.common.touchMemory(clock)).toThrow("block size does not touch the next block");
    expect(samples).toBe(2);
    view.setInt32(allocation.bytes.byteOffset - 20, 324, true);
    expect(() => f.common.touchMemory({ milliseconds: () => { f.permit(false); return 0; } }))
      .toThrow("Unrelated engine operation is active");
    f.permit(true);
    f.observePrint(text => { if (text.startsWith("Com_TouchMemory:")) f.permit(false); });
    expect(() => f.common.touchMemory(clock)).toThrow("Unrelated engine operation is active");
    f.permit(true);
  });

  test("mod directory startup preserves cvar registration and mounts basegame before the selected mod", async () => {
    const f = await fixture("+set fs_basegame parentmod +set fs_game authoredmod", { kind: "dedicated" }, [], home => {
      mkdirSync(join(home, "parentmod")); mkdirSync(join(home, "authoredmod"));
      writeFileSync(join(home, "baseq3", "priority.cfg"), "base");
      writeFileSync(join(home, "parentmod", "priority.cfg"), "parent");
      writeFileSync(join(home, "parentmod", "inherited.cfg"), "inherited");
      writeFileSync(join(home, "authoredmod", "priority.cfg"), "mod");
      writeFileSync(join(home, "authoredmod", "default.cfg"), "set cfg_order mod_default\n");
    });
    f.common.validateGameDirectory();
    expect(f.common.roots.product).toBe("baseq3");
    expect(f.common.cvars.get("fs_game")).toMatchObject({ value: "authoredmod", resetValue: "authoredmod", modified: false,
      flags: CvarFlag.Init | CvarFlag.SystemInfo | CvarFlag.UserCreated });
    expect(f.common.cvars.get("fs_basegame")).toMatchObject({ value: "parentmod", resetValue: "parentmod", flags: CvarFlag.Init | CvarFlag.UserCreated });
    expect(new TextDecoder().decode(f.common.files.current.readSync("priority.cfg"))).toBe("mod");
    expect(new TextDecoder().decode(f.common.files.current.readSync("inherited.cfg"))).toBe("inherited");
    await execute(f.common, "exec default.cfg\n");
    expect(f.common.cvars.get("cfg_order")?.value).toBe("mod_default");
    const output = f.common.files.openByMode("mod-output.txt", "write");
    if (output === undefined) throw new Error("Missing mod output handle");
    f.common.files.writeFile(output.file.slot, new TextEncoder().encode("mod write"));
    f.common.files.closeFile(output.file.slot);
    expect(readFileSync(join(f.homePath, "authoredmod", "mod-output.txt"), "utf8")).toBe("mod write");
    expect(existsSync(join(f.homePath, "baseq3", "mod-output.txt"))).toBe(false);
  });

  test("mod directory conditional restart retires the old mount and queues the new config after pending commands", async () => {
    const f = await fixture(), original = f.common.files.current;
    mkdirSync(join(f.homePath, "authoredmod"));
    writeFileSync(join(f.homePath, "authoredmod", "q3config.cfg"), "set cfg_order mod_config\necho mod-config\n");
    await execute(f.common, "set fs_game authoredmod\n");
    expect(f.common.cvars.get("fs_game")?.value).toBe("");
    expect(f.printed).toContain("fs_game is write protected.\n");
    // UI trap_Cvar_Set and server systeminfo use the forced source Cvar_Set path.
    f.common.cvars.set("fs_game", "authoredmod", true);
    f.common.validateGameDirectory();
    expect(f.common.cvars.get("fs_game")?.modified).toBe(true);
    f.common.commands.append("echo pending-before-config\n");
    expect(await f.common.files.conditionalRestart(17, () => {})).toBe(true);
    expect(() => original.readFileLength("default.cfg")).toThrow("retired");
    expect(f.common.cvars.get("fs_game")?.modified).toBe(false);
    expect(f.common.files.current.pakReferences.checksumFeed).toBe(17);
    expect(f.common.cvars.get("cfg_order")).toBeUndefined();
    f.printed.length = 0;
    await f.common.commands.executeAsync();
    expect(f.printed).toEqual(["pending-before-config ", "\n", "execing q3config.cfg\n", "mod-config ", "\n"]);
    expect(f.common.cvars.get("cfg_order")?.value).toBe("mod_config");
    const current = f.common.files.current;
    expect(await f.common.files.conditionalRestart(17, () => {})).toBe(false);
    expect(f.common.files.current).toBe(current);
    expect(await f.common.files.conditionalRestart(18, () => {})).toBe(true);
    f.printed.length = 0; await f.common.commands.executeAsync(); expect(f.printed).toEqual([]);
    f.common.cvars.set("fs_game", "", true);
    await f.common.files.conditionalRestart(18, () => {});
    const output = f.common.files.openByMode("back-in-base.txt", "write");
    if (output === undefined) throw new Error("Missing base output handle");
    f.common.files.closeFile(output.file.slot);
    expect(existsSync(join(f.homePath, "baseq3", "back-in-base.txt"))).toBe(true);
  });

  test("mod directory restart consumes safe mode only on a directory change and only once", async () => {
    const f = await fixture("+safe");
    for (const game of ["firstmod", "secondmod"]) {
      mkdirSync(join(f.homePath, game));
      writeFileSync(join(f.homePath, game, "q3config.cfg"), `set loaded_mod ${game}\n`);
    }
    await f.common.files.conditionalRestart(1, () => {});
    f.common.cvars.set("fs_game", "firstmod", true);
    await f.common.files.conditionalRestart(1, () => {});
    await f.common.commands.executeAsync();
    expect(f.common.cvars.get("loaded_mod")).toBeUndefined();
    f.common.cvars.set("fs_game", "secondmod", true);
    await f.common.files.conditionalRestart(1, () => {});
    await f.common.commands.executeAsync();
    expect(f.common.cvars.get("loaded_mod")?.value).toBe("secondmod");
  });

  test("mod directory validation retains contained paths and accepts live filesystem roots", async () => {
    const f = await fixture();
    for (const name of ["fs_game", "fs_basegame"]) {
      for (const value of ["../outside", "nested/mod", "nested\\mod", "/absolute", ".", "two::parts"]) {
        f.common.cvars.set(name, value, true);
        expect(() => f.common.validateGameDirectory()).toThrow("Unsafe game directory");
      }
      f.common.cvars.set(name, "", true);
    }
    f.common.cvars.set("fs_basepath", join(f.root, "other-data"), true);
    f.common.validateGameDirectory();
    expect(f.common.roots.dataPath).toBe(join(f.root, "other-data"));
    expect(f.common.files.current.readFileLength("default.cfg")).toBeGreaterThan(0);
    f.common.cvars.set("fs_basepath", f.dataPath, true);
    f.common.validateGameDirectory();
  });

  test("mod directory recovery clears pure restrictions before recursive remount and preserves the source cvar typo", async () => {
    const f = await fixture("", { kind: "dedicated" }, [{ name: new TextEncoder().encode("default.cfg"),
      data: new TextEncoder().encode("set recovered_default 1\n"), method: 0, utf8: false }]);
    rmSync(join(f.dataPath, "baseq3", "default.cfg"));
    mkdirSync(join(f.homePath, "authoredmod"));
    writeFileSync(join(f.homePath, "authoredmod", "q3config.cfg"), "set recovered_mod 1\n");
    f.common.cvars.set("fs_game", "authoredmod", true);
    f.common.validateGameDirectory();
    await f.common.files.setServerLoadedPaks("123", "missing/pak", () => {});
    await expect(f.common.files.conditionalRestart(29, () => {})).rejects.toMatchObject({ code: "drop", message: "Invalid game folder\n" });
    expect(f.common.files.serverLoadedPaks).toEqual([]);
    expect(f.common.cvars.get("fs_game")).toMatchObject({ value: "authoredmod", modified: false });
    expect(f.common.cvars.get("fs_gamedirvar")?.value).toBe("");
    expect(f.common.cvars.get("fs_restrict")?.value).toBe("0");
    expect(f.common.files.current.readFileLength("default.cfg")).toBeGreaterThan(0);
    expect(f.common.cvars.get("recovered_mod")).toBeUndefined();
    await f.common.commands.executeAsync();
    expect(f.common.cvars.get("recovered_mod")?.value).toBe("1");
  });

  test("mod directory recovery raises fatal after a second mount still cannot read default.cfg", async () => {
    const f = await fixture();
    rmSync(join(f.dataPath, "baseq3", "default.cfg"));
    f.common.cvars.set("fs_game", "authoredmod", true);
    f.common.validateGameDirectory();
    await expect(f.common.files.conditionalRestart(31, () => {})).rejects.toMatchObject({ code: "fatal", message: "Couldn't load default.cfg" });
    expect(f.common.cvars.get("fs_game")).toMatchObject({ value: "authoredmod", modified: false });
    expect(f.common.cvars.get("fs_gamedirvar")?.value).toBe("");
    expect(f.common.files.current.pakReferences.checksumFeed).toBe(31);
    expect(f.common.files.current.readFileLength("default.cfg")).toBe(-1);
  });

  test("fs_copyfiles startup reaches the actual common CD read and copies into the source game directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "q3-common-copyfiles-")); homes.push(root);
    const dataPath = join(root, "data"), homePath = join(root, "home"), cdPath = join(root, "cd");
    mkdirSync(join(dataPath, "baseq3"), { recursive: true });
    mkdirSync(join(cdPath, "authoredmod"), { recursive: true });
    writeFileSync(join(dataPath, "baseq3", "default.cfg"), "set cfg_order default\n");
    writeFileSync(join(dataPath, "baseq3", "productid.txt"), productId);
    writeFileSync(join(cdPath, "authoredmod", "cd-only.cfg"), "set copied_mod 1\n");
    const common = await CommonConsole.open({ roots: { dataPath, homePath, cdPath, product: "baseq3" },
      startup: new StartupCommands("+set fs_copyfiles 1 +set fs_game authoredmod"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
      platformPrint: () => undefined, assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
      resolveCommand: () => undefined }, owner => { opened.push(owner); return undefined; });
    expect(existsSync(homePath)).toBe(false);
    common.validateGameDirectory(); common.registerRuntimeCvars("copy-test", async () => undefined);
    expect(common.cvars.get("fs_copyfiles")).toMatchObject({ value: "1", resetValue: "0", flags: CvarFlag.Init });
    await execute(common, "exec cd-only.cfg\n");
    expect(common.cvars.get("copied_mod")?.value).toBe("1");
    expect(readFileSync(join(dataPath, "authoredmod", "cd-only.cfg"), "utf8")).toBe("set copied_mod 1\n");
    expect(existsSync(join(homePath, "authoredmod", "cd-only.cfg"))).toBe(false);
  });

  test("forced restricted startup reports source fatal control when the demo configuration is absent", async () => {
    await expect(fixture("+set fs_restrict 1")).rejects.toMatchObject({ code: "fatal", message: "Couldn't load default.cfg" });
    const common = opened.at(-1), root = homes.at(-1);
    if (common === undefined || root === undefined) throw new Error("Missing adopted restricted common owner");
    expect(common.cvars.get("fs_restrict")?.integerValue).toBe(1);
    expect(common.files.writable.rootPath).toBe(join(root, "home", "demota"));
    expect(common.files.current.readFileLength("default.cfg")).toBe(-1);
  });

  test("restriction announcement exposes the already mounted common filesystem", async () => {
    let observed = false;
    await expect(fixture("+set fs_restrict 1", { kind: "dedicated" }, [], () => {}, text => {
      if (text !== "\nRunning in restricted demo mode.\n\n") return;
      const common = opened.at(-1), root = homes.at(-1);
      if (common === undefined || root === undefined) throw new Error("Missing adopted common owner");
      expect(common.files.current.readFileLength("default.cfg")).toBeGreaterThan(0);
      expect(common.files.writable.rootPath).toBe(join(root, "home", "baseq3"));
      observed = true;
    })).rejects.toMatchObject({ code: "fatal", message: "Couldn't load default.cfg" });
    expect(observed).toBe(true);
  });

  test("invalid product fatal retains reached mounts for filesystem shutdown", async () => {
    await expect(fixture("", { kind: "dedicated" }, [], homePath => {
      writeFileSync(join(homePath, "baseq3", "productid.txt"), "invalid");
    })).rejects.toMatchObject({ code: "fatal", message: "Invalid product identification" });
    const common = opened.at(-1);
    if (common === undefined) throw new Error("Missing adopted common owner");
    const files = common.files.current;
    expect(files.readFileLength("default.cfg")).toBeGreaterThan(0);
    common.shutdownFileSystem();
    expect(files.initialized).toBe(false);
  });

  test("actual Unix event queue records LP64 fields and replays all represented event kinds without polling live input", async () => {
    const f = await fixture("+set journal 1"), journalPath = join(f.homePath, "baseq3", "journal.dat");
    const unix = new UnixIo(() => undefined, new UnixSystemClock(() => 1001), { signals: "none" });
    try {
      unix.queueEvent({ kind: "key", time: -2147483648, key: 136, down: true });
      unix.queueEvent({ kind: "character", time: 2, character: 255 });
      unix.queueEvent({ kind: "mouse", time: 3, dx: -7, dy: 2147483647 });
      unix.queueEvent({ kind: "joystick", time: 4, axis: 5, value: -127 });
      unix.queueEvent({ kind: "console", time: 5, text: "echo café\0discarded" });
      unix.queueEvent({ kind: "packet", time: 6, from: { kind: "ipv4", host: [192, 0, 2, 9], port: 27960 }, payload: new Uint8Array([1, 128, 255]) });
      const source = new DedicatedEventSource(unix);
      const events = Array.from({ length: 7 }, () => {
        const event = f.common.journal.getEvent(source);
        return event.kind === "packet" ? { ...event, payload: event.payload.slice() } : { ...event };
      });
      expect(COMMON_JOURNAL_ABI).toBe("linux-x86_64-le-lp64");
      const bytes = readFileSync(journalPath), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(bytes.length).toBe(7 * 32 + 10 + 23);
      const expectedFields: readonly (readonly [number, number, number, number, number])[] = [
        [-2147483648, 1, 136, 1, 0], [2, 2, 255, 0, 0], [3, 3, -7, 2147483647, 0],
        [4, 4, 5, -127, 0], [5, 5, 0, 0, 10], [6, 6, 0, 0, 23], [1, 0, 0, 0, 0],
      ];
      let offset = 0;
      for (const fields of expectedFields) {
        for (const [index, field] of fields.entries()) expect(view.getInt32(offset + index * 4, true)).toBe(field);
        expect([...bytes.subarray(offset + 20, offset + 32)]).toEqual(Array.from({ length: 12 }, () => 0));
        bytes.fill(0xab, offset + 20, offset + 32); // Replay must ignore the native pointer and alignment padding.
        offset += 32 + fields[4];
      }
      expect([...bytes.subarray(160, 170)]).toEqual([101, 99, 104, 111, 32, 99, 97, 102, 233, 0]);
      expect([...bytes.subarray(202, 225)]).toEqual([4, 0, 0, 0, 192, 0, 2, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 109, 56, 1, 128, 255]);
      f.common.shutdown(); writeFileSync(journalPath, bytes);
      const restored = await replay(f.common, f.printed);
      unix.queueEvent({ kind: "console", time: 7, text: "live input stays queued" });
      for (const event of events) expect(restored.journal.getEvent(source)).toEqual(event);
      expect(unix.takeQueuedEvent()).toEqual({ kind: "console", time: 7, text: "live input stays queued" });
      expect(() => restored.journal.getEvent(source)).toThrow("Error reading from journal file");
    } finally { unix.close(); }
  });

  test("event replay rejects partial headers and payloads before decoding their contents", async () => {
    const unix = new UnixIo(() => undefined, new UnixSystemClock(() => 1000), { signals: "none" });
    try {
      const source = new DedicatedEventSource(unix);
      for (const size of [0, 1, 23, 31, 33]) {
        const f = await fixture("+set journal 1"), bytes = new Uint8Array(size);
        if (size === 33) { const view = new DataView(bytes.buffer); view.setInt32(4, 999, true); view.setInt32(16, 2, true); }
        f.common.shutdown(); writeFileSync(join(f.homePath, "baseq3", "journal.dat"), bytes);
        const restored = await replay(f.common, f.printed);
        expect(() => restored.journal.getEvent(source)).toThrow("Error reading from journal file");
      }
      const f = await fixture("+set journal 1"), bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
      view.setInt32(16, -1, true);
      f.common.shutdown(); writeFileSync(join(f.homePath, "baseq3", "journal.dat"), bytes);
      const restored = await replay(f.common, f.printed);
      expect(() => restored.journal.getEvent(source)).toThrow("Invalid journal event payload: -1");
    } finally { unix.close(); }
  });

  test("journal recording and shutdown follow the retained source file slot after reuse", async () => {
    const f = await fixture("+set journal 1"), files = f.common.files;
    const paths: string[] = []; files.current.printSearchPath(text => { paths.push(text); });
    expect(paths.join("")).toContain("handle 1: journal.dat\n");
    files.closeFile(1);
    const replacement = files.openByMode("replacement.dat", "write");
    if (replacement === undefined) throw new Error("Could not replace the journal file slot");
    expect(replacement.file.slot).toBe(1);
    expect(f.common.journal.getEvent({ getEvent: () => ({ kind: "none", time: 37 }) })).toEqual({ kind: "none", time: 37 });
    const expected = new Uint8Array(32); new DataView(expected.buffer).setInt32(0, 37, true);
    expect(new Uint8Array(readFileSync(join(f.homePath, "baseq3", "replacement.dat")))).toEqual(expected);
    expect(readFileSync(join(f.homePath, "baseq3", "journal.dat"))).toHaveLength(0);
    f.common.shutdown();
    expect(() => files.writeFile(replacement.file.slot, Uint8Array.of(1))).toThrow("FS_FileForHandle: NULL");
  });

  test("journal replay reads a source slot replaced after recording initialization", async () => {
    const f = await fixture("+set journal 1"), files = f.common.files;
    const header = new Uint8Array(32); new DataView(header.buffer).setInt32(0, -17, true);
    writeFileSync(join(f.homePath, "baseq3", "replacement.dat"), header);
    files.closeFile(1);
    const replacement = files.current.openUniqueRead("replacement.dat");
    if (replacement === undefined) throw new Error("Could not replace the journal file slot");
    expect(replacement.file.slot).toBe(1);
    f.common.cvars.set("journal", "2", true);
    expect(f.common.journal.getEvent({ getEvent: () => { throw new Error("Replay polled system input"); } }))
      .toEqual({ kind: "none", time: -17 });
    expect(files.readFile(replacement.file.slot, new Uint8Array(1))).toBe(0);
  });

  test("journal mode changes preserve actual packed-write errors and loose-write failures", async () => {
    for (const packed of [false, true]) {
      const entries: SourceZipEntry[] = ["journal.dat", "journaldata.dat"].map(name => ({
        name: new TextEncoder().encode(name), data: new Uint8Array(32), method: 0, utf8: true,
      }));
      const f = await fixture("+set journal 2", { kind: "dedicated" }, packed ? entries : [], home => {
        if (!packed) for (const name of ["journal.dat", "journaldata.dat"]) writeFileSync(join(home, "baseq3", name), new Uint8Array(32));
      });
      f.common.cvars.set("journal", "1", true);
      const error = packed ? "FS_FileForHandle: can't get FILE on zip file" : "Error writing to journal file";
      expect(() => f.common.journal.getEvent({ getEvent: () => ({ kind: "none", time: 3 }) })).toThrow(error);
      expect(f.printed.includes("FS_Write: 0 bytes written\n")).toBe(!packed);
      if (packed) expect(() => f.common.files.current.readFileOptionalSync("default.cfg")).toThrow(error);
    }
  });

  test("journal replay publishes its source file slot before an aborted open diagnostic", async () => {
    const failure = new CommonError("drop", "journal open diagnostic aborted");
    await expect(fixture("+set journal 2 +set fs_debug 1", { kind: "dedicated" }, [], home => {
      writeFileSync(join(home, "baseq3", "journal.dat"), new Uint8Array(32));
      writeFileSync(join(home, "baseq3", "journaldata.dat"), new Uint8Array(4));
    }, text => { if (text.startsWith("FS_FOpenFileRead: journal.dat ")) throw failure; })).rejects.toBe(failure);
    const common = opened.at(-1);
    if (common === undefined) throw new Error("Missing adopted journal owner");
    const paths: string[] = []; common.files.current.printSearchPath(text => { paths.push(text); });
    expect(paths.join("")).toContain("handle 1: journal.dat\n");
    common.shutdown();
    paths.length = 0; common.files.current.printSearchPath(text => { paths.push(text); });
    expect(paths.join("")).not.toContain("handle 1: journal.dat\n");
  });

  test("FS_ReadFile records config bytes and NULL-buffer lengths without journaling probes", async () => {
    const f = await fixture("+set journal 1"), files = f.common.files.current;
    const dataJournal = join(f.homePath, "baseq3", "journaldata.dat"), defaultBytes = readFileSync(join(f.dataPath, "baseq3", "default.cfg"));
    expect(f.common.cvars.get("journal")?.flags).toBe(CvarFlag.Init);
    expect(f.printed).toContain("Journaling events\n");
    expect(readFileSync(dataJournal)).toHaveLength(0);
    expect(files.fileLength("default.cfg")).toBe(defaultBytes.length); expect(files.has("default.cfg")).toBe(true);
    expect(files.readSync("default.cfg")).toEqual(new Uint8Array(defaultBytes));
    expect(await files.read("default.cfg")).toEqual(new Uint8Array(defaultBytes));
    const retained = files.openUniqueRead("default.cfg");
    if (retained === undefined) throw new Error("Missing real default.cfg handle");
    files.closeFile(retained.file);
    await execute(f.common, "touchFile default.cfg\n");
    expect(readFileSync(dataJournal)).toHaveLength(0);
    expect(files.readFileLength("default.cfg")).toBe(defaultBytes.length);
    await execute(f.common, "exec default.cfg\nexec missing.cfg\n");
    writeFileSync(join(f.homePath, "baseq3", "empty.cfg"), "");
    expect(files.readFileOptionalSync("empty.cfg")).toEqual(new Uint8Array());
    writeFileSync(join(f.homePath, "baseq3", "upper.CFG"), "upper");
    expect(files.readFileOptionalSync("upper.CFG")).toEqual(new TextEncoder().encode("upper"));
    writeFileSync(join(f.homePath, "baseq3", "inside.cfg.bak"), new Uint8Array([0, 128, 255]));
    expect(files.readFileOptionalSync("inside.cfg.bak")).toEqual(new Uint8Array([0, 128, 255]));
    expect([...readFileSync(dataJournal)]).toEqual([defaultBytes.length, 0, 0, 0, defaultBytes.length, 0, 0, 0,
      ...defaultBytes, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 128, 255]);
    writeFileSync(join(f.dataPath, "baseq3", "default.cfg"), "set cfg_order changed_live\n");
    writeFileSync(join(f.homePath, "baseq3", "missing.cfg"), "set live_missing wrong\n");
    writeFileSync(join(f.homePath, "baseq3", "upper.CFG"), "changed upper");
    rmSync(join(f.homePath, "baseq3", "inside.cfg.bak"));
    const restored = await replay(f.common, f.printed), replayFiles = restored.files.current;
    expect(replayFiles.readFileLength("default.cfg")).toBe(defaultBytes.length);
    await execute(restored, "exec default.cfg\nexec missing.cfg\n");
    expect(restored.cvars.get("cfg_order")?.value).toBe("default");
    expect(restored.cvars.get("live_missing")).toBeUndefined();
    expect(replayFiles.readFileOptionalSync("empty.cfg")).toBeUndefined();
    expect(new TextDecoder().decode(replayFiles.readFileOptionalSync("upper.CFG"))).toBe("changed upper");
    expect(replayFiles.has("inside.cfg.bak")).toBe(false);
    expect(await replayFiles.readFileOptional("inside.cfg.bak")).toEqual(new Uint8Array([0, 128, 255]));
    expect(replayFiles.readFileOptionalSync("past_end.cfg")).toBeUndefined();
  });

  test("config replay distinguishes zero, partial length and fatal partial contents", async () => {
    const f = await fixture("+set journal 1"), path = join(f.homePath, "baseq3", "journaldata.dat");
    f.common.shutdown();
    writeFileSync(path, new Uint8Array([0, 0, 0, 0, 4, 0, 0, 0, 65, 66]));
    const restored = await replay(f.common, f.printed);
    expect(restored.files.current.readFileLength("old_missing.cfg")).toBe(1);
    await expect(restored.files.current.readFileOptional("truncated.cfg")).rejects.toMatchObject({ code: "fatal", message: "Read from journalDataFile failed" });
    expect(restored.files.current.readFileLength("eof.cfg")).toBe(-1);
    for (const tail of [[], [7], [7, 0], [7, 0, 0]] satisfies readonly (readonly number[])[]) {
      const f = await fixture("+set journal 1"), path = join(f.homePath, "baseq3", "journaldata.dat");
      writeFileSync(path, new Uint8Array(tail));
      const restored = await replay(f.common, f.printed);
      expect(await restored.files.current.readFileOptional("partial.cfg")).toBeUndefined();
    }
    const invalid = await fixture("+set journal 1");
    writeFileSync(join(invalid.homePath, "baseq3", "journaldata.dat"), new Uint8Array([255, 255, 255, 255]));
    const rejected = await replay(invalid.common, invalid.printed);
    await expect(rejected.files.current.readFileOptional("negative.cfg")).rejects.toMatchObject({ code: "fatal", message: "Invalid journal config length: -1" });
    expect(() => rejected.files.current.readFileOptionalSync("")).toThrow("FS_ReadFile with empty name\n");
  });

  test("the common journal survives real filesystem restart and consumes its default.cfg NULL-buffer read", async () => {
    const f = await fixture("+set journal 1"), previous = f.common.files.current;
    await f.common.files.restart({ checksumFeed: 123, random: () => 0.5 }, () => {});
    expect(() => previous.readFileLength("default.cfg")).toThrow("retired");
    await execute(f.common, "exec default.cfg\n");
    const length = readFileSync(join(f.dataPath, "baseq3", "default.cfg")).length;
    const journalBytes = readFileSync(join(f.homePath, "baseq3", "journaldata.dat"));
    expect([...journalBytes.subarray(0, 8)]).toEqual([length, 0, 0, 0, length, 0, 0, 0]);
    const restored = await replay(f.common, f.printed);
    writeFileSync(join(f.dataPath, "baseq3", "default.cfg"), "set cfg_order changed\n");
    await restored.files.restart({ checksumFeed: 123, random: () => 0.5 }, () => {});
    await execute(restored, "exec default.cfg\n");
    expect(restored.cvars.get("cfg_order")?.value).toBe("default");
    const paths: string[] = []; restored.files.current.printSearchPath(text => { paths.push(text); });
    expect(paths.join("")).toContain(": journal.dat\n"); expect(paths.join("")).toContain(": journaldata.dat\n");
  });

  test("journal shutdown preserves data and final disposal does not reenter developer output", async () => {
    const f = await fixture("+set journal 1 +set developer 1");
    f.common.registerRuntimeCvars("journal-test", async () => undefined);
    const journal = f.common.journal, files = f.common.files.current, dataPath = join(f.homePath, "baseq3", "journaldata.dat");
    f.common.shutdown();
    const names: string[] = []; files.printSearchPath(text => { names.push(text); });
    expect(names.join("")).toContain(": journaldata.dat\n"); expect(names.join("")).not.toContain(": journal.dat\n");
    await execute(f.common, "exec default.cfg\n");
    expect(f.printed).toContain("Writing default.cfg to journal file.\n");
    const before = readFileSync(dataPath);
    f.observePrint(text => { if (text === "Writing default.cfg to journal file.\n") f.common.close(); });
    await expect(files.readFileOptional("default.cfg")).rejects.toThrow("Common console is closed");
    expect(readFileSync(dataPath)).toEqual(before);
    const printed = f.printed.length;
    f.common.close(); expect(f.printed).toHaveLength(printed);
    expect(() => journal.mode).toThrow("retired");
    expect(() => files.readFileLength("default.cfg")).toThrow("retired");
    expect(() => files.readFileOptionalSync("default.cfg")).toThrow("retired");
  });

  test("startup raw journal modes retain the source failed-open cvar typo and orphaned file rows", async () => {
    for (const mode of [0, -7, 3]) {
      const f = await fixture(`+set journal ${mode}`);
      expect(f.common.cvars.get("journal")?.integerValue).toBe(mode);
      expect(f.common.cvars.get("com_journal")?.value).toBe(mode === 0 ? undefined : "0");
      expect(existsSync(join(f.homePath, "baseq3", "journal.dat"))).toBe(false);
      expect(f.printed.includes("Couldn't open journal files\n")).toBe(mode !== 0);
    }
    const f = await fixture("+set journal 1", { kind: "dedicated" }, [], home => { mkdirSync(join(home, "baseq3", "journaldata.dat")); });
    expect(f.common.cvars.get("journal")?.integerValue).toBe(1); expect(f.common.cvars.get("com_journal")?.value).toBe("0");
    await execute(f.common, "exec default.cfg\n");
    expect(f.common.cvars.get("cfg_order")?.value).toBe("default");
    const paths: string[] = []; f.common.files.current.printSearchPath(text => { paths.push(text); });
    expect(paths.join("")).toContain(": journal.dat\n");
    f.common.shutdown();
    paths.length = 0; f.common.files.current.printSearchPath(text => { paths.push(text); });
    expect(paths.join("")).toContain(": journal.dat\n");
    const unix = new UnixIo(() => undefined, new UnixSystemClock(() => 1000), { signals: "none" });
    try {
      const source = new DedicatedEventSource(unix);
      expect(() => f.common.journal.getEvent(source)).toThrow("Error writing to journal file");
      const missing = await fixture("+set journal 2");
      expect(await missing.common.files.current.readFileOptional("default.cfg")).toBeUndefined();
      expect(() => missing.common.journal.getEvent(source)).toThrow("Error reading from journal file");
    } finally { unix.close(); }
  });

  test("developer output starts after binding publication and reads live toggles", async () => {
    const f = await fixture("+set developer 1", { kind: "client", client: {
      initializeKeyCommands: services => {
        services.cvars.set("early", "1");
        services.cvars.register("early", "2");
        services.cvars.register("early", "3");
      }, consolePrint: () => {}, writeBindings: () => {}, usesUniqueKey: () => 0,
    } });
    expect(f.printed.join("")).not.toContain("Cvar_Set2:");
    expect(f.printed.join("")).not.toContain("Warning: cvar");
    f.common.cvars.register("developer", "2");
    f.common.cvars.register("developer", "3");
    f.printed.length = 0;
    f.common.registerRuntimeCvars("test-date", async () => undefined);
    expect(f.printed.join("")).not.toContain('Warning: cvar "developer"');
    f.printed.length = 0;
    await execute(f.common, "set same 1\nset same 1\nset developer 0\nset same 2\nset developer 1\nset same 2\n");
    expect(f.printed).toEqual(["Cvar_Set2: same 1\n", "Cvar_Set2: same 1\n",
      "Cvar_Set2: developer 0\n", "Cvar_Set2: same 2\n"]);
    expect(f.common.cvars.get("developer")?.integerValue).toBe(1);
  });

  test("actual common output preserves reset, invalid-name and latched registration traces", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("test-date", async () => undefined);
    f.common.cvars.register("latched", "1", CvarFlag.Latch);
    f.printed.length = 0;
    await execute(f.common, 'set "bad;name" 9\nset latched 2\n');
    f.common.cvars.register("LATCHED", "different");
    await execute(f.common, 'reset LATCHED\nreset missing\nreset "bad;reset"\n');
    expect(f.printed).toEqual(["Cvar_Set2: bad;name 9\n", "invalid cvar name string: bad;name\n",
      "Cvar_Set2: latched 2\n", "latched will be changed upon restarting.\n",
      'Warning: cvar "LATCHED" given initial values: "1" and "different"\n', "Cvar_Set2: LATCHED 2\n",
      "Cvar_Set2: LATCHED (null)\n", "LATCHED will be changed upon restarting.\n", "Cvar_Set2: missing (null)\n",
      "Cvar_Set2: bad;reset (null)\n", "invalid cvar name string: bad;reset\n"]);
    expect(f.common.cvars.get("latched")?.latchedValue).toBe("1");
    expect(f.common.cvars.get("BADNAME")?.value).toBe("9");
  });

  test("developer print reentry affects lookup and retired common output cannot mutate cvars", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("test-date", async () => undefined);
    f.observePrint(text => {
      if (text === "Cvar_Set2: reentered next\n") f.common.cvars.register("reentered", "locked", CvarFlag.ReadOnly);
    });
    expect(f.common.cvars.set("reentered", "next").value).toBe("locked");
    f.observePrint(text => { if (text === "Cvar_Set2: retired next\n") f.common.close(); });
    expect(() => f.common.cvars.set("retired", "next")).toThrow("Common console is closed");
    expect(f.common.cvars.get("retired")).toBeUndefined();
  });

  test("forbidden retained cvars cannot print to platform, logfile or redirect before rejection", async () => {
    const f = await fixture("+set developer 1 +set logfile 2");
    f.common.registerRuntimeCvars("test-date", async () => undefined);
    f.common.output.print("owned baseline\n");
    const logPath = join(f.homePath, "baseq3", "qconsole.log"), logBefore = readFileSync(logPath, "latin1");
    f.printed.length = 0;
    f.permit(false);
    try {
      expect(() => f.common.cvars.set("forbidden", "value")).toThrow("Unrelated engine operation");
      expect(f.printed).toEqual([]);
      expect(readFileSync(logPath, "latin1")).toBe(logBefore);
      expect(f.common.cvars.get("forbidden")).toBeUndefined();
      const redirected: string[] = [];
      await f.common.output.redirect(64, text => { redirected.push(text); }, async () => {
        expect(() => f.common.cvars.set("redirect_forbidden", "value")).toThrow("Unrelated engine operation");
      });
      expect(redirected).toEqual([""]);
      expect(f.common.cvars.get("redirect_forbidden")).toBeUndefined();
    } finally { f.permit(true); }
  });

  test("a suspended command rejects outsider cvar output before writing redirect bytes", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("test-date", async () => undefined);
    const gate = deferred(), entered = deferred(), redirected: string[] = [];
    f.common.commands.registerAsync("hold", async () => { entered.finish(); await gate.promise; });
    const operation = f.common.commands.executeNowAsync("hold");
    try {
      await entered.promise;
      f.printed.length = 0;
      await f.common.output.redirect(64, text => { redirected.push(text); }, async () => {
        expect(() => f.common.cvars.set("outsider", "value")).toThrow("overlapping command execution");
      });
      expect(redirected).toEqual([""]);
      expect(f.printed).toEqual([]);
      expect(f.common.cvars.get("outsider")).toBeUndefined();
    } finally { gate.finish(); await operation; }
  });

  test("filesystem commands preserve source usage, listing order, filtering and output", async () => {
    const entries: SourceZipEntry[] = ["listed/Z.dat", "listed/a.dat", "listed/A.DAT", "listed\\b.dat", "listed/deep/child/c.dat"]
      .map(name => ({ name: new TextEncoder().encode(name), data: new Uint8Array([1]), method: 0, utf8: true }));
    const f = await fixture("", { kind: "dedicated" }, entries);
    mkdirSync(join(f.homePath, "baseq3", "listed"));
    writeFileSync(join(f.homePath, "baseq3", "listed", "Loose.dat"), "loose");
    f.printed.length = 0;
    await execute(f.common, "dir\ndir a b c\nfdir\ntouchFile\ntouchFile a b\n");
    expect(f.printed.join("")).toBe("usage: dir <directory> [extension]\nusage: dir <directory> [extension]\n"
      + "usage: fdir <filter>\nexample: fdir *q3dm*.bsp\nUsage: touchFile <file>\nUsage: touchFile <file>\n");
    f.printed.length = 0;
    await execute(f.common, "dir listed .DAT\nfdir *listed*.dat ignored\n");
    expect(f.printed.join("")).toBe("Directory of listed .DAT\n---------------\nLoose.dat\nz.dat\na.dat\nb.dat\n"
      + "---------------\nlisted/a.dat\nlisted/b.dat\nlisted/deep/child/c.dat\nlisted/Loose.dat\nlisted/z.dat\n5 files listed\n");
    expect(f.common.files.current.pakReferences.snapshot().every(row => row.flags === 0)).toBe(true);
    f.printed.length = 0;
    await execute(f.common, "dir missing\nfdir *absent*\n");
    expect(f.printed.join("")).toBe("Directory of missing \n---------------\n---------------\n0 files listed\n");
  });

  test("path reports actual mounts, all shared handle owners, pure status and close/reuse", async () => {
    const f = await fixture("", { kind: "dedicated" }, [{ name: new TextEncoder().encode("packed.dat"), data: new Uint8Array([7]), method: 0, utf8: true }]);
    const files = f.common.files.current;
    const packed = files.openUniqueRead("packed.dat"), loose = files.openRead("default.cfg");
    writeFileSync(join(f.homePath, "server.dat"), "server");
    const server = f.common.files.server.openRead("server.dat");
    const writer = f.common.files.writable.openBinaryWrite("output.dat");
    const serverWriter = f.common.files.server.openWrite("server-output.dat");
    if (packed === undefined || loose === undefined || server === null || writer === null || serverWriter === null) throw new Error("Fixture acquisition failed");
    const mountLines = `${f.homePath}/baseq3\n${f.dataPath}/baseq3/pak0.pk3 (1 files)\n${f.dataPath}/baseq3\n`;
    try {
      f.printed.length = 0;
      await execute(f.common, "path ignored\n");
      expect(f.printed.join("")).toBe(`Current search path:\n${mountLines}\nhandle 1: packed.dat\nhandle 2: default.cfg\nhandle 3: server.dat\nhandle 4: output.dat\nhandle 5: server-output.dat\n`);
      files.closeFile(packed.file);
      await execute(f.common, "touchFile packed.dat\ntouchFile missing.dat\n");
      f.printed.length = 0;
      await execute(f.common, "path\n");
      expect(f.printed.join("")).not.toContain("handle 1:");
      const pak = files.pakReferences.snapshot()[0];
      if (pak === undefined) throw new Error("Fixture pack missing");
      await f.common.files.setServerLoadedPaks(String(pak.pack.checksum), "baseq3/pak0", () => {});
      f.printed.length = 0;
      await execute(f.common, "path\n");
      expect(f.printed.join("")).toContain("pak0.pk3 (1 files)\n    on the pure list\n");
      await f.common.files.setServerLoadedPaks(String((pak.pack.checksum + 1) >>> 0), "unlisted", () => {});
      f.printed.length = 0;
      await execute(f.common, "path\ndir \"\" .dat\nfdir *.dat\n");
      expect(f.printed.join("")).toContain("pak0.pk3 (1 files)\n    not on the pure list\n");
      expect(f.printed.join("")).toEndWith("Directory of  .dat\n---------------\n---------------\n0 files listed\n");
    } finally {
      files.closeFile(packed.file); files.closeFile(loose.file); files.closeFile(server.file); writer.close(); serverWriter.close();
    }
  });

  test("touchFile opens and closes shared readers, records references and does not read payloads", async () => {
    const f = await fixture("", { kind: "dedicated" }, [{ name: new TextEncoder().encode("packed.dat"), data: new Uint8Array([7]), method: 8, utf8: true }]);
    const files = f.common.files.current;
    expect(files.pakReferences.snapshot().every(row => row.flags === 0)).toBe(true);
    const original = readFileSync(join(f.dataPath, "baseq3", "pak0.pk3"));
    const changed = Uint8Array.from(original);
    changed[30 + "packed.dat".length] = 7;
    writeFileSync(join(f.dataPath, "baseq3", "pak0.pk3"), changed);
    f.printed.length = 0;
    await execute(f.common, "touchFile packed.dat\ntouchFile missing.dat\n");
    expect(f.printed).toEqual([]);
    expect(files.pakReferences.snapshot().map(row => row.flags)).toEqual([1]);
    expect(() => files.readSync("packed.dat")).toThrow("invalid block type");
    f.printed.length = 0;
    await execute(f.common, "path\n");
    expect(f.printed.join("")).not.toContain("handle ");
    expect(existsSync(join(f.homePath, "baseq3", "missing.dat"))).toBe(false);
  });

  test("source common and filesystem shutdown keep the console and cvars alive until final disposal", async () => {
    const f = await fixture();
    f.common.shutdown();
    f.common.output.print("after Com_Shutdown\n");
    expect(f.common.files.current.fileLength("default.cfg")).toBeGreaterThan(0);
    f.common.shutdownFileSystem();
    f.common.output.print("final CL_Shutdown from Sys_Quit\n");
    f.common.cvars.set("cl_running", "0", true);
    expect(f.printed.slice(-2)).toEqual(["after Com_Shutdown\n", "final CL_Shutdown from Sys_Quit\n"]);
    expect(f.common.cvars.get("cl_running")?.value).toBe("0");
    expect(() => f.common.files).toThrow(new CommonError("fatal", "Filesystem call made without initialization\n"));
    f.common.close();
    expect(() => f.common.output.print("after final disposal")).toThrow("closed");
  });

  test("one inert core is adopted before key/bootstrap printing and survives typed pre-mount control", async () => {
    const f = await fixture();
    const first = new CommonError("drop", "bootstrap control"), owners: CommonConsole[] = [], trace: string[] = [];
    await expect(CommonConsole.open({ roots: f.common.roots, startup: new StartupCommands("+set dedicated 0 +set com_buildScript 1 +set cl_running 1"),
      random: new LinuxNativeRandom(1), build: { kind: "client", client: {
        initializeKeyCommands: services => {
          const owner = owners[0];
          if (owner === undefined) throw new Error("Core was not adopted");
          expect(services.cvars).toBe(owner.cvars);
          expect(owner.cvars.get("com_buildScript")?.integerValue).toBe(1);
          expect(owner.readErrorCvar("com_buildScript")).toBeNull();
          expect(owner.readErrorCvar("cl_running")).toBeNull();
          owner.output.print("early client output");
          throw first;
        }, consolePrint: () => { trace.push("client-console"); }, writeBindings: () => {}, usesUniqueKey: () => 0,
      } }, platformPrint: text => { trace.push(text); }, resolveCommand: () => undefined,
      assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
    }, owner => {
      owners.push(owner); opened.push(owner);
      expect(owner.cvars.snapshots()).toEqual([]);
      expect(() => owner.roots).toThrow("not configured");
      return undefined;
    })).rejects.toBe(first);
    expect(trace).toEqual(["early client output"]);
    const owner = owners[0];
    if (owner === undefined) throw new Error("Missing adopted owner");
    owner.output.print("retained after typed control");
    owner.close(); owner.close();
    expect(() => owner.output.print("closed")).toThrow("closed");
  });

  test("source error bindings are published only by runtime registration and remain canonical live reads", async () => {
    const f = await fixture("+set com_buildScript 1 +set sv_running 1 +set cl_running 1");
    for (const name of ["com_buildScript", "sv_running", "cl_running"] satisfies readonly ("com_buildScript" | "sv_running" | "cl_running")[]) {
      expect(f.common.readErrorCvar(name)).toBeNull();
    }
    f.common.registerRuntimeCvars("bindings", async () => undefined);
    for (const name of ["com_buildScript", "sv_running", "cl_running"] satisfies readonly ("com_buildScript" | "sv_running" | "cl_running")[]) {
      expect(f.common.readErrorCvar(name)).toEqual(f.common.cvars.get(name) ?? null);
      f.common.cvars.set(name, "0", true);
      expect(f.common.readErrorCvar(name)?.integerValue).toBe(0);
    }
  });
  test("client key bootstrap precedes configs and binding serialization precedes archived cvars", async () => {
    const chronology: string[] = [], clientPrints: string[] = [];
    const build: CommonBuildProfile = { kind: "client", client: {
      initializeKeyCommands: services => {
        chronology.push("keys:init");
        services.commands.register("bind", context => { chronology.push(`bind:${context.argv[1] ?? ""}:${context.argv[2] ?? ""}`); });
      },
      writeBindings: write => { chronology.push("keys:write"); write("unbindall\nbind x \"echo x\"\n"); },
      consolePrint: text => { clientPrints.push(text); },
      usesUniqueKey: () => 0,
    } };
    const f = await fixture("", build);
    expect(chronology).toEqual(["keys:init"]);
    writeFileSync(join(f.homePath, "baseq3", "q3config.cfg"), "bind x saved\nseta archived yes\n");
    await execute(f.common, "exec q3config.cfg\n");
    expect(chronology).toEqual(["keys:init", "bind:x:saved"]);
    expect(f.common.registerRuntimeCvars("client-date", async () => undefined)).toBe(0);
    expect(f.common.cvars.get("dedicated")?.flags).toBe(CvarFlag.Latch);
    expect(f.common.cvars.get("viewlog")?.value).toBe("0");
    f.common.markInitialized(); f.common.cvars.set("archived", "later"); f.common.output.print("client-visible\n"); await f.common.writeConfiguration();
    expect(clientPrints).toEqual(["Hunk_Clear: reset the hunk ok\n", "client-visible\n"]);
    const config = readFileSync(join(f.homePath, "baseq3", "q3config.cfg"), "latin1");
    expect(config).toStartWith("// generated by quake, do not modify\nunbindall\nbind x \"echo x\"\n");
    expect(config).toContain('seta archived "later"\n');
    expect(config.indexOf("bind x")).toBeLessThan(config.indexOf("seta archived"));
    expect(chronology).toEqual(["keys:init", "bind:x:saved", "keys:write"]);
  });

  test("configs run before server registration, startup variables override twice and wait survives", async () => {
    const f = await fixture('+set cfg_order commandline +map q3dm1');
    writeFileSync(join(f.homePath, "baseq3", "q3config.cfg"), "set cfg_order archived\nmap too_early\n");
    writeFileSync(join(f.homePath, "baseq3", "autoexec.cfg"), "set cfg_order auto\nwait 1\necho delayed\n");
    expect(f.common.cvars.get("cfg_order")?.value).toBe("commandline");
    expect(f.common.cvars.get("dedicated")).toBeUndefined();
    expect(f.common.cvars.get("com_hunkMegs")).toBeUndefined();
    expect(f.common.hunk.arena).toBeNull();
    expect(f.common.commands.registeredNames()).not.toContain("map");
    await execute(f.common, "exec default.cfg\nexec q3config.cfg\nexec autoexec.cfg\n");
    expect(f.common.cvars.get("cfg_order")?.value).toBe("auto");
    expect(f.unknown).toContain("map too_early");
    expect(f.printed.join("")).not.toContain("Unknown command");
    f.startup.applyVariables(f.common.cvars, null);
    expect(f.common.registerRuntimeCvars("test-date", async () => undefined)).toBe(1);
    expect(f.common.files.fileMemory.loadStack).toBe(0);
    expect(f.common.hunk.arena?.byteLength).toBe(56 * 1048576);
    expect(f.common.hunk.accounting.memoryRemaining()).toBe(56 * 1048576);
    expect(f.common.cvars.get("com_hunkMegs")).toMatchObject({ value: "56", flags: CvarFlag.Latch | CvarFlag.Archive });
    const maps: string[] = [];
    f.common.commands.register("map", context => { maps.push(context.args.join(" ")); });
    f.startup.appendCommands(f.common.commands); f.common.markInitialized();
    expect(maps).toEqual([]); expect(f.common.cvars.get("cfg_order")?.value).toBe("commandline");
    await f.common.commands.executeAsync();
    expect(maps).toEqual(["q3dm1"]); expect(f.printed.join("")).toContain("delayed \n");
    expect(f.common.cvars.get("dedicated")?.flags).toBe(CvarFlag.ReadOnly);
    expect(() => f.common.registerRuntimeCvars("again", async () => undefined)).toThrow("exactly once");
  });

  test("native common command diagnostics share cvars and source list/filter order", async () => {
    const f = await fixture();
    expect(f.common.commands.registeredNames()).toEqual(["touchFile", "fdir", "dir", "path", "wait", "echo", "vstr", "exec", "cmdlist",
      "cvar_restart", "cvarlist", "reset", "seta", "setu", "sets", "set", "toggle"]);
    await execute(f.common, 'seta archive "a b"\nsets server x\nsetu user y\nset fraction 0.5\ntoggle fraction\n');
    expect(f.common.cvars.get("fraction")?.value).toBe("1");
    f.common.cvars.register("latched", "1", CvarFlag.Latch); await execute(f.common, "latched 2\nlatched\n");
    expect(f.printed.join("")).toContain('latched will be changed upon restarting.\n"latched" is:"1^7" default:"1^7"\nlatched: "2"\n');
    f.printed.length = 0;
    await execute(f.common, "cvarlist arch\ncmdlist ec\n");
    expect(f.printed.join("")).toContain('    A   archive "a b"\n');
    expect(f.printed.join("")).toContain(`${f.common.cvars.snapshots().length} total cvars\n${f.common.cvars.indexCount} cvar indexes\n`);
    expect(f.printed.join("")).toEndWith("echo\n1 commands\n");
    const indexes = f.common.cvars.indexCount;
    await execute(f.common, "cvar_restart\n");
    expect(f.common.cvars.get("archive")).toBeUndefined(); expect(f.common.cvars.indexCount).toBe(indexes);
    expect(f.common.cvars.get("latched")?.latchedValue).toBe("2");
    expect(f.common.cvars.get("sv_cheats")?.value).toBe("1");
  });

  test("cmdlist follows live links when a print callback removes a later command", async () => {
    const f = await fixture();
    for (const name of ["q3_list_tail", "q3_list_removed", "q3_list_first"]) f.common.commands.register(name, () => {});
    f.observePrint(text => {
      if (text === "q3_list_first\n") expect(f.common.commands.unregister("q3_list_removed")).toBe(true);
    });
    f.printed.length = 0;
    await execute(f.common, "cmdlist Q3_LIST*\n");
    expect(f.printed).toEqual(["q3_list_first\n", "q3_list_tail\n", "2 commands\n"]);
  });

  test("cmdlist retains the filter byte pointer across recursive print tokenization", async () => {
    const f = await fixture();
    f.common.commands.register("go", () => {});
    for (const name of ["q3_next", "q3_old", "q3_first"]) f.common.commands.register(name, () => {});
    f.observePrint(text => {
      if (text === "q3_first\n") f.common.commands.executeNow("go xxxxxQ3_NEXT*");
    });
    f.printed.length = 0;
    await execute(f.common, "cmdlist Q3_*\n");
    expect(f.printed).toEqual(["q3_first\n", "q3_next\n", "2 commands\n"]);
    expect(f.common.commands.tokenizedArguments).toEqual(["go", "xxxxxQ3_NEXT*"]);
  });

  test("a NULL-style registered name still routes to a known cvar before the host fallback", async () => {
    const f = await fixture();
    f.common.cvars.register("g_banIPs", "192.0.2.* ");
    f.common.commands.registerFallbackName("g_banIPs");
    f.common.commands.register("later", () => {});
    const before = f.common.commands.registeredNames();
    expect(before.slice(0, 2)).toEqual(["later", "g_banIPs"]);

    expect(f.common.commands.executeNow("G_BANIPS")).toBe(1);
    expect(f.unknown).toEqual([]);
    expect(f.printed.join("")).toContain('"g_banIPs" is:"192.0.2.* ^7"');
    expect(f.common.commands.registeredNames()[0]).toBe("g_banIPs");
  });

  test("flagged set commands reread the live argument after a recursive protection print", async () => {
    const f = await fixture();
    for (const [command, flag] of [
      ["seta", CvarFlag.Archive], ["sets", CvarFlag.ServerInfo], ["setu", CvarFlag.UserInfo],
    ] satisfies readonly (readonly [string, number])[]) {
      const outer = `${command}_outer`, inner = `${command}_inner`;
      f.common.cvars.register(outer, "1", CvarFlag.ReadOnly);
      f.observePrint(text => {
        if (text === `${outer} is read only.\n`) f.common.commands.executeNow(`set ${inner} 7`);
      });
      f.common.commands.executeNow(`${command} ${outer} 2`);
      expect(f.common.cvars.get(outer)).toMatchObject({ value: "1", flags: CvarFlag.ReadOnly });
      expect(f.common.cvars.get(inner)).toMatchObject({ value: "7", flags: CvarFlag.UserCreated | flag });
    }
  });

  test("set retains its name byte offset through the developer print callback", async () => {
    for (const [nested, target] of [["set inner 7", "inner"], ["echo inner", ""]] satisfies readonly (readonly [string, string])[]) {
      const f = await fixture("+set developer 1");
      f.common.registerRuntimeCvars("retained-argv", async () => undefined);
      f.common.cvars.register("outer", "unchanged");
      f.printed.length = 0;
      f.observePrint(text => {
        if (text === "Cvar_Set2: outer 2\n") f.common.commands.executeNow(nested);
      });
      f.common.commands.executeNow("set outer 2");
      expect(f.common.cvars.get("outer")?.value).toBe("unchanged");
      expect(f.common.cvars.get(target)?.value).toBe("2");
    }
  });

  test("direct cvar assignment retains its value byte offset through the developer print", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("retained-value", async () => undefined);
    f.common.cvars.register("outer", "unchanged");
    f.observePrint(text => {
      if (text === "Cvar_Set2: outer 2\n") f.common.commands.executeNow("echo replacement");
    });
    f.common.commands.executeNow("outer 2");
    expect(f.common.cvars.get("outer")?.value).toBe("eplacement");
  });

  test("cvar inspection reads the held record latch after its first print returns", async () => {
    const f = await fixture();
    f.common.cvars.register("x", "1", CvarFlag.Latch);
    f.common.cvars.set("x", "2");
    f.printed.length = 0;
    f.observePrint(text => {
      if (text.startsWith('"x" is:')) f.common.cvars.set("x", "3");
    });
    f.common.commands.executeNow("x");
    expect(f.printed).toEqual(['"x" is:"1^7" default:"1^7"\n', "x will be changed upon restarting.\n", 'latched: "3"\n']);
  });

  test("cvar inspection keeps its cleared source record when a print recreates the same name", async () => {
    const f = await fixture();
    f.common.cvars.set("removed", "1");
    f.common.cvars.addFlags("removed", CvarFlag.Latch);
    f.common.cvars.set("removed", "2");
    f.printed.length = 0;
    f.observePrint(text => {
      if (!text.startsWith('"removed" is:')) return;
      f.common.commands.executeNow("cvar_restart");
      f.common.cvars.register("removed", "3", CvarFlag.Latch);
      f.common.cvars.set("removed", "4");
    });
    f.common.commands.executeNow("removed");
    expect(f.printed).toEqual(['"removed" is:"1^7" default:"1^7"\n', "removed will be changed upon restarting.\n"]);
    expect(f.common.cvars.get("removed")).toMatchObject({ value: "3", latchedValue: "4" });
  });

  test("echo rereads argument count and contents after recursive print commands", async () => {
    const f = await fixture();
    f.printed.length = 0;
    f.observePrint(text => { if (text === "a ") f.common.commands.executeNow("echo nested"); });
    f.common.commands.executeNow("echo a b");
    expect(f.printed).toEqual(["a ", "nested ", "\n", "\n"]);
    f.printed.length = 0;
    f.observePrint(text => { if (text === "a ") f.common.commands.executeNow("echo nested extra"); });
    f.common.commands.executeNow("echo a b c");
    expect(f.printed).toEqual(["a ", "nested ", "extra ", "\n", "extra ", "\n"]);
  });

  test("cvarlist reads each flag and the value after preceding print callbacks", async () => {
    const f = await fixture();
    f.common.cvars.register("x", "old");
    f.printed.length = 0;
    let changed = false;
    f.observePrint(text => {
      if (text !== " " || changed) return;
      changed = true;
      f.common.cvars.addFlags("x", CvarFlag.Archive);
      f.common.cvars.set("x", "new", true);
    });
    f.common.commands.executeNow("cvarlist x");
    expect(changed).toBe(true);
    expect(f.printed.join("")).toStartWith('    A   x "new"\n');
  });

  test("cvarlist retains its filter byte offset across recursive tokenization", async () => {
    for (const nested of ["cvarlist b*", "echo zzzzb*"]) {
      const f = await fixture();
      f.common.cvars.register("b_tail", "b");
      f.common.cvars.register("a_tail", "a");
      f.common.cvars.register("a_head", "head");
      f.printed.length = 0;
      let changed = false;
      f.observePrint(text => {
        if (text !== " " || changed) return;
        changed = true;
        f.common.commands.executeNow(nested);
      });
      f.common.commands.executeNow("cvarlist a*");
      const rows = f.printed.filter(text => text.startsWith(" a_") || text.startsWith(" b_"));
      expect(rows).toEqual(nested === "cvarlist b*"
        ? [' b_tail "b"\n', ' a_head "head"\n', ' b_tail "b"\n']
        : [' a_head "head"\n', ' b_tail "b"\n']);
    }
  });

  test("cvarlist prints the actual cleared current record after a recursive restart", async () => {
    const f = await fixture();
    f.common.cvars.set("removed", "start");
    f.common.cvars.addFlags("removed", CvarFlag.Archive | CvarFlag.Latch);
    f.common.cvars.set("removed", "pending");
    const record = f.common.cvars.find("removed");
    if (record === undefined) throw new Error("Missing retained cvar record");
    const indexes = f.common.cvars.indexCount;
    f.printed.length = 0;
    let restarted = false;
    f.observePrint(text => {
      if (text !== " " || restarted) return;
      restarted = true;
      f.common.commands.executeNow("cvar_restart");
    });
    f.common.commands.executeNow("cvarlist removed");
    expect(f.printed.join("")).toBe(`        (null) "(null)"\n\n1 total cvars\n${indexes} cvar indexes\n`);
    expect(f.common.cvars.get("removed")).toBeUndefined();
    expect(record.nameString).toBeNull();
    expect(record.currentString).toBeNull();
    expect(record.resetString).toBeNull();
    expect(record.latchedString).toBeNull();
    expect(record).toMatchObject({ flags: 0, modified: false, modificationCount: 0, numericValue: 0, integerValue: 0 });
  });

  test("a latch assignment resumes into the same cleared record after its print callback", async () => {
    const f = await fixture();
    f.common.cvars.set("removed", "start");
    f.common.cvars.addFlags("removed", CvarFlag.Latch);
    const record = f.common.cvars.find("removed");
    if (record === undefined) throw new Error("Missing retained cvar record");
    f.printed.length = 0;
    f.observePrint(text => {
      if (text === "removed will be changed upon restarting.\n") f.common.commands.executeNow("cvar_restart");
    });
    f.common.commands.executeNow("set removed pending");
    expect(f.printed).toEqual(["removed will be changed upon restarting.\n"]);
    expect(f.common.cvars.get("removed")).toBeUndefined();
    expect(record.nameString).toBeNull();
    expect(record.currentString).toBeNull();
    expect(record.resetString).toBeNull();
    expect(record.latchedString?.value).toBe("pending");
    expect(record).toMatchObject({ flags: 0, modified: true, modificationCount: 1, numericValue: 0, integerValue: 0 });
  });

  test("recursive field completion replaces the shared match state used by outer listing", async () => {
    const f = await fixture(), outer = new EditField(), inner = new EditField();
    f.common.commands.register("map_a", () => {});
    f.common.commands.register("map_b", () => {});
    outer.setText("map_");
    inner.setText("wai");
    f.printed.length = 0;
    const print = (text: string): undefined => { f.common.output.print(text); };
    f.observePrint(text => {
      if (text === "]\\map_\n") inner.complete(f.common.commands, f.common.cvars, print);
    });
    outer.complete(f.common.commands, f.common.cvars, print);
    expect(f.printed).toEqual(["]\\map_\n", "    wait\n"]);
    expect(outer.text).toBe("\\map_");
    expect(inner.text).toBe("\\wait ");
  });

  test("cvarlist advances through current links after a recursive restart removes a later row", async () => {
    const f = await fixture();
    f.common.cvars.register("row_tail", "1");
    f.common.cvars.set("row_removed", "2");
    f.common.cvars.register("row_head", "3");
    f.printed.length = 0;
    let restarted = false;
    f.observePrint(text => {
      if (text !== " " || restarted) return;
      restarted = true;
      f.common.commands.executeNow("cvar_restart");
    });
    f.common.commands.executeNow("cvarlist");
    const output = f.printed.join("");
    expect(restarted).toBe(true);
    expect(output).toContain('row_head "3"\n');
    expect(output).toContain('row_tail "1"\n');
    expect(output).not.toContain("row_removed");
    expect(output).toContain(`${f.common.cvars.snapshots().length} total cvars\n`);
  });

  test("runtime settings use source flags and live sv_cheats protection", async () => {
    const f = await fixture("+set com_maxfps 125+set dedicated 2");
    expect(f.common.registerRuntimeCvars("test-date", async () => undefined)).toBe(2);
    expect(f.common.cvars.get("com_maxfps")?.value).toBe("125");
    expect(f.common.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
    expect(f.common.cvars.get("timescale")?.flags).toBe(CvarFlag.Cheat | CvarFlag.SystemInfo);
    f.common.cvars.set("sv_cheats", "0", true); await execute(f.common, "timescale 2\n");
    expect(f.common.cvars.get("timescale")?.value).toBe("1");
    expect(f.printed.join("")).toContain("timescale is cheat protected.\n");
    f.common.cvars.set("sv_cheats", "1", true); await execute(f.common, "timescale 2\n");
    expect(f.common.cvars.get("timescale")?.value).toBe("2");
    expect(f.common.cvars.get("viewlog")?.value).toBe("1");
    await execute(f.common, "timedemo 1\n");
    expect(f.common.cvars.get("timedemo")?.value).toBe("1");
  });

  test("dedicated mode retains defined raw int32 values outside the common branch predicates", async () => {
    const f = await fixture("+set dedicated -7");
    expect(f.common.registerRuntimeCvars("raw-mode", async () => undefined)).toBe(-7);
    expect(f.common.cvars.get("dedicated")?.integerValue).toBe(-7);
    expect(f.common.cvars.get("dedicated")?.flags).toBe(CvarFlag.ReadOnly);
  });

  test("a supplied real host quit is registered at the native common command position", async () => {
    const f = await fixture(), invoked: string[] = [];
    f.common.registerRuntimeCvars("test-date", async context => { invoked.push(context.raw); });
    expect(f.common.commands.registeredNames().slice(0, 3)).toEqual(["writeconfig", "changeVectors", "quit"]);
    await f.common.commands.executeNowAsync("quit"); expect(invoked).toEqual(["quit"]);
  });

  test("archive writes truncate real home files only after full init and preserve latched source lines", async () => {
    const f = await fixture(); f.common.registerRuntimeCvars("test-date", async () => undefined);
    const path = join(f.homePath, "baseq3", "q3config.cfg");
    await execute(f.common, 'seta first "old"\n');
    await f.common.writeConfiguration(); expect(existsSync(path)).toBe(false);
    f.common.cvars.register("second", "a", CvarFlag.Archive | CvarFlag.Latch);
    f.common.cvars.set("second", "pending"); f.common.markInitialized(); await f.common.writeConfiguration();
    expect(readFileSync(path, "latin1")).toBe('// generated by quake, do not modify\nseta second "pending"\nseta first "old"\nseta com_introplayed "0"\nseta com_blood "1"\nseta com_maxfps "85"\nseta com_hunkMegs "56"\nseta com_zoneMegs "16"\n');
    expect(f.common.cvars.modifiedFlags & CvarFlag.Archive).toBe(0);
    await execute(f.common, 'seta first "x"\nwriteconfig explicit\n');
    const explicit = readFileSync(join(f.homePath, "baseq3", "explicit.cfg"), "latin1");
    expect(explicit).toContain('seta first "x"\n');
    await f.common.writeConfiguration(); expect(readFileSync(path, "latin1")).toBe(explicit);
    f.common.cvars.set("first", "not-auto-written-on-close"); f.common.close();
    expect(readFileSync(path, "latin1")).not.toContain("not-auto-written-on-close");
  });

  test("archive writes read later records after an earlier formatting diagnostic callback", async () => {
    const f = await fixture();
    f.common.registerRuntimeCvars("archive-callback", async () => undefined);
    f.common.cvars.register("tail", "old", CvarFlag.Archive);
    f.common.cvars.set("removed", "skip");
    f.common.cvars.addFlags("removed", CvarFlag.Archive);
    f.common.cvars.register("head", "x".repeat(1024), CvarFlag.Archive);
    f.common.markInitialized();
    f.common.cvars.markModifiedFlags(CvarFlag.Archive);
    f.printed.length = 0;
    f.observePrint(text => {
      if (text !== "Com_sprintf: overflow of 1037 in 1024\n") return;
      f.common.commands.executeNow("cvar_restart");
      f.common.commands.executeNow("set tail new");
      f.common.commands.executeNow("seta born excluded");
    });
    await f.common.writeConfiguration();
    const config = readFileSync(join(f.homePath, "baseq3", "q3config.cfg"), "latin1");
    expect(f.printed).toEqual(["Com_sprintf: overflow of 1037 in 1024\n"]);
    expect(config).toStartWith('// generated by quake, do not modify\nseta head "' + "x".repeat(1012) + 'seta tail "new"\n');
    expect(config).not.toContain("removed");
    expect(config).not.toContain("born");
    expect(f.common.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
  });

  test("common logfile writes source opening order and excludes redirected output", async () => {
    const f = await fixture("+set logfile 2"); f.common.registerRuntimeCvars("test-date", async () => undefined);
    const path = join(f.homePath, "baseq3", "qconsole.log");
    f.common.output.print("first print\n");
    const first = readFileSync(path, "latin1");
    expect(first).toMatch(/^logfile opened on [A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9:]+ [0-9]+\n\nfirst print\n$/);
    const redirected: string[] = [];
    await f.common.output.redirect(100, text => { redirected.push(text); }, async () => { f.common.output.print("redirected only"); });
    expect(redirected).toEqual(["redirected only"]); expect(readFileSync(path, "latin1")).toBe(first);
    f.common.cvars.set("logfile", "0", true); f.common.output.print("disabled\n");
    expect(readFileSync(path, "latin1")).toBe(first);
    f.common.cvars.set("logfile", "1", true); f.common.output.print("continued\n"); f.common.close();
    expect(readFileSync(path, "latin1")).toBe(`${first}continued\n`);
    expect(() => f.common.output.print("after close")).toThrow("closed");
  });

  test("an early logfile startup value cannot open the common log before its runtime cvar binding", async () => {
    const f = await fixture("+set logfile 2"), path = join(f.homePath, "baseq3", "qconsole.log");
    await execute(f.common, "exec default.cfg\necho early config\n");
    expect(existsSync(path)).toBe(false);
    f.common.registerRuntimeCvars("test-date", async () => undefined); f.common.output.print("runtime log\n");
    expect(readFileSync(path, "latin1")).not.toContain("early config");
    expect(readFileSync(path, "latin1")).toContain("runtime log\n");
  });

  test("common callbacks reject unrelated engine operations and stale exec cannot print or insert", async () => {
    const f = await fixture(); f.permit(false);
    await expect(execute(f.common, "set blocked 1\n")).rejects.toThrow("Unrelated engine operation");
    expect(f.common.cvars.get("blocked")).toBeUndefined();
    expect(f.common.commands.pendingText).toBe("set blocked 1\n");
    f.permit(true); await f.common.commands.executeAsync();
    expect(f.common.cvars.get("blocked")?.value).toBe("1");
    writeFileSync(join(f.homePath, "baseq3", "delayed.cfg"), "set escaped 1\n");
    const files = f.common.files.current, read = files.readFileRetained.bind(files), gate = deferred(), entered = deferred();
    files.readFileRetained = async path => { if (path === "delayed.cfg") { entered.finish(); await gate.promise; } return read(path); };
    const child: { current: Promise<{ readonly kind: "success" } | { readonly kind: "failure"; readonly error: unknown }> | null } = { current: null };
    f.common.commands.register("escape", () => {
      child.current = f.common.commands.executeNowAsync("exec delayed.cfg").then(() => ({ kind: "success" }), (error: unknown) => ({ kind: "failure", error }));
    });
    try {
      const parent = f.common.commands.executeNowAsync("escape"); await entered.promise;
      await expect(parent).rejects.toThrow("awaited");
      gate.finish();
      if (child.current === null) throw new Error("Missing nested read result");
      const outcome = await child.current;
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") expect(String(outcome.error)).toContain("closed command execution context");
      expect(f.printed.join("")).not.toContain("execing delayed.cfg");
      expect(f.common.cvars.get("escaped")).toBeUndefined(); expect(f.common.commands.pendingText).toBe("");
    } finally { gate.finish(); files.readFileRetained = read; }
  });

  test("wait and close reject unrelated server work without mutating command or file lifetime", async () => {
    const f = await fixture(); f.permit(false);
    expect(() => f.common.commands.executeNow("wait 1")).toThrow("Unrelated engine operation");
    expect(() => f.common.close()).toThrow("Unrelated engine operation");
    f.permit(true); await execute(f.common, "echo unaffected\n");
    expect(f.printed.join("")).toContain("unaffected \n");
    expect(f.common.commands.pendingText).toBe("");
  });

  test("central common ownership covers custom commands and empty drains, including after close", async () => {
    const f = await fixture(), trace: string[] = [];
    f.common.commands.register("custom", () => { trace.push("sync"); });
    f.common.commands.registerAsync("custom_async", async () => { trace.push("async"); });
    const names = f.common.commands.registeredNames();
    f.permit(false);
    expect(() => f.common.commands.executeNow("custom")).toThrow("Unrelated engine operation");
    await expect(f.common.commands.executeNowAsync("custom_async")).rejects.toThrow("Unrelated engine operation");
    expect(() => f.common.commands.execute()).toThrow("Unrelated engine operation");
    await expect(f.common.commands.executeAsync()).rejects.toThrow("Unrelated engine operation");
    expect(f.common.commands.registeredNames()).toEqual(names); expect(trace).toEqual([]);
    f.permit(true); await f.common.commands.executeNowAsync("custom_async");
    f.common.close();
    expect(() => f.common.commands.executeNow("custom")).toThrow("Common console is closed");
    expect(() => f.common.commands.execute()).toThrow("Common console is closed");
    await expect(f.common.commands.executeNowAsync("unknown")).rejects.toThrow("Common console is closed");
    await expect(f.common.commands.executeAsync()).rejects.toThrow("Common console is closed");
    expect(trace).toEqual(["async"]);
  });

  test("unrelated close cannot release common files while exec is awaiting its actual read", async () => {
    const f = await fixture("+set logfile 2"); f.common.registerRuntimeCvars("test-date", async () => undefined);
    f.common.output.print("before exec\n");
    writeFileSync(join(f.homePath, "baseq3", "delayed.cfg"), "echo after exec\n");
    const files = f.common.files.current, read = files.readFileRetained.bind(files), gate = deferred(), entered = deferred();
    files.readFileRetained = async path => { entered.finish(); await gate.promise; return read(path); };
    const drain = execute(f.common, "exec delayed.cfg\n");
    try {
      await entered.promise;
      expect(() => f.common.close()).toThrow("overlapping command execution");
      expect(f.common.files.current).toBe(files);
      gate.finish(); await drain;
      expect(readFileSync(join(f.homePath, "baseq3", "qconsole.log"), "latin1")).toContain("after exec \n");
    } finally { gate.finish(); await drain.catch(() => undefined); files.readFileRetained = read; }
  });

  test("invalid seta names create BADNAME without flagging a nonexistent literal lookup", async () => {
    const f = await fixture();
    await execute(f.common, 'seta "bad;name" value\n');
    expect(f.common.cvars.get("bad;name")).toBeUndefined();
    expect(f.common.cvars.get("BADNAME")?.flags).toBe(CvarFlag.UserCreated);
    expect(f.printed.join("")).toContain("invalid cvar name string: bad;name\n");
  });

  test("developer error command raises source fatal or drop control using parsed argument count", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("test-date", async () => undefined);
    const cases: readonly (readonly [string, "fatal" | "drop", string])[] = [
      ["error", "fatal", "Testing fatal error"],
      ["error // no argument", "fatal", "Testing fatal error"],
      ['error ""', "drop", "Testing drop error"],
      ["error fatal ignored", "drop", "Testing drop error"],
    ];
    for (const [command, code, message] of cases) {
      let observed: unknown;
      try { await f.common.commands.executeNowAsync(command); }
      catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(CommonError);
      if (!(observed instanceof CommonError)) throw new Error("Developer command did not raise common error control");
      expect(observed.code).toBe(code);
      expect(observed.message).toBe(message);
    }
  });

  test("developer error registration samples runtime initialization and survives later developer changes", async () => {
    const enabled = await fixture("+set developer 1");
    await execute(enabled.common, "error before-runtime\n");
    expect(enabled.unknown).toEqual(["error before-runtime"]);
    enabled.common.registerRuntimeCvars("test-date", async () => undefined);
    await execute(enabled.common, "set developer 0\n");
    await expect(enabled.common.commands.executeNowAsync("error drop")).rejects.toMatchObject({ code: "drop", message: "Testing drop error" });
    const disabled = await fixture();
    disabled.common.registerRuntimeCvars("test-date", async () => undefined);
    await execute(disabled.common, "set developer 1\nerror still-unregistered\n");
    expect(disabled.unknown).toEqual(["error still-unregistered"]);
  });

  test("command-buffer warnings use actual common redirection and preserve the original command handler", async () => {
    const f = await fixture(), redirected: string[] = [];
    const printedBefore = f.printed.length;
    let replaced = false;
    f.common.commands.append("x".repeat(16383));
    await f.common.output.redirect(256, text => { redirected.push(text); }, async () => {
      f.common.commands.append("y");
      f.common.commands.insert("z");
      f.common.commands.register("echo", () => { replaced = true; });
      await f.common.commands.executeNowAsync("echo continued");
    });
    expect(redirected).toEqual(["Cbuf_AddText: overflow\nCbuf_InsertText overflowed\nCmd_AddCommand: echo already defined\ncontinued \n"]);
    expect(f.printed).toHaveLength(printedBefore);
    expect(f.common.commands.pendingText).toBe("x".repeat(16383));
    expect(replaced).toBe(false);
  });

  test("changeVectors silently executes the pinned zero-counter source command", async () => {
    const f = await fixture();
    f.common.registerRuntimeCvars("change-vectors", async () => undefined);
    const printedBefore = f.printed.length;
    expect(await f.common.commands.executeNowAsync("changeVectors ignored")).toBe(1);
    expect(f.printed).toHaveLength(printedBefore);
    expect(f.unknown).toEqual([]);
  });

  test("freeze prints source argument usage and requires a published clock only for a timed call", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("freeze-usage", async () => undefined);
    const printedBefore = f.printed.length;
    for (const command of ["freeze", "freeze 1 ignored"]) expect(await f.common.commands.executeNowAsync(command)).toBe(1);
    expect(f.printed.slice(printedBefore)).toEqual(["freeze <seconds>\n", "freeze <seconds>\n"]);
    await expect(f.common.commands.executeNowAsync("freeze 0")).rejects.toThrow("published common event clock");
    for (const duration of ["nan", "inf", "1e39", "2147483.75"]) {
      await expect(f.common.commands.executeNowAsync(`freeze ${duration}`)).rejects.toThrow("cannot terminate");
    }
  });

  test("freeze polls common events with native atof, binary32 seconds, strict expiration and signed wrap", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("freeze-timing", async () => undefined);
    const queued: CommonSystemEvent[] = [];
    let reads = 0;
    const events = new CommonEvents({ getEvent: () => {
      reads++;
      const event = queued.shift();
      if (event === undefined) throw new Error("Freeze read past the authored source timeline");
      return event;
    } }, text => { f.common.output.print(text); }, f.common.eventMemory);
    f.common.publishCommonClock(events);
    expect(reads).toBe(0);
    events.captureFrameTime(71);
    f.common.commands.executeNow("set developer 0");
    f.common.commands.append("echo held");
    const cases: readonly (readonly [string, readonly number[]])[] = [
      ["-0.1trailing", [100, 100]],
      ["-inf", [100, 100]],
      ["nonnumeric", [100, 100, 101]],
      ["0.001", [100, 101, 102]],
      ["0x1p-2", [1000, 1250, 1251]],
      ["0.99999999", [1000, 2000, 2001]],
      ["0.125", [2147483640, -2147483531, -2147483530]],
    ];
    const printedBefore = f.printed.length;
    for (const [duration, times] of cases) {
      for (const time of times) queued.push({ kind: "none", time });
      const before = reads;
      expect(await f.common.commands.executeNowAsync(`freeze ${duration}`)).toBe(1);
      expect(reads - before).toBe(times.length);
      expect(queued).toEqual([]);
      expect(events.comFrameTime).toBe(71);
      expect(f.common.commands.pendingText).toBe("echo held");
    }
    expect(f.printed).toHaveLength(printedBefore);
    expect(f.unknown).toEqual([]);
  });

  test("freeze retains acquired command events for the actual common event owner", async () => {
    const f = await fixture("+set developer 1");
    f.common.registerRuntimeCvars("freeze-events", async () => undefined);
    const first = f.common.eventMemory.console(10, "echo first"), second = f.common.eventMemory.console(20, "echo second");
    const queued: CommonSystemEvent[] = [first, { kind: "none", time: 100 }, second, { kind: "none", time: 101 }];
    const events = new CommonEvents({ getEvent: () => {
      const event = queued.shift();
      if (event === undefined) throw new Error("Freeze read past the authored event sequence");
      return event;
    } }, text => { f.common.output.print(text); }, f.common.eventMemory);
    f.common.publishCommonClock(events);
    expect(await f.common.commands.executeNowAsync("freeze 0")).toBe(1);
    expect(f.common.commands.pendingText).toBe("");
    expect(queued).toEqual([]);
    for (const source of [first, second]) {
      const retained = events.getEvent();
      expect(retained).toEqual(source);
      expect(f.common.eventMemory.payload(retained)).toBe(f.common.eventMemory.payload(source));
      f.common.eventMemory.free(retained);
    }
  });

  test("freeze clock publication is unique and a reached owner retirement stops subsequent clock reads", async () => {
    const f = await fixture("+set developer 1");
    let reads = 0;
    const events = new CommonEvents({ getEvent: () => {
      reads++;
      f.permit(false);
      return { kind: "none", time: 1 };
    } }, text => { f.common.output.print(text); });
    expect(() => f.common.publishCommonClock(events)).toThrow("follow runtime registration exactly once");
    f.common.registerRuntimeCvars("freeze-owner", async () => undefined);
    f.common.publishCommonClock(events);
    expect(() => f.common.publishCommonClock(events)).toThrow("follow runtime registration exactly once");
    try {
      await expect(f.common.commands.executeNowAsync("freeze 0")).rejects.toThrow("Unrelated engine operation is active");
      expect(reads).toBe(1);
    } finally { f.permit(true); }
  });

  test("source profile controls are available while unsafe native crash remains guarded", async () => {
    const f = await fixture("+set developer 1"); f.common.registerRuntimeCvars("test-date", async () => undefined);
    await expect(f.common.commands.executeNowAsync("crash")).rejects.toThrow("unsafe native NULL-pointer fault");
    await f.common.commands.executeNowAsync("set com_speeds 1");
    await f.common.commands.executeNowAsync("set com_showtrace 1");
    expect(f.common.cvars.get("com_speeds")?.integerValue).toBe(1);
    expect(f.common.cvars.get("com_showtrace")?.integerValue).toBe(1);
    writeFileSync(join(f.homePath, "baseq3", "profile.txt"), "full");
    f.common.cvars.set("fs_restrict", "1", true);
    f.common.assertCapabilities();
    expect(f.common.cvars.get("fs_restrict")?.flags).toBe(CvarFlag.Init);
    expect(f.common.files.current.readFileLength("profile.txt")).toBe(-1);
    expect(f.common.files.current.has("profile.txt")).toBe(true);
    expect(f.common.files.current.readFileLength("default.cfg")).toBeGreaterThan(0);
    f.common.cvars.set("fs_restrict", "0", true);
    expect(f.common.files.current.readFileLength("profile.txt")).toBe(4);
    await f.common.commands.executeNowAsync("set fs_debug 1");
    expect(f.common.cvars.get("fs_debug")?.integerValue).toBe(1);
  });
});
