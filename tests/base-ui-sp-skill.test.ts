import { expect, test } from "bun:test";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { startSinglePlayerArena } from "../src/ui/base/sp-arena.ts";
import { BaseSpSkillMenu } from "../src/ui/base/sp-skill.ts";
import { COLORS, itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuBitmap, MenuProportional } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

async function fixture() {
  const ui = await baseFixture(320, 240), root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    const game = new BaseUiGameInfo(ui.state, files); game.initialize();
    const skill = new BaseSpSkillMenu(ui.state, game);
    return { ...ui, game, skill, close: () => { try { files.close(); } finally { sound.close(); ui.close(); ui.assets.files.close(); } } };
  } catch (error) { files.close(); sound.close(); ui.close(); ui.assets.files.close(); throw error; }
}
function arena(info: string | null): string { if (info === null) throw new Error("Missing actual retail arena"); return info; }
function item(skill: BaseSpSkillMenu, id: number): BaseMenuItem {
  const found = skill.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing skill item ${id}`); return found;
}
function text(skill: BaseSpSkillMenu, id: number): MenuProportional {
  const value = item(skill, id); if (value.kind !== "proportional") throw new Error("Expected source skill text"); return value;
}
function picture(skill: BaseSpSkillMenu): MenuBitmap {
  const value = itemAt(skill.menu.items, 7); if (value.kind !== "bitmap") throw new Error("Expected source skill picture"); return value;
}
async function activate(skill: BaseSpSkillMenu, id: number, event = MenuEvent.Activated): Promise<void> {
  const target = item(skill, id), callback = target.common.callback;
  if (callback === null) throw new Error("Missing skill source callback"); await callback(target, event);
}
const cacheOrder = ["menu/art/cut_frame", "menu/art/back_0.tga", "menu/art/back_1.tga", "menu/art/fight_0", "menu/art/fight_1",
  "menu/art/level_complete1", "menu/art/level_complete2", "menu/art/level_complete3", "menu/art/level_complete4", "menu/art/level_complete5"]
  .map(name => `shader:${name}`).concat(["sound:sound/misc/nightmare.wav:false", "sound:sound/misc/silence.wav:false"]);

test("SP skill source cache, ten records, placement, flags, selected picture and Fight cursor", async () => {
  const f = await fixture(); try {
    f.registrations.length = 0; const menu = f.skill.menu;
    await f.skill.show(arena(f.game.getArenaInfoByMap("q3dm1")));
    expect(f.registrations).toEqual(cacheOrder); expect(f.skill.menu).toBe(menu);
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["bitmap",0,142,118,0x4004], ["banner",0,320,16,0x4008],
      ["proportional",10,320,170,0x108], ["proportional",11,320,198,0x108], ["proportional",12,320,227,0x108],
      ["proportional",13,320,255,0x108], ["proportional",14,320,283,0x108], ["bitmap",0,256,368,0x4004],
      ["bitmap",15,0,416,0x104], ["bitmap",16,640,416,0x110],
    ]);
    expect(menu.items.map(value => value.common.menuPosition)).toEqual([0,1,2,3,4,5,6,7,8,9]);
    expect(menu.items.every(value => value.common.parent === menu)).toBe(true);
    expect(menu.items.filter(value => value.kind === "bitmap").map(value => [value.width,value.height,value.focuspic])).toEqual([
      [359,256,null], [128,96,null], [128,64,"menu/art/back_1.tga"], [128,64,"menu/art/fight_1"],
    ]);
    expect(menu.items.flatMap(value => value.kind === "banner" || value.kind === "proportional" ? [[value.text,value.style,value.color]] : [])).toEqual([
      ["DIFFICULTY",1,COLORS.white], ["I Can Win",1,COLORS.red], ["Bring It On",1,COLORS.white],
      ["Hurt Me Plenty",1,COLORS.red], ["Hardcore",1,COLORS.red], ["NIGHTMARE!",1,COLORS.red],
    ]);
    expect(picture(f.skill).shader).toBe(await f.resources.registerShaderNoMip("menu/art/level_complete2"));
    expect([menu.cursor,menu.cursorPrev,menu.itemCount,menu.fullscreen,menu.wrapAround,menu.showlogo]).toEqual([9,2,10,true,false,false]);
    expect(f.events).toEqual([]); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.activeMenu).toBe(menu);
  } finally { f.close(); }
});

test("SP init clamps float before QVM conversion without writing g_spSkill, including source NaN failure", async () => {
  const f = await fixture(); try {
    const cases: readonly (readonly [string, number])[] = [["-inf",1],["-2",1],["0.9",1],["1.999",1],["2.9",2],["4.999",4],["4.99999999",5],["5.9",5],["inf",5]];
    for (const [value, selected] of cases) {
      f.cvars.set("g_spSkill",value,true); f.events.length = 0; await f.skill.show("\\map\\q3dm1");
      expect(text(f.skill,selected+9).color).toBe(COLORS.white); expect(f.cvars.get("g_spSkill")?.value).toBe(value);
      expect(picture(f.skill).shader).toBe(await f.resources.registerShaderNoMip(`menu/art/level_complete${selected}`));
      expect(f.events).toEqual(selected === 5 ? ["sound:sound/misc/nightmare.wav:7"] : []);
    }
    f.cvars.set("g_spSkill","nan",true);
    await expect(f.skill.show("\\map\\q3dm2")).rejects.toThrow("array index -2147483649");
    expect(f.skill.menu.itemCount).toBe(10); expect(picture(f.skill).shader).toBeNull();
    expect(f.skill.menu.cursor).toBe(0); expect(f.cvars.get("g_spSkill")?.value).toBe("nan");
    await activate(f.skill,16);
    expect(f.cvars.get("sv_maxclients")?.value).toBe("8"); expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
    expect(f.consoleCommands.pendingText).toBe("spmap \n");
  } finally { f.close(); }
});

test("SP Fight after nightmare playback failure starts the reset null arena through actual keyboard input", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.skill.show("\\num\\7\\map\\old");
    const menu = f.skill.menu, items = [...menu.items];
    f.cvars.set("g_spSkill","5",true); f.cvars.set("sv_maxclients","4",true); f.cvars.set("ui_spSelection","7",true);
    const play = f.mixer.startLocalSound.bind(f.mixer), failure = new Error("nightmare playback failed");
    let failed = false;
    f.mixer.startLocalSound = (sound,channel) => {
      if (!failed && channel === 7) {
        failed = true; expect(menu.itemCount).toBe(10); throw failure;
      }
      return play(sound,channel);
    };
    await expect(f.skill.show("\\num\\9\\map\\new")).rejects.toBe(failure);
    f.mixer.startLocalSound = play;
    expect(failed).toBe(true); expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(1);
    expect(menu.cursor).toBe(0); expect(menu.itemCount).toBe(10);
    for (const [index,value] of menu.items.entries()) expect(value).toBe(itemAt(items,index));
    expect(f.cvars.get("sv_maxclients")?.value).toBe("4"); expect(f.cvars.get("ui_spSelection")?.value).toBe("7");
    expect(f.consoleCommands.pendingText).toBe("");
    for (let step = 0; step < 7; step++) {
      await f.keys.keyEvent(KeyCode.Down,true,step*2+1); await f.keys.keyEvent(KeyCode.Down,false,step*2+2);
    }
    expect(menu.cursor).toBe(9);
    await f.keys.keyEvent(KeyCode.Enter,true,15); await f.keys.keyEvent(KeyCode.Enter,false,16);
    expect(f.cvars.get("sv_maxclients")?.value).toBe("8"); expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
    expect(f.consoleCommands.pendingText).toBe("spmap \n"); expect(f.state.activeMenu).toBe(menu);
  } finally { f.close(); }
});

test("SP skill events force latched cvars, use unclamped old value, and publish before invalid index rejection", async () => {
  const f = await fixture(); try {
    await f.skill.show("\\map\\q3dm1"); f.cvars.set("g_spSkill","5");
    expect(f.cvars.get("g_spSkill")?.latchedValue).toBe("5");
    for (let id = 10; id <= 14; id++) {
      const before = f.cvars.get("g_spSkill");
      for (const event of [MenuEvent.GotFocus,MenuEvent.LostFocus]) await activate(f.skill,id,event);
      expect(f.cvars.get("g_spSkill")).toEqual(before);
      f.events.length = 0; await activate(f.skill,id);
      const current = f.cvars.get("g_spSkill");
      expect(current?.value).toBe(String(id-9)); expect(current?.flags).toBe(CvarFlag.Archive | CvarFlag.Latch);
      expect(current?.resetValue).toBe("2"); expect(current?.latchedValue).toBeUndefined();
      expect(text(f.skill,id).color).toBe(COLORS.white);
      expect(f.events).toEqual([id === 14 ? "sound:sound/misc/nightmare.wav:7" : "sound:sound/misc/silence.wav:7"]);
    }
    f.cvars.set("g_spSkill","8.2",true); await activate(f.skill,10);
    expect(text(f.skill,14).color).toBe(COLORS.white); expect(text(f.skill,10).color).toBe(COLORS.white);
    f.cvars.set("g_spSkill","1.9",true); await activate(f.skill,11); expect(text(f.skill,10).color).toBe(COLORS.red);
    const target = item(f.skill,10), before = picture(f.skill).shader;
    target.common.id = 9; f.events.length = 0;
    if (target.common.callback === null) throw new Error("Missing skill callback");
    await expect(target.common.callback(target,MenuEvent.Activated)).rejects.toThrow("array index -1");
    expect(f.cvars.get("g_spSkill")?.value).toBe("0"); expect(picture(f.skill).shader).toBe(before); expect(f.events).toEqual([]);
  } finally { f.close(); }
});

test("SP actual keyboard and mouse select skills and Fight appends the current arena command", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.skill.show(arena(f.game.getArenaInfoByMap("q3dm1")));
    await f.keys.keyEvent(KeyCode.Up,true,1); await f.keys.keyEvent(KeyCode.Up,false,2); expect(f.skill.menu.cursor).toBe(8);
    await f.keys.keyEvent(KeyCode.Up,true,3); await f.keys.keyEvent(KeyCode.Up,false,4); expect(f.skill.menu.cursor).toBe(6);
    await f.keys.keyEvent(KeyCode.Enter,true,5); await f.keys.keyEvent(KeyCode.Enter,false,6);
    expect(f.cvars.get("g_spSkill")?.value).toBe("5"); expect(f.events).toContain("sound:sound/misc/nightmare.wav:7");
    await mouseEvent(f.state,320-f.state.cursorX,205-f.state.cursorY); expect(f.skill.menu.cursor).toBe(3);
    await f.keys.keyEvent(KeyCode.Mouse1,true,7); await f.keys.keyEvent(KeyCode.Mouse1,false,8);
    expect(f.cvars.get("g_spSkill")?.value).toBe("2");
    await f.skill.show(arena(f.game.getSpecialArenaInfo("training")));
    await f.keys.keyEvent(KeyCode.Enter,true,9); await f.keys.keyEvent(KeyCode.Enter,false,10);
    expect(f.consoleCommands.pendingText).toBe("spmap q3dm0\n"); expect(f.cvars.get("ui_spSelection")?.value).toBe("-4");
    expect(f.state.activeMenu).toBe(f.skill.menu); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("SP arena start retains source command bytes, special tiers, atoi wrapping and forced cvar metadata", async () => {
  const f = await fixture(); try {
    f.cvars.register("sv_maxclients","4",CvarFlag.Latch | CvarFlag.ServerInfo); f.cvars.set("sv_maxclients","12");
    f.consoleCommands.append("echo before\n");
    startSinglePlayerArena(f.state,f.game,arena(f.game.getArenaInfoByMap("q3dm1")));
    expect(f.cvars.get("sv_maxclients")?.value).toBe("8"); expect(f.cvars.get("sv_maxclients")?.latchedValue).toBeUndefined();
    expect(f.cvars.get("sv_maxclients")?.resetValue).toBe("4"); expect(f.cvars.get("sv_maxclients")?.flags).toBe(CvarFlag.Latch | CvarFlag.ServerInfo);
    expect(f.cvars.get("ui_spSelection")?.flags).toBe(CvarFlag.ReadOnly); expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
    startSinglePlayerArena(f.state,f.game,"\\num\\19\\special\\TrAiNiNg\\map\\q3dm0"); expect(f.cvars.get("ui_spSelection")?.value).toBe("-4");
    startSinglePlayerArena(f.state,f.game,"\\num\\19\\special\\FiNaL\\map\\q3tourney6"); expect(f.cvars.get("ui_spSelection")?.value).toBe("24");
    startSinglePlayerArena(f.state,f.game,"\\num\\4294967297rest\\special\\other\\map\\a;b\nnext"); expect(f.cvars.get("ui_spSelection")?.value).toBe("1");
    startSinglePlayerArena(f.state,f.game,"\\num\\-2"); expect(f.cvars.get("ui_spSelection")?.value).toBe("-2");
    expect(f.consoleCommands.pendingText).toBe("echo before\nspmap q3dm1\nspmap q3dm0\nspmap q3tourney6\nspmap a;b\nnext\nspmap \n");
    for (const value of ["8.9","7.99999999","100"]) {
      f.cvars.set("sv_maxclients",value,true); const before = f.cvars.get("sv_maxclients");
      startSinglePlayerArena(f.state,f.game,"\\map\\q3dm1"); expect(f.cvars.get("sv_maxclients")).toEqual(before);
    }
    for (const value of ["7.9","nan","inf","2147483648"]) {
      f.cvars.set("sv_maxclients",value,true); startSinglePlayerArena(f.state,f.game,""); expect(f.cvars.get("sv_maxclients")?.value).toBe("8");
    }
    startSinglePlayerArena(f.state,f.game,"\\num\\16777217"); expect(f.cvars.get("ui_spSelection")?.value).toBe("16777216");
    const commands = f.consoleCommands.pendingText;
    f.cvars.set("sv_maxclients","4",true);
    expect(() => startSinglePlayerArena(f.state,f.game,"\\num\\2147483647")).toThrow("Undefined native base UI integer conversion");
    expect(f.cvars.get("sv_maxclients")?.value).toBe("8"); expect(f.cvars.get("ui_spSelection")?.value).toBe("16777216");
    expect(f.consoleCommands.pendingText).toBe(commands);
  } finally { f.close(); }
});

for (const key of [KeyCode.Escape,KeyCode.Mouse2,KeyCode.Enter]) {
  test(`SP exit ${key} silences announcer before real pop and returns to parent`, async () => {
    const f = await fixture(); try {
      await cacheMenu(f.state); const parent = new BaseConfirmMenu(f.state); await parent.show("Parent",null,null);
      await f.skill.show("\\map\\q3dm1"); await activate(f.skill,14);
      if (key === KeyCode.Enter) await setCursorToItem(f.state,f.skill.menu,item(f.skill,15));
      f.events.length = 0; await f.keys.keyEvent(key,true,1); await f.keys.keyEvent(key,false,2);
      expect(f.events.slice(0,2)).toEqual(["sound:sound/misc/silence.wav:7","sound:sound/misc/menu3.wav:6"]);
      expect(f.state.activeMenu).toBe(parent.menu); expect(f.state.menuDepth).toBe(1); expect(f.consoleCommands.pendingText).toBe("");
    } finally { f.close(); }
  });
}

test("SP missing sound uses real zero handle playback on announcer channel", async () => {
  const f = await fixture(); try {
    const read = f.assets.readFileRetained.bind(f.assets);
    f.assets.readFileRetained = async path => path === "sound/misc/silence.wav" ? undefined : await read(path);
    await f.skill.show("\\map\\q3dm1"); await activate(f.skill,10);
    expect(f.events).toEqual(["sound:sound/feedback/hit.wav:7"]);
    expect(f.mixer.mix(4096).some(value => value !== 0)).toBe(true);
  } finally { f.close(); }
});

test("SP reset keeps record identities and source partial cache writes, then retries", async () => {
  const f = await fixture(); try {
    await f.skill.show("\\map\\old"); const menu = f.skill.menu, items = [...menu.items], commons = items.map(value => value.common);
    const baby = item(f.skill,10), saved = baby.common.callback;
    if (saved === null) throw new Error("Missing retained source callback");
    const oldPicture = picture(f.skill), register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("third skill picture failed");
    f.registrations.length = 0;
    f.resources.registerShaderNoMip = async name => {
      expect(menu.itemCount).toBe(0); expect(menu.fullscreen).toBe(true); expect(menu.key).not.toBeNull();
      expect(items.every(value => value.common.parent === null && value.common.name === null)).toBe(true);
      const result = await register(name); if (name === "menu/art/level_complete3") throw failure; return result;
    };
    await expect(f.skill.show("\\map\\new")).rejects.toBe(failure);
    expect(f.registrations).toEqual(cacheOrder.slice(0,8)); expect(f.state.activeMenu).toBe(menu); expect(menu.items).toEqual([]);
    baby.common.id = 10; await saved(baby,MenuEvent.Activated);
    expect(oldPicture.shader).toBe(await register("menu/art/level_complete1")); expect(f.events).toContain("sound:sound/feedback/hit.wav:7");
    baby.common.id = 12; await saved(baby,MenuEvent.Activated); expect(oldPicture.shader).toBeNull();
    f.resources.registerShaderNoMip = register; f.registrations.length = 0; await f.skill.show("\\map\\new");
    expect(f.registrations).toEqual(cacheOrder); expect(f.skill.menu).toBe(menu);
    for (const [index,value] of menu.items.entries()) { expect(value).toBe(itemAt(items,index)); expect(value.common).toBe(itemAt(commons,index)); }
    await activate(f.skill,16); expect(f.consoleCommands.pendingText).toBe("spmap new\n");
    const before = [...menu.items]; await f.skill.cache(); expect(menu.items).toEqual(before); expect(menu.cursor).toBe(9);
  } finally { f.close(); }
});

test("SP sound cache rejection keeps completed nightmare sound and zero silence", async () => {
  const f = await fixture(); try {
    await f.skill.show("\\map\\old"); const nightmare = item(f.skill,14), saved = nightmare.common.callback;
    if (saved === null) throw new Error("Missing retained skill callback");
    const register = f.soundBank.registerSound.bind(f.soundBank), failure = new Error("silence load failed");
    f.soundBank.registerSound = async (name,compressed) => { const result = await register(name,compressed); if (name === "sound/misc/silence.wav") throw failure; return result; };
    await expect(f.skill.show("\\map\\new")).rejects.toBe(failure);
    nightmare.common.id = 14; f.events.length = 0; await saved(nightmare,MenuEvent.Activated);
    expect(f.events).toEqual(["sound:sound/misc/nightmare.wav:7"]);
    nightmare.common.id = 10; await saved(nightmare,MenuEvent.Activated); expect(f.events[1]).toBe("sound:sound/feedback/hit.wav:7");
    expect(f.skill.menu.itemCount).toBe(0); f.soundBank.registerSound = register;
    await f.skill.show("\\map\\new"); expect(f.skill.menu.itemCount).toBe(10);
  } finally { f.close(); }
});

test("SP awaited media cannot publish after retirement or escaped command execution", async () => {
  const f = await fixture(); try {
    const entered = deferred(), gate = deferred(), register = f.soundBank.registerSound.bind(f.soundBank);
    f.soundBank.registerSound = async (name,compressed) => { const result = await register(name,compressed); entered.resolve(); await gate.promise; return result; };
    const pending = f.skill.show("\\map\\q3dm1"); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(f.skill.menu.itemCount).toBe(0); expect(f.state.menuDepth).toBe(0);
    expect(f.registrations).not.toContain("sound:sound/misc/silence.wav:false");
  } finally { f.close(); }
  const f2 = await fixture(); try {
    const escaped: { promise: Promise<void> | null } = { promise: null };
    f2.consoleCommands.register("escape-skill",() => { escaped.promise = f2.skill.show("\\map\\q3dm1"); });
    f2.consoleCommands.executeNow("escape-skill"); if (escaped.promise === null) throw new Error("Missing escaped show");
    await expect(escaped.promise).rejects.toThrow("closed"); expect(f2.skill.menu.itemCount).toBe(0); expect(f2.state.menuDepth).toBe(0);
  } finally { f2.close(); }
});

test("SP real retail CPU render changes with selected skill picture and draws focused Fight", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.skill.show(arena(f.game.getArenaInfoByMap("q3dm1")));
    await refresh(f.state,75); f.commands.submit();
    expect(f.recorder.trace().flatMap(view => view.batches).length).toBeGreaterThan(5);
    expect(f.cpu.pixels.some((value,index) => index % 4 !== 3 && value !== 0)).toBe(true);
    const fight = item(f.skill,16); if (fight.kind !== "bitmap") throw new Error("Expected Fight bitmap");
    expect(fight.shader).not.toBeNull(); expect(fight.focusshader).not.toBeNull();
    expect(f.events).toContain("sound:sound/misc/menu1.wav:6");
    const before = f.cpu.pixels.slice(); await activate(f.skill,14); await refresh(f.state,150); f.commands.submit();
    expect(f.cpu.pixels).not.toEqual(before); expect(picture(f.skill).shader).toBe(await f.resources.registerShaderNoMip("menu/art/level_complete5"));
    expect((fight.common.flags & MenuFlag.PulseIfFocus) !== 0).toBe(true);
  } finally { f.close(); }
});
