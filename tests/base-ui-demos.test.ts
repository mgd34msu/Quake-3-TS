import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { BaseDemosMenu } from "../src/ui/base/demos.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const art = ["menu/art/back_0", "menu/art/back_1", "menu/art/play_0", "menu/art/play_1", "menu/art/frame2_l",
  "menu/art/frame1_r", "menu/art/arrows_horz_0", "menu/art/arrows_horz_left", "menu/art/arrows_horz_right"];
async function fixture(names: readonly string[] = []) {
  const ui = await baseFixture(320, 240), directory = mkdtempSync(join(tmpdir(), "quake3-demos-menu-"));
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  const close = (): void => { files.close(); sound.close(); ui.close(); ui.assets.files.close(); rmSync(directory, { recursive: true, force: true }); };
  try {
    mkdirSync(join(directory, "baseq3/demos"), { recursive: true });
    writeFileSync(join(directory, "baseq3/default.cfg"), "fixture\n");
    for (const name of names) writeFileSync(join(directory, "baseq3/demos", name), "generated listing fixture\n");
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    ui.cvars.register("protocol", "68", CvarFlag.ReadOnly);
    return { ...ui, files, owner: new BaseDemosMenu(ui.state, files), close };
  } catch (error) { close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function item(f: Fixture, id: number) {
  const found = f.owner.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing Demos item ${id}`); return found;
}
function list(f: Fixture) {
  const value = item(f, 12); if (value.kind !== "scroll") throw new Error("Missing Demos source list"); return value;
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}

test("Demos uses the actual bounded filesystem list and retains the source dm3-only stripping quirk", async () => {
  const f = await fixture(["first.dm_68", "Second.dm_68", "legacy.dm3.dm_68", "other.dm_67"]); try {
    const calls: string[] = [], get = f.files.current.getFileList.bind(f.files.current);
    f.registrations.length = 0;
    f.files.current.getFileList = (path, extension, destination) => {
      calls.push(`${path}:${extension}:${destination.length}`); expect(f.registrations).toEqual(art.map(name => `shader:${name}`));
      return get(path, extension, destination);
    };
    await f.owner.show();
    expect(calls).toEqual(["demos:dm_68:2048"]);
    expect([...list(f).itemnames].sort()).toEqual(["FIRST.DM_68", "LEGACY.DM3.DM_68", "SECOND.DM_68"]);
    expect([list(f).numitems, list(f).width, list(f).height, list(f).columns, list(f).separation]).toEqual([3, 16, 14, 3, 3]);
    expect(f.owner.menu.items.map(value => [value.kind, value.common.id])).toEqual([
      ["banner", 0], ["bitmap", 0], ["bitmap", 0], ["scroll", 12], ["bitmap", 0],
      ["bitmap", 14], ["bitmap", 13], ["bitmap", 10], ["bitmap", 11],
    ]);
    expect([f.owner.menu.cursor, f.owner.menu.fullscreen, f.owner.menu.wrapAround]).toEqual([3, true, true]);
    f.cvars.set("protocol", "67.9", true); f.registrations.length = 0; await f.owner.show();
    expect(calls.at(-1)).toBe("demos:dm_67:2048"); expect(list(f).itemnames).toEqual(["OTHER.DM_67"]);
  } finally { f.close(); }
});

test("Demos real keyboard and mouse page through three columns and Play clears UI before command append", async () => {
  const f = await fixture(Array.from({ length: 60 }, (_, n) => `demo${String(n).padStart(2, "0")}.dm_68`)); try {
    await cacheMenu(f.state); await f.owner.show();
    await press(f, KeyCode.Right); expect(list(f).curvalue).toBe(14);
    await press(f, KeyCode.Down); expect(list(f).curvalue).toBe(15);
    f.state.cursorX = 340; f.state.cursorY = 420; await mouseEvent(f.state, 0, 0); await press(f, KeyCode.Mouse1);
    expect(list(f).curvalue).toBe(29);
    const selected = itemAt(list(f).itemnames, 29), events: string[] = [], append = f.consoleCommands.append.bind(f.consoleCommands);
    const clear = f.keys.clearStates.bind(f.keys);
    f.keys.clearStates = async () => { events.push("clear"); await clear(); };
    f.consoleCommands.append = text => { events.push(`append:${f.state.menuDepth}:${f.keys.getCatcher()}:${f.cvars.get("cl_paused")?.value}:${text}`); append(text); };
    f.cvars.set("cl_paused", "1", true);
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await press(f, KeyCode.Enter);
    expect(events).toEqual(["clear", `append:0:0:0:demo ${selected}\n`]);
    expect(f.consoleCommands.pendingText).toBe(`demo ${selected}\n`); expect(f.state.activeMenu).toBeNull();
  } finally { f.close(); }
});

test("Demos no-files label, hidden Play, source 128-entry cap and stable reopening", async () => {
  const empty = await fixture(); try {
    await empty.owner.show(); expect(list(empty).itemnames).toEqual(["NO DEMOS FOUND."]);
    expect(list(empty).numitems).toBe(1);
    expect(item(empty, 11).common.flags & (MenuFlag.Inactive | MenuFlag.Hidden)).toBe(MenuFlag.Inactive | MenuFlag.Hidden);
    await press(empty, KeyCode.Escape); expect(empty.state.menuDepth).toBe(0); expect(empty.consoleCommands.pendingText).toBe("");
  } finally { empty.close(); }
  const f = await fixture(Array.from({ length: 140 }, (_, n) => `n${n}.dm_68`)); try {
    await f.owner.show(); expect(list(f).numitems).toBe(128); expect(list(f).itemnames).toHaveLength(128);
    const menu = f.owner.menu, records = [...menu.items];
    await f.owner.show(); expect(f.owner.menu).toBe(menu);
    expect(menu.items.every((value, n) => value === itemAt(records, n))).toBe(true);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("Demos failed cache resets before registration and retired continuations cannot publish", async () => {
  const f = await fixture(["sample.dm_68"]); try {
    await f.owner.show(); const menu = f.owner.menu, oldList = list(f), failure = new Error("Demo art failure");
    const register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async _path => {
      expect(menu.itemCount).toBe(0); expect(menu.key).not.toBeNull(); expect(menu.fullscreen).toBe(false);
      expect(oldList.itemnames).toEqual([]); throw failure;
    };
    await expect(f.owner.show()).rejects.toBe(failure); expect(f.state.activeMenu).toBe(menu);
    f.resources.registerShaderNoMip = register; await f.owner.show(); expect(list(f)).toBe(oldList);
    const entered = deferred(), gate = deferred();
    f.resources.registerShaderNoMip = async path => { entered.resolve(); await gate.promise; return await register(path); };
    const pending = f.owner.show(); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(menu.itemCount).toBe(0);
  } finally { f.close(); }
});

test("Demos retail CPU draw includes list, frame, arrows and selected Play art", async () => {
  const f = await fixture(["sample.dm_68"]); try {
    await cacheMenu(f.state); await f.owner.show();
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await refresh(f.state, 1000);
    expect(f.commands.submit().batches).toBeGreaterThan(5);
    const textures = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
    expect(textures).toContain("menu/art/play_1"); expect(textures).toContain("menu/art/arrows_horz_0");
    expect(f.cpu.pixels.some((value, n) => n % 4 !== 3 && value !== 0)).toBe(true);
    const callback = item(f, 11).common.callback; if (callback === null) throw new Error("Missing source event");
    await callback(item(f, 11), MenuEvent.GotFocus); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});
