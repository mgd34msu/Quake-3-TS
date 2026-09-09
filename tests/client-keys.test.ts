import { describe, expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { KeyCode, KeyCatcher } from "../src/core/key-codes.ts";
import { ClientKeys, keynumToString, stringToKeynum } from "../src/engine/client-keys.ts";
import type { ClientKeyConnection, ClientKeyHost, ClientKeyUi } from "../src/engine/client-keys.ts";

function fixture() {
  const prints: string[] = [], calls: string[] = [], reliable: string[] = [], cvars = new CvarRegistry();
  const commands = new CommandBuffer({ resolveFallback: () => ({ kind: "sync", handler: context => { calls.push(`unknown:${context.raw}`); } }) });
  let connection: ClientKeyConnection = { kind: "active", demoPlayback: false };
  let ui: ClientKeyUi | null = { keyEvent: async (key, down) => { calls.push(`ui:${key}:${down}`); }, setActiveMenu: async menu => { calls.push(`menu:${menu}`); } };
  let cgame: ReturnType<ClientKeyHost["readCgame"]> = { keyEvent: async (key, down) => { calls.push(`cgame:${key}:${down}`); }, eventHandling: async type => { calls.push(`event:${type}`); } };
  let screen: () => Promise<void> = async () => { calls.push("screen"); };
  const host: ClientKeyHost = { readConnection: () => connection, readUi: () => ui, readCgame: () => cgame,
    assertCurrentOperation: () => { commands.assertCurrentExecution(); }, disconnect: async () => { calls.push("disconnect"); connection = { kind: "disconnected", demoPlayback: false }; },
    stopAllSounds: () => { calls.push("stop-sounds"); }, addReliableCommand: text => { reliable.push(text); },
    toggleConsole: async () => { calls.push("toggle"); }, updateScreen: () => screen(), consoleScroll: action => { calls.push(action); },
    readConsoleWidth: () => 78, clipboard: { kind: "native-unix-unavailable" },
  };
  const keys = new ClientKeys({ commands, cvars, print: text => { prints.push(text); }, host }); keys.initializeCommands(); keys.initializeConsoleFields(78);
  return { keys, commands, cvars, prints, calls, reliable,
    connection: (value: ClientKeyConnection) => { connection = value; }, ui: (value: ClientKeyUi | null) => { ui = value; },
    cgame: (value: ReturnType<ClientKeyHost["readCgame"]>) => { cgame = value; }, screen: (value: () => Promise<void>) => { screen = value; } };
}
function deferred() {
  let resolve: (() => void) | undefined; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve: () => { if (resolve === undefined) throw new Error("Missing deferred resolver"); resolve(); } };
}

describe("source key owner", () => {
  test("all byte key names roundtrip through named/hex forms and preserve signed literal parsing", () => {
    for (let key = 0; key < 256; key++) expect(stringToKeynum(keynumToString(key))).toBe(key);
    expect(stringToKeynum("\xff")).toBe(-1); expect(stringToKeynum("\xe9")).toBe(-23);
    expect(stringToKeynum("0xAF")).toBe(0); expect(stringToKeynum("0xaG")).toBe(160); expect(stringToKeynum("0Xaf")).toBe(-1);
    expect(stringToKeynum("f13")).toBe(-1); expect(keynumToString(KeyCode.F13)).toBe("0x9d");
    expect(stringToKeynum("kp_enter")).toBe(KeyCode.KeypadEnter); expect(keynumToString(-1)).toBe("<KEY NOT FOUND>");
    expect(keynumToString(256)).toBe("<OUT OF RANGE>"); expect(stringToKeynum(null)).toBe(-1);
  });
  test("bindings preserve null versus empty, case-insensitive find, flags and original diagnostic text", () => {
    const f = fixture(); expect([...f.commands.registeredNames()].reverse()).toEqual(["wait", "bind", "unbind", "unbindall", "bindlist"]);
    expect(f.keys.getBinding(119)).toBeNull(); f.commands.executeNow("bind w"); f.commands.executeNow("unbind w"); f.commands.executeNow("bind w");
    expect(f.prints).toEqual(['"w" is not bound\n', '"w" = ""\n']); expect(f.keys.getKey("")).toBe(119);
    f.cvars.clearModifiedFlags(CvarFlag.Archive); f.keys.setBinding(119, ""); expect(f.cvars.modifiedFlags).toBe(CvarFlag.Archive);
    f.commands.executeNow('bind w +forward'); expect(f.keys.getKey("+FORWARD")).toBe(119);
    f.keys.setBinding(1, "+forward"); expect(f.keys.getKey("+forward")).toBe(1);
    f.cvars.clearModifiedFlags(CvarFlag.Archive); f.keys.setBinding(-1, "\u0100"); expect(f.cvars.modifiedFlags).toBe(0);
    expect(f.keys.getBinding(-1)).toBe(""); expect(f.keys.isDown(-1)).toBe(false);
    f.commands.executeNow("unbindall"); expect(f.keys.getBinding(0)).toBeNull(); expect(f.keys.getBinding(1)).toBe("");
    expect(() => f.keys.setBinding(-23, "x")).toThrow("Undefined native key index");
  });
  test("global archive mark touches no cvar bookkeeping and bindings precede archive commands", () => {
    const f = fixture(); f.cvars.register("setting", "a", CvarFlag.Archive | CvarFlag.Latch); f.cvars.set("setting", "b");
    const before = f.cvars.get("setting"); f.cvars.takeModifiedFlags(); f.keys.setBinding(59, "echo hello");
    expect(f.cvars.get("setting")).toEqual(before); expect(f.cvars.modifiedFlags).toBe(CvarFlag.Archive);
    f.keys.setBinding(KeyCode.Mouse1, "+attack"); const lines: string[] = ["header\n"];
    f.keys.writeBindings(text => { lines.push(text); }); lines.push(...f.cvars.archiveCommands());
    expect(lines).toEqual(["header\n", "unbindall\n", 'bind SEMICOLON "echo hello"\n', 'bind MOUSE1 "+attack"\n', 'seta setting "b"']);
  });
  test("repeats queue again but count anykeydown only once; unmatched release still decrements", async () => {
    const f = fixture(); f.keys.setBinding(119, "+forward");
    await f.keys.keyEvent(119, true, 100); await f.keys.keyEvent(119, true, 101);
    expect(f.keys.inputState.anyKeyDown).toBe(1); expect(f.commands.pendingText).toBe("+forward 119 100\n+forward 119 101\n");
    await f.keys.keyEvent(120, false, 102); expect(f.keys.inputState.anyKeyDown).toBe(0); expect(f.keys.isDown(119)).toBe(true);
    await f.keys.keyEvent(119, false, 103); expect(f.keys.inputState.anyKeyDown).toBe(4294967295);
    await f.keys.keyEvent(119, true, 104); expect(f.keys.inputState.anyKeyDown).toBe(0);
    await f.keys.keyEvent(119, true, 105); expect(f.keys.inputState.anyKeyDown).toBe(0);
    await f.keys.keyEvent(119, false, 106); expect(f.keys.inputState.anyKeyDown).toBe(4294967295);
  });
  test("repair propagates event time and release parser preserves source trailing commands and rebound text", async () => {
    const f = fixture(); f.keys.setBinding(119, "+forward; echo down; +attack; echo end");
    await f.keys.keyEvent(119, true, 123); f.keys.setCatcher(KeyCatcher.Console | KeyCatcher.Ui);
    await f.keys.keyEvent(119, false, 234);
    expect(f.commands.pendingText).toBe("+forward 119 123\necho down\n+attack 119 123\necho end\n-forward 119 234\necho down\n-attack 119 234\necho end\n");
    expect(f.calls).toEqual(["ui:119:false"]);
    f.keys.setBinding(119, "echo early; +back;echo later"); await f.keys.keyEvent(119, false, 0xffffffff);
    expect(f.commands.pendingText.endsWith("-back 119 -1\necho later\n")).toBe(true);
  });
  test("quoted semicolons split only in special button parser, and ordinary leading text stays raw", async () => {
    const f = fixture(); f.keys.setBinding(1, '+x "a;b";\xff +y'); await f.keys.keyEvent(1, true, 1);
    expect(f.commands.pendingText).toBe('+x "a 1 1\nb"\n+y 1 1\n');
    f.keys.setBinding(2, "echo first;+forward"); await f.keys.keyEvent(2, true, 2);
    expect(f.commands.pendingText.endsWith("echo first;+forward\n")).toBe(true);
  });
  test("ClearStates resets any before release callbacks and releases held cells in ascending order", async () => {
    const f = fixture(), seen: number[] = []; f.keys.setBinding(100, "+forward"); f.keys.setBinding(50, "+back");
    await f.keys.keyEvent(100, true, 1); await f.keys.keyEvent(50, true, 2); f.keys.setCatcher(KeyCatcher.Ui);
    f.ui({ keyEvent: async key => { seen.push(key, f.keys.inputState.anyKeyDown); }, setActiveMenu: async () => undefined });
    await f.keys.clearStates(); expect(seen).toEqual([50, 4294967295, 100, 4294967294]); expect(f.keys.isDown(50)).toBe(false); expect(f.keys.isDown(100)).toBe(false);
    expect(f.commands.pendingText.endsWith("-back 50 0\n-forward 100 0\n")).toBe(true); expect(f.keys.getBinding(100)).toBe("+forward");
  });
  test("Alt-Enter clears then force-sets fullscreen and appends restart; console keys always override bindings", async () => {
    const f = fixture(); f.cvars.register("r_fullscreen", "0", CvarFlag.ReadOnly); f.keys.setBinding(KeyCode.Alt, "+speed");
    await f.keys.keyEvent(KeyCode.Alt, true, 1); await f.keys.keyEvent(KeyCode.Enter, true, 2);
    expect(f.commands.pendingText).toBe(`+speed ${KeyCode.Alt} 1\n-speed ${KeyCode.Alt} 0\nvid_restart\n`);
    expect(f.cvars.get("r_fullscreen")?.value).toBe("1"); expect(f.keys.inputState.anyKeyDown).toBe(4294967294);
    f.keys.setBinding(96, "+forward"); await f.keys.keyEvent(96, true, 3); await f.keys.keyEvent(96, false, 4); await f.keys.charEvent(96);
    expect(f.calls).toEqual(["toggle"]); expect(f.commands.pendingText).not.toContain("forward");
  });
  test("Escape priority and demo/cinematic mapping retain the original physical key state", async () => {
    const f = fixture(); f.keys.setCatcher(15); f.keys.chatField.setText("discard"); await f.keys.keyEvent(KeyCode.Escape, true, 1);
    expect(f.keys.getCatcher()).toBe(11); expect(f.calls).toEqual([]); expect(f.keys.chatField.text).toBe("");
    await f.keys.keyEvent(KeyCode.Escape, true, 2); expect(f.keys.getCatcher()).toBe(3); expect(f.calls).toEqual(["event:0"]);
    await f.keys.keyEvent(KeyCode.Escape, true, 3); expect(f.calls.at(-1)).toBe("ui:27:true");
    f.keys.setCatcher(0); await f.keys.keyEvent(KeyCode.Escape, true, 4); expect(f.calls.at(-1)).toBe("menu:ingame");
    f.connection({ kind: "cinematic", demoPlayback: false }); await f.keys.keyEvent(97, true, 5);
    expect(f.keys.isDown(97)).toBe(true); expect(f.calls.slice(-3)).toEqual(["disconnect", "stop-sounds", "menu:main"]);
    expect(f.cvars.get("nextdemo")?.value).toBe("");
  });
  test("normal catcher priority differs from characters, with genuine absent-VM guarded paths", async () => {
    const f = fixture(); f.keys.setCatcher(15); await f.keys.charEvent(65); expect(f.keys.consoleField.text).toBe("A");
    f.keys.setCatcher(14); await f.keys.keyEvent(65, true, 1); await f.keys.charEvent(66); expect(f.calls).toEqual(["ui:65:true", "ui:1090:true"]);
    f.keys.setCatcher(12); await f.keys.keyEvent(67, true, 2); await f.keys.charEvent(68);
    expect(f.calls.at(-1)).toBe("cgame:67:true"); expect(f.keys.chatField.text).toBe("D");
    f.ui(null); f.keys.setCatcher(2); await f.keys.keyEvent(70, true, 3); await expect(f.keys.charEvent(71)).rejects.toThrow("unavailable product UI");
    f.cgame(null); f.keys.setCatcher(8); await f.keys.keyEvent(72, true, 4); await expect(f.keys.keyEvent(KeyCode.Escape, true, 5)).rejects.toThrow("unavailable cgame");
    expect(f.keys.getCatcher()).toBe(0);
  });
  test("console text/history/completion, disconnected command prefix and chat reliable command", async () => {
    const f = fixture(); f.connection({ kind: "disconnected", demoPlayback: false }); f.keys.consoleField.setText("echo test");
    await f.keys.keyEvent(KeyCode.Enter, true, 1); expect(f.commands.pendingText).toBe("echo test\n"); expect(f.prints).toEqual([
      "]\\echo test\n",
    ]); expect(f.calls).toEqual(["screen"]);
    await f.keys.keyEvent(KeyCode.Up, true, 2); expect(f.keys.consoleField.text).toBe("\\echo test");
    await f.keys.keyEvent(KeyCode.Down, true, 3); expect(f.keys.consoleField.text).toBe("");
    f.connection({ kind: "active", demoPlayback: false }); f.keys.setCatcher(KeyCatcher.Console); f.keys.consoleField.setText("hello world");
    await f.keys.keyEvent(KeyCode.Enter, true, 4); expect(f.commands.pendingText.endsWith("cmd say hello world\n")).toBe(true);
    f.keys.setChatPlayer(-1); f.keys.setChatTeam(true); f.keys.chatField.setText('hi "team"'); f.keys.setCatcher(KeyCatcher.Message);
    await f.keys.keyEvent(KeyCode.Enter, true, 5); expect(f.reliable).toEqual(['say_team "hi "team""\n']); expect(f.keys.getCatcher()).toBe(0);
  });
  test("source outer command guard rejects sibling events but permits awaited nested ClearStates", async () => {
    const f = fixture(), gate = deferred(), entered = deferred(); let nested = false;
    f.keys.setCatcher(KeyCatcher.Ui); f.ui({ setActiveMenu: async () => undefined, keyEvent: async (_key, down) => {
      if (down) { entered.resolve(); await gate.promise; await f.keys.clearStates(); nested = true; }
    } });
    f.commands.registerAsync("event", async () => { await f.keys.keyEvent(100, true, 1); });
    const pending = f.commands.executeNowAsync("event"); await entered.promise;
    await expect(f.keys.keyEvent(101, true, 2)).rejects.toThrow("overlapping command"); expect(f.keys.isDown(101)).toBe(false);
    expect(() => f.keys.setChatTeam(true)).toThrow("overlapping command"); expect(() => f.keys.setChatPlayer(12)).toThrow("overlapping command");
    expect(f.keys.chatTeam).toBe(false); expect(f.keys.chatPlayer).toBe(0);
    gate.resolve(); await pending; expect(nested).toBe(true); expect(f.keys.isDown(100)).toBe(false);
  });
  test("late callback validates its closed outer operation before continuing the clear loop", async () => {
    const f = fixture(), gate = deferred(); await f.keys.keyEvent(1, true, 1); await f.keys.keyEvent(2, true, 1);
    f.keys.setCatcher(2); f.ui({ setActiveMenu: async () => undefined, keyEvent: async () => { await gate.promise; } });
    let escaped: Promise<void> | undefined;
    f.commands.register("escape", () => { escaped = f.keys.clearStates(); });
    f.commands.executeNow("escape"); gate.resolve();
    if (escaped === undefined) throw new Error("Missing escaped clear"); await expect(escaped).rejects.toThrow("closed command");
    expect(f.keys.isDown(1)).toBe(false); expect(f.keys.isDown(2)).toBe(true);
    f.ui(null); await f.keys.clearStates(); expect(f.keys.isDown(2)).toBe(false);
  });
  test("source early catcher returns precede overflow of an unused binding segment", async () => {
    const f = fixture(); f.keys.setBinding(1, "+x;" + "a".repeat(1024)); f.keys.setCatcher(2);
    await f.keys.keyEvent(1, true, 1); expect(f.commands.pendingText).toBe("");
    f.keys.setCatcher(0); await expect(f.keys.keyEvent(1, true, 2)).rejects.toThrow("segment buffer overflow");
    expect(f.commands.pendingText).toBe("+x 1 2\n");
  });
  test("failed release callback leaves source partial state and permits a later owned clear", async () => {
    const f = fixture(); await f.keys.keyEvent(1, true, 1); await f.keys.keyEvent(2, true, 2);
    f.keys.setCatcher(KeyCatcher.Ui); f.ui({ setActiveMenu: async () => undefined, keyEvent: async () => { throw new Error("UI release failed"); } });
    f.commands.registerAsync("clear-keys", async () => { await f.keys.clearStates(); });
    await expect(f.commands.executeNowAsync("clear-keys")).rejects.toThrow("UI release failed");
    expect(f.keys.isDown(1)).toBe(false); expect(f.keys.isDown(2)).toBe(true); expect(f.keys.inputState.anyKeyDown).toBe(4294967295);
    f.ui(null); await f.commands.executeNowAsync("clear-keys");
    expect(f.keys.isDown(2)).toBe(false); expect(f.keys.inputState.anyKeyDown).toBe(4294967295);
    await f.commands.executeNowAsync("clear-keys"); expect(f.keys.inputState.anyKeyDown).toBe(0);
  });
  test("initial and independent chat words preserve player priority and console prompt state", async () => {
    const f = fixture(); expect(f.keys.chatTeam).toBe(false); expect(f.keys.chatPlayer).toBe(0);
    f.keys.chatField.setText("initial"); f.keys.setCatcher(KeyCatcher.Message); await f.keys.keyEvent(KeyCode.Enter, true, 1);
    expect(f.reliable).toEqual(['tell 0 "initial"\n']);
    f.keys.setChatTeam(true); f.keys.setChatPlayer(12);
    expect(f.keys.chatTeam).toBe(true); expect(f.keys.chatPlayer).toBe(12);
    f.keys.chatField.setText("target"); f.keys.setCatcher(KeyCatcher.Message); await f.keys.keyEvent(KeyCode.Enter, true, 2);
    expect(f.reliable.at(-1)).toBe('tell 12 "target"\n');
    f.keys.setChatTeam(false); f.keys.setChatPlayer(-1); f.keys.chatField.setText("all"); f.keys.setCatcher(KeyCatcher.Message);
    await f.keys.keyEvent(KeyCode.Enter, true, 3); expect(f.reliable.at(-1)).toBe('say "all"\n');
    expect(() => f.keys.setChatPlayer(2147483648)).toThrow("int32"); expect(f.keys.chatPlayer).toBe(-1);
  });
  for (const mode of ["crosshair", "attacker"]) for (const result of [-1, 64]) test(`${mode} invalid ${result} retains prior team chat and prompt state`, async () => {
    const f = fixture(); f.keys.setChatPlayer(-1); f.keys.setChatTeam(true); f.keys.chatField.setText("team text");
    f.keys.chatField.widthInChars = 25; f.keys.setCatcher(KeyCatcher.Message);
    f.keys.setChatPlayer(result);
    if (f.keys.chatPlayer < 0 || f.keys.chatPlayer >= 64) f.keys.setChatPlayer(-1);
    else { f.keys.setChatTeam(false); f.keys.chatField.clear(); f.keys.chatField.widthInChars = 30; f.keys.setCatcher(f.keys.getCatcher() ^ KeyCatcher.Message); }
    expect(f.keys.chatPlayer).toBe(-1); expect(f.keys.chatTeam).toBe(true);
    expect(f.keys.chatField.text).toBe("team text"); expect(f.keys.chatField.widthInChars).toBe(25); expect(f.keys.getCatcher()).toBe(KeyCatcher.Message);
    await f.keys.keyEvent(KeyCode.Enter, true, 1); expect(f.reliable).toEqual(['say_team "team text"\n']);
    expect(f.keys.chatTeam).toBe(true); expect(f.keys.chatPlayer).toBe(-1);
  });
});
