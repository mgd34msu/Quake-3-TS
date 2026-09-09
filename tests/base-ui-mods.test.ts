import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseModsMenu } from "../src/ui/base/mods.ts";
import { itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import { baseFixture } from "./base-ui-fixture.ts";

const art = ["menu/art/back_0", "menu/art/back_1", "menu/art/load_0", "menu/art/load_1", "menu/art/frame2_l", "menu/art/frame1_r"];
async function fixture(mods: readonly (readonly [string, string | null])[] = []) {
  const ui = await baseFixture(320, 240), root = mkdtempSync(join(tmpdir(), "quake3-mods-menu-"));
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  const close = (): void => { files.close(); sound.close(); ui.close(); ui.assets.files.close(); rmSync(root, { recursive: true, force: true }); };
  try {
    mkdirSync(join(root, "baseq3"));
    writeFileSync(join(root, "baseq3/default.cfg"), "fixture\n");
    for (const [name, description] of mods) {
      mkdirSync(join(root, name));
      // FS_GetModList checks extension presence, without decoding these unmounted packs.
      writeFileSync(join(root, name, "fixture.pk3"), "generated mod presence fixture");
      if (description !== null) writeFileSync(join(root, name, "description.txt"), description);
    }
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    ui.cvars.register("fs_game", "old", CvarFlag.Init | CvarFlag.SystemInfo);
    return { ...ui, files, root, owner: new BaseModsMenu(ui.state, files), close };
  } catch (error) { close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function item(f: Fixture, id: number) {
  const found = f.owner.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing Mods item ${id}`);
  return found;
}
function list(f: Fixture) {
  const value = item(f, 12);
  if (value.kind !== "scroll") throw new Error("Missing Mods list");
  return value;
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}

test("Mods consumes actual directory/description pairs, keeps base first and uses source record geometry", async () => {
  const f = await fixture([["missionpack", "Team Arena\n"], ["LongDirectoryNameBeyond15", "D".repeat(60)], ["bare", null], [".hidden", "hidden"]]);
  try {
    f.registrations.length = 0;
    await f.owner.show();
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`));
    expect(list(f).itemnames[0]).toBe("Quake III Arena");
    expect([...list(f).itemnames].slice(1).sort()).toEqual(["D".repeat(47), "Team Arena\n", "bare"]);
    expect([list(f).numitems, list(f).width, list(f).height, list(f).columns, list(f).separation]).toEqual([4, 48, 14, 1, 0]);
    expect(list(f).common.flags).toBe(MenuFlag.PulseIfFocus | MenuFlag.CenterJustify);
    expect(f.owner.menu.items.map(value => [value.kind, value.common.id])).toEqual([
      ["banner", 0], ["bitmap", 0], ["bitmap", 0], ["scroll", 12], ["bitmap", 10], ["bitmap", 11],
    ]);
    expect([f.owner.menu.cursor, f.owner.menu.fullscreen, f.owner.menu.wrapAround, f.owner.menu.key]).toEqual([3, true, true, null]);
    expect(f.prints.at(-1)).toBe("4 mods parsed\n");
    list(f).curvalue = list(f).itemnames.indexOf("D".repeat(47));
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await press(f, KeyCode.Enter);
    expect(f.cvars.get("fs_game")?.value).toBe("LongDirectoryNa");
    expect(f.consoleCommands.pendingText).toBe("vid_restart;");
  } finally { f.close(); }
});

test("Mods real keys update the selection, then set fs_game and append before popping to the parent", async () => {
  const f = await fixture([["missionpack", "Team Arena"]]); try {
    const parent = new BaseConfirmMenu(f.state); await parent.show("Parent", null, null);
    await f.owner.show(); await press(f, KeyCode.Down); expect(list(f).curvalue).toBe(1);
    const append = f.consoleCommands.append.bind(f.consoleCommands), trace: string[] = [];
    f.consoleCommands.append = text => {
      trace.push(`${f.state.menuDepth}:${f.state.activeMenu === f.owner.menu}:${f.cvars.get("fs_game")?.value}:${text}`); append(text);
    };
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await press(f, KeyCode.Enter);
    expect(trace).toEqual(["2:true:missionpack:vid_restart;"]);
    expect(f.state.menuDepth).toBe(1); expect(f.state.activeMenu).toBe(parent.menu);
    await f.owner.show(); await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await press(f, KeyCode.Enter);
    expect(f.cvars.get("fs_game")?.value).toBe("");
    expect(f.consoleCommands.pendingText).toBe("vid_restart;vid_restart;");
    await f.owner.show(); const pending = f.consoleCommands.pendingText;
    await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(parent.menu); expect(f.consoleCommands.pendingText).toBe(pending);
  } finally { f.close(); }
});

test("Mods cache failure keeps old records and completed cache resets before filesystem failure", async () => {
  const f = await fixture([["missionpack", "Team Arena"]]); try {
    await f.owner.show(); const menu = f.owner.menu, records = [...menu.items], oldList = list(f);
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("Mods art failed");
    f.resources.registerShaderNoMip = async _name => { throw failure; };
    await expect(f.owner.show()).rejects.toBe(failure);
    expect(menu.itemCount).toBe(6); expect(oldList.itemnames).toEqual(["Quake III Arena", "Team Arena"]);
    f.resources.registerShaderNoMip = register; await f.owner.show();
    expect(menu.items.every((value, n) => value === itemAt(records, n))).toBe(true);
    f.files.close(); await expect(f.owner.show()).rejects.toThrow("no active mounts");
    expect(menu.itemCount).toBe(0); expect(oldList.numitems).toBe(1); expect(oldList.itemnames).toEqual(["Quake III Arena"]);
    expect(menu.fullscreen).toBe(true); expect(oldList.common.parent).toBeNull();
  } finally { f.close(); }
});

test("Mods preserves the reached source array limit instead of moving the late MAX_MODS clamp", async () => {
  const f = await fixture(Array.from({ length: 63 }, (_, n) => [`m${n}`, `Mod ${n}`])); try {
    await f.owner.show(); const oldList = list(f);
    expect(oldList.numitems).toBe(64); expect(oldList.itemnames).toHaveLength(64);
    mkdirSync(join(f.root, "extra")); writeFileSync(join(f.root, "extra/fixture.pk3"), "presence");
    f.prints.length = 0;
    await expect(f.owner.show()).rejects.toThrow("array index 64");
    expect(oldList.numitems).toBe(64); expect(f.owner.menu.itemCount).toBe(0);
    expect(f.prints.some(text => text.includes("mods parsed"))).toBe(false);
  } finally { f.close(); }
});

test("Mods draws retail art/list and ignores nonactivated callbacks; unused source game pointers force-reset", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.owner.show();
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await refresh(f.state, 1000);
    expect(f.commands.submit().batches).toBeGreaterThan(5);
    const textures = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
    expect(textures).toContain("menu/art/load_1"); expect(textures).toContain("menu/art/frame2_l");
    expect(f.cpu.pixels.some((value, n) => n % 4 !== 3 && value !== 0)).toBe(true);
    const go = item(f, 11), callback = go.common.callback;
    if (callback === null) throw new Error("Missing Mods event");
    await callback(go, MenuEvent.GotFocus); expect(f.consoleCommands.pendingText).toBe("");
    f.cvars.set("fs_game", "changed", true); list(f).curvalue = 63;
    await callback(go, MenuEvent.Activated);
    expect(f.cvars.get("fs_game")?.value).toBe("old"); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
});
