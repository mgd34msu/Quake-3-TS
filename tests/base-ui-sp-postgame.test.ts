import { expect, test } from "bun:test";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { GamestateEntry, ServerMessageContext } from "../src/protocol/server-message.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu, stringWidth } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { MEDAL_PICTURES, MEDAL_SOUNDS } from "../src/ui/base/medals.ts";
import { BaseSpPostgameMenu } from "../src/ui/base/sp-postgame.ts";
import { itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const players: readonly (readonly [number, string])[] = Array.from({ length: 10 }, (_, n) =>
  [544 + n, `\\n\\${n === 0 ? "^1Sarge" : `Bot${n}`}\\skill\\3`]);
const art = ["menu/art/menu_0", "menu/art/menu_1", "menu/art/replay_0", "menu/art/replay_1", "menu/art/next_0", "menu/art/next_1"];
const cacheOrder = art.map(name => `shader:${name}`).concat(MEDAL_PICTURES.flatMap((name, n) =>
  [`shader:${name}`, `sound:${itemAt(MEDAL_SOUNDS, n)}:false`]));
async function fixture() {
  const ui = await baseFixture(320, 240), root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
  let sequence = 0;
  async function load(map = "q3dm1", serverId = "100", roster = players): Promise<void> {
    sequence++;
    const entries: GamestateEntry[] = [{ kind: "configstring", index: 0, value: `\\mapname\\${map}` },
      { kind: "configstring", index: 1, value: `\\sv_serverid\\${serverId}\\sv_cheats\\1\\fs_game\\` },
      ...roster.map(([index, value]) => ({ kind: "configstring", index, value } satisfies GamestateEntry))];
    const context: ServerMessageContext = { product: "baseq3", messageNumber: sequence, reliableSequence: 0,
      serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    await session.receiveServerMessage(sequence, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0,
      clientNumber: 0, checksumFeed: 19, entries }], context));
  }
  const close = (): void => { lifecycle.close(); files.close(); sound.close(); ui.close(); ui.assets.files.close(); };
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    const game = new BaseUiGameInfo(ui.state, files); game.initialize();
    const owner = new BaseSpPostgameMenu(ui.state, game, session);
    ui.consoleCommands.registerAsync("postgame", context => owner.showFromCommand(context));
    await load();
    return { ...ui, game, owner, session, load, close };
  } catch (error) { close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function item(f: Fixture, id: number) {
  const found = f.owner.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing postgame item ${id}`);
  return found;
}
async function show(f: Fixture, awards: readonly [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0],
  clients: readonly (readonly [number, number, number])[] = [[0, 0, 20], [1, 1, 15], [2, 2, 10]], player = 0, count = clients.length): Promise<void> {
  await f.consoleCommands.executeNowAsync(`postgame ${count} ${player} ${awards.join(" ")} ${clients.flat().join(" ")}`);
}
async function press(f: Fixture, key: number, time: number): Promise<void> {
  f.state.realtime = time;
  await f.keys.keyEvent(key, true, time); await f.keys.keyEvent(key, false, time + 1);
}
async function draw(f: Fixture, time: number): Promise<void> {
  f.state.realtime = time;
  const callback = f.owner.menu.draw;
  if (callback === null) throw new Error("Missing source postgame draw");
  await callback();
}
async function skip(f: Fixture): Promise<void> { await press(f, KeyCode.Space, 1500); await press(f, KeyCode.Space, 1750); }
async function activate(f: Fixture, id: number, event = MenuEvent.Activated): Promise<void> {
  const value = item(f, id), callback = value.common.callback;
  if (callback === null) throw new Error("Missing source postgame callback");
  await callback(value, event);
}
function score(f: Fixture, level: number): number { const result = { score: 0, skill: 0 }; f.game.getBestScore(level, result); return result.score; }
function observeFixedText(f: Fixture) {
  const glyphs: { x: number; y: number; code: number; width: number }[] = [], stretch = f.state.draw.stretchPixels.bind(f.state.draw);
  const charset = f.resources.picture(f.state.media.charset);
  f.state.draw.stretchPixels = (rect, uv, picture) => {
    if (picture === charset) glyphs.push({ x: rect.x * 2, y: rect.y * 2, code: uv.t * 256 + uv.s * 16, width: rect.width * 2 });
    stretch(rect, uv, picture);
  };
  return { glyphs, clear: () => { glyphs.length = 0; }, row: (y: number, x = 440): string => {
    const row = glyphs.filter(glyph => glyph.y === y && glyph.x >= x), first = row[0], last = row.at(-1);
    if (first === undefined || last === undefined) return "";
    const chars = new Array<string>(Math.trunc((last.x - x) / first.width) + 1).fill(" ");
    for (const glyph of row) chars[Math.trunc((glyph.x - x) / glyph.width)] = String.fromCharCode(glyph.code);
    return chars.join("");
  } };
}

test("Postgame command captures retail arena and scoreboard, caches in source order and keeps inactive cursor zero", async () => {
  const f = await fixture(); try {
    const parent = new BaseConfirmMenu(f.state); await parent.show("Parent", null, null);
    const menu = f.owner.menu; f.registrations.length = 0;
    await show(f, [50, 2, 1, 3, 120, 1]);
    expect(f.registrations).toEqual([...cacheOrder, "sound:sound/player/announce/youwin.wav:false"]);
    expect(f.owner.menu).toBe(menu); expect(f.state.menuDepth).toBe(1); expect(f.state.activeMenu).toBe(menu);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.stack[0]).toBe(menu);
    expect([menu.cursor, menu.cursorPrev, menu.fullscreen, menu.wrapAround, menu.showlogo]).toEqual([0, 0, false, true, false]);
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["bitmap", 12, 0, 416, 0x4104], ["bitmap", 10, 320, 416, 0x4108], ["bitmap", 11, 640, 416, 0x4110],
    ]);
    expect(menu.items.every((value, n) => value.common.parent === menu && value.common.menuPosition === n)).toBe(true);
    expect(menu.items.flatMap(value => value.kind === "bitmap" ? [[value.width, value.height, value.focuspic]] : [])).toEqual([
      [128, 64, "menu/art/menu_1"], [128, 64, "menu/art/replay_1"], [128, 64, "menu/art/next_1"],
    ]);
    expect(score(f, 0)).toBe(1); expect(Array.from({ length: 6 }, (_, n) => f.game.getAwardLevel(n))).toEqual([1, 2, 1, 3, 120, 1]);
    expect(f.consoleCommands.pendingText).toBe("music music/win\n");
  } finally { f.close(); }
});

test("Postgame cache snapshots QVM buildscript integer before registrations and does not initialize records", async () => {
  const f = await fixture(); try {
    for (const [value, extra] of [["0.9", false], ["-0.9", false], ["1", true], ["-1.1", true], ["nan", true], ["inf", true]] satisfies [string, boolean][]) {
      f.cvars.set("com_buildscript", value, true); f.registrations.length = 0; await f.owner.cache();
      expect(f.registrations).toEqual(extra ? [...cacheOrder, "sound:music/loss.wav:false", "sound:music/win.wav:false", "sound:sound/player/announce/youwin.wav:false"] : cacheOrder);
      expect(f.owner.menu.itemCount).toBe(0); expect(f.owner.menu.key).toBeNull();
    }
    f.cvars.set("com_buildscript", "1", true);
    const register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => { f.cvars.set("com_buildscript", "0", true); return await register(name); };
    f.registrations.length = 0; await f.owner.cache(); expect(f.registrations.at(-1)).toBe("sound:sound/player/announce/youwin.wav:false");
  } finally { f.close(); }
});

test("Postgame podium winner timing and all six award presentations run actual announcer sound and CPU drawing", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await show(f, [75, 2, 1, 3, 120, 4]); const text = observeFixedText(f);
    await draw(f, 999); expect(f.events).toEqual([]);
    await draw(f, 1000); await draw(f, 4999); expect(f.events).toEqual(["sound:sound/player/announce/youwin.wav:7"]);
    for (let n = 0; n < 6; n++) {
      f.registrations.length = 0; text.clear(); await draw(f, 5000 + n * 2000);
      expect(f.registrations).toEqual([...MEDAL_PICTURES.slice(0, n + 1).map(name => `shader:${name}`), `sound:${itemAt(MEDAL_SOUNDS, n)}:false`]);
      expect(f.events.at(-1)).toBe(`sound:${itemAt(MEDAL_SOUNDS, n)}:7`);
      const eventCount = f.events.length; await draw(f, 5999 + n * 2000); expect(f.events.length).toBe(eventCount);
      expect((item(f, 10).common.flags & MenuFlag.Inactive) !== 0).toBe(true);
    }
    await draw(f, 17000); expect(f.owner.menu.items.every(value => (value.common.flags & MenuFlag.Inactive) === 0)).toBe(true);
    expect(f.commands.submit().batches).toBeGreaterThan(10);
    const textures = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
    expect(textures).toContain("menu/medals/medal_accuracy.tga"); expect(textures).toContain("menu/art/replay_0.tga");
    expect(f.cpu.pixels.some((value, n) => n % 4 !== 3 && value !== 0)).toBe(true);
    expect(f.mixer.mix(4096).some(value => value !== 0)).toBe(true);
  } finally { f.close(); }
});

test("Postgame key gates honor 1500 and 250 boundaries, suppress Escape and activate real replay only after draw", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await show(f, [0, 0, 0, 0, 0, 0], [[0, 1, 9], [1, 0, 15]], 0);
    await press(f, KeyCode.Escape, 1499); expect(f.consoleCommands.pendingText).toBe("music music/loss\n");
    await press(f, KeyCode.Escape, 1500); expect(f.consoleCommands.pendingText).toBe("music music/loss\nabort_podium\n");
    await press(f, KeyCode.Enter, 1749); expect(f.owner.menu.items.every(value => (value.common.flags & MenuFlag.Inactive) !== 0)).toBe(true);
    await press(f, KeyCode.Mouse2, 1750); await draw(f, 1750);
    expect(f.owner.menu.items.every(value => (value.common.flags & MenuFlag.Inactive) === 0)).toBe(true);
    await press(f, KeyCode.Down, 1999); expect(f.owner.menu.cursor).toBe(0);
    await press(f, KeyCode.Escape, 2000); await press(f, KeyCode.Mouse2, 2000); expect(f.state.menuDepth).toBe(1);
    await press(f, KeyCode.Down, 2000); expect(f.owner.menu.cursor).toBe(1);
    const append = f.consoleCommands.append.bind(f.consoleCommands), trace: string[] = [];
    f.consoleCommands.append = value => { trace.push(`${f.state.menuDepth}:${f.keys.getCatcher()}:${value}`); append(value); };
    await press(f, KeyCode.Enter, 2001);
    expect(trace).toEqual(["0:0:map_restart 0\n"]); expect(f.state.activeMenu).toBeNull();
    expect(f.events).toContain("sound:sound/misc/menu3.wav:6");
  } finally { f.close(); }
});

test("Postgame zero and one award wait five seconds in phase two with no scoreboard in the remaining gap", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); f.cvars.set("ui_spScoreboard", "1", true); const text = observeFixedText(f);
    await show(f); await draw(f, 5000); text.clear(); await draw(f, 9999); expect(text.row(0)).toBe("");
    await draw(f, 10000); expect(text.row(0)).toBe("#1: Sarge            20");
    f.state.realtime = 0; await show(f, [50, 0, 0, 0, 0, 0]); text.clear();
    await draw(f, 5000); expect(text.row(0)).toBe("#1: Sarge            20");
    text.clear(); await draw(f, 7000); expect(text.row(0)).toBe("");
    await draw(f, 9999); expect(item(f, 12).common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
    await draw(f, 10000); expect(item(f, 12).common.flags & MenuFlag.Inactive).toBe(0);
  } finally { f.close(); }
});

test("Postgame scoreboard has eight-client cap, ties, fresh names, two blank rows and exact 1500ms scrolling", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); f.cvars.set("ui_spScoreboard", "1", true);
    await show(f, [0, 0, 0, 0, 0, 0], Array.from({ length: 10 }, (_, n) => [n, n === 0 ? 0x4000 : n, 20 - n]), 9);
    expect(score(f, 0)).toBe(8); await skip(f); const text = observeFixedText(f);
    await draw(f, 15000); expect(text.row(0, 392)).toBe("(tie) #1: Sarge            20");
    expect(text.row(16)).toBe("#2: Bot1             19"); expect(text.row(32)).toBe("#3: Bot2             18");
    text.clear(); await draw(f, 11999); expect(text.row(0)).toBe("#8: Bot7             13"); expect(text.row(16)).toBe(""); expect(text.row(32)).toBe("");
    text.clear(); await draw(f, 12000); expect(text.row(0)).toBe(""); expect(text.row(16)).toBe(""); expect(text.row(32)).toBe("#1: Sarge            20");
    await f.load("q3dm1", "100", [[544, "\\n\\^4Renamed"], ...players.slice(1)]);
    text.clear(); await draw(f, 15000); expect(text.row(0)).toBe("#1: Renamed          20");
    f.cvars.set("ui_spScoreboard", "0.1", true); text.clear(); await draw(f, 15000); expect(text.row(0)).not.toBe("");
    f.cvars.set("ui_spScoreboard", "0", true); text.clear(); await draw(f, 15000); expect(text.row(0)).toBe("");
  } finally { f.close(); }
});

test("Postgame awards preserve thresholds, signed counts, cumulative hundred-frag milestones and perfect boolean", async () => {
  const f = await fixture(); try {
    f.cvars.set("g_spAwards", "\\a4\\99", true); await show(f, [49, -2, 0, 1, 1, -4]);
    expect(Array.from({ length: 6 }, (_, n) => f.game.getAwardLevel(n))).toEqual([0, -2, 0, 1, 100, 1]);
    await skip(f); f.registrations.length = 0; await draw(f, 2000);
    expect(f.registrations.filter(value => value.startsWith("shader:menu/medals/"))).toEqual([
      "shader:menu/medals/medal_impressive", "shader:menu/medals/medal_gauntlet", "shader:menu/medals/medal_frags", "shader:menu/medals/medal_victory",
    ]);
    f.state.realtime = 0; await show(f, [50, 0, 0, 0, 99, 0]); await skip(f); f.registrations.length = 0; await draw(f, 2000);
    expect(f.game.getAwardLevel(4)).toBe(199); expect(f.registrations.filter(value => value.startsWith("shader:menu/medals/"))).toEqual(["shader:menu/medals/medal_accuracy"]);
    f.state.realtime = 0; await show(f, [0, 0, 0, 0, 301, 0]); await skip(f); f.registrations.length = 0; await draw(f, 2000);
    expect(f.game.getAwardLevel(4)).toBe(500); expect(f.registrations.filter(value => value.startsWith("shader:menu/medals/"))).toEqual(["shader:menu/medals/medal_frags"]);
  } finally { f.close(); }
});

for (const [map, tier, demo, film, selection, nextmap] of [
  ["q3dm0", 0, false, "tier1", "0", "levelselect"],
  ["q3tourney1", 1, false, "tier2", "4", "levelselect"],
  ["q3tourney1", 1, true, "demoEnd", "-99", ""],
  ["q3tourney6", 7, false, "end", "-99", ""],
] satisfies [string, number, boolean, string, string, string][]) {
  test(`Postgame retail ${map} completion appends ${film} once and preserves source nextmap and selection`, async () => {
    const f = await fixture(); try {
      for (let level = 0; level < 4; level++) f.game.setBestScore(level, 1);
      await f.load(map); f.state.demoVersion = demo; f.cvars.set("ui_spSelection", "-99", true); f.cvars.set("nextmap", "old", true);
      await show(f); await skip(f); await draw(f, 2000);
      expect(f.consoleCommands.pendingText).toBe(`music music/win\nabort_podium\ndisconnect; cinematic ${film}.RoQ\n`);
      expect(f.cvars.get("ui_spSelection")?.value).toBe(selection); expect(f.cvars.get("nextmap")?.value).toBe(nextmap);
      expect(infoValueForKey(f.cvars.get("g_spVideos")?.value ?? "", `tier${demo ? 8 : tier + 1}`)).toBe("1");
      expect(item(f, 10).common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
      await draw(f, 2001); expect(item(f, 10).common.flags & MenuFlag.Inactive).toBe(0);
      expect(f.consoleCommands.pendingText.match(/cinematic/g)?.length).toBe(1);
    } finally { f.close(); }
  });
}

test("Postgame Next uses actual progression and arena start after pop, while Menu appends disconnect and levelselect", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.load("q3dm0"); await show(f); await skip(f); await draw(f, 2000); await draw(f, 2001);
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await press(f, KeyCode.Enter, 2002);
    expect(f.state.menuDepth).toBe(0); expect(f.consoleCommands.pendingText.endsWith("spmap q3dm1\n")).toBe(true);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("0"); expect(f.cvars.get("sv_maxclients")?.value).toBe("8");
    f.state.realtime = 0; await f.load("q3tourney1"); await show(f, [0, 0, 0, 0, 0, 0], [[0, 1, 10]], 0);
    await skip(f); await draw(f, 2000); await activate(f, 11);
    expect(f.consoleCommands.pendingText.endsWith("spmap q3dm1\n")).toBe(true);
    f.state.realtime = 0; await show(f); await skip(f); await draw(f, 2000);
    const before = f.consoleCommands.pendingText;
    await activate(f, 12, MenuEvent.GotFocus); await activate(f, 12, MenuEvent.LostFocus); expect(f.consoleCommands.pendingText).toBe(before);
    await activate(f, 12); expect(f.consoleCommands.pendingText).toBe(`${before}disconnect; levelselect\n`); expect(f.state.activeMenu).toBeNull();
  } finally { f.close(); }
});

test("Postgame loss announcement uses cleaned and width-limited winner name, zero handles stay silent in podium phase", async () => {
  const f = await fixture(); try {
    const long = "W".repeat(63); let trimmed = long;
    while (stringWidth(trimmed) > 256) trimmed = trimmed.slice(0, -1);
    await f.load("q3dm1", "100", [[544, `\\n\\^1${long}`], ...players.slice(1)]);
    await show(f, [0, 0, 0, 0, 0, 0], [[0, 0, 20], [1, 1, 10]], 1);
    expect(f.registrations.at(-1)).toBe(`sound:sound/player/announce/${trimmed}_wins.wav:false`);
    await draw(f, 1000); expect(f.events).toEqual([]); expect(f.consoleCommands.pendingText).toBe("music music/loss\n");
    f.state.realtime = 0; await f.load("q3dm1", "100", [[544, "\\n\\^3Crash"], ...players.slice(1)]);
    await show(f, [0, 0, 0, 0, 0, 0], [[0, 0, 20], [1, 1, 10]], 1);
    await draw(f, 1000); expect(f.events).toContain("sound:sound/player/announce/Crash_wins.wav:7");
  } finally { f.close(); }
});

test("Postgame fresh server identity pops before podium drawing and does not append commands", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await show(f); const before = f.consoleCommands.pendingText;
    await f.load("q3dm1", "101"); await refresh(f.state, 1000);
    expect(f.state.activeMenu).toBeNull(); expect(f.keys.getCatcher()).toBe(0); expect(f.consoleCommands.pendingText).toBe(before);
    expect(f.events).not.toContain("sound:sound/player/announce/youwin.wav:7");
    expect(f.events[0]).toBe("sound:sound/misc/menu3.wav:6");
  } finally { f.close(); }
});

test("Postgame resets stable records before unknown map and cache failure; progression remains published and retry restores identities", async () => {
  const f = await fixture(); try {
    await show(f); const menu = f.owner.menu, items = [...menu.items], commons = items.map(value => value.common);
    await f.load("missing"); await show(f); expect(menu.items).toEqual([]); expect(menu.key).toBeNull(); expect(f.state.activeMenu).toBe(menu);
    expect(items.every(value => value.common.parent === null && value.common.callback === null)).toBe(true);
    await f.load(); const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("Next art failed");
    f.resources.registerShaderNoMip = async name => { if (name === art[4]) throw failure; return await register(name); };
    await expect(show(f, [50, 1, 0, 0, 0, 0])).rejects.toBe(failure);
    expect(f.game.getAwardLevel(0)).toBe(1); expect(f.game.getAwardLevel(1)).toBe(1); expect(menu.itemCount).toBe(0);
    expect(menu.wrapAround).toBe(true); expect(menu.key).not.toBeNull(); expect(menu.draw).not.toBeNull(); expect(f.state.menuDepth).toBe(0);
    f.resources.registerShaderNoMip = register; await show(f);
    expect(menu.items.every((value, n) => value === itemAt(items, n) && value.common === itemAt(commons, n))).toBe(true);
  } finally { f.close(); }
});

test("Postgame reached invalid player config rejects after menu push, and negative counts retain zero initialized podium slots", async () => {
  const f = await fixture(); try {
    await expect(show(f, [0, 0, 0, 0, 0, 0], [[480, 1, 7]], 480)).rejects.toThrow("uninitialized configstring storage");
    expect(score(f, 0)).toBe(2); expect(f.state.activeMenu).toBe(f.owner.menu); expect(f.owner.menu.itemCount).toBe(3);
    expect(f.consoleCommands.pendingText).toBe("");
    await show(f, [0, 0, 0, 0, 0, 0], [], 0, -1); expect(f.registrations.at(-1)).toBe("sound:sound/player/announce/Sarge_wins.wav:false");
    expect(f.consoleCommands.pendingText).toBe("music music/loss\n");
  } finally { f.close(); }
});

test("Postgame award sound failure keeps played flag, winner failure keeps initialized menu, and reopened record retries", async () => {
  const f = await fixture(); try {
    const register = f.soundBank.registerSound.bind(f.soundBank), failure = new Error("winner failed");
    f.soundBank.registerSound = async (name, compressed) => { if (name === "sound/player/announce/youwin.wav") throw failure; return await register(name, compressed); };
    await expect(show(f)).rejects.toBe(failure); expect(f.state.menuDepth).toBe(1); expect(f.owner.menu.itemCount).toBe(3);
    expect(f.consoleCommands.pendingText).toBe("");
    f.soundBank.registerSound = register; await show(f, [50, 0, 0, 0, 0, 0]); await press(f, KeyCode.Space, 1500);
    let calls = 0;
    f.soundBank.registerSound = async (name, compressed) => { if (name === MEDAL_SOUNDS[0]) { calls++; throw failure; } return await register(name, compressed); };
    await expect(draw(f, 1500)).rejects.toBe(failure); await draw(f, 1501); expect(calls).toBe(1); expect(f.events).toEqual([]);
    f.soundBank.registerSound = register; f.state.realtime = 0; await show(f, [50, 0, 0, 0, 0, 0]); await draw(f, 5000);
    expect(f.events).toContain("sound:sound/feedback/accuracy.wav:7");
  } finally { f.close(); }
});

test("Postgame awaited registration cannot continue after retirement or escaped command execution", async () => {
  const f = await fixture(); try {
    const entered = deferred(), gate = deferred(), register = f.resources.registerShaderNoMip.bind(f.resources); let calls = 0;
    f.resources.registerShaderNoMip = async name => { calls++; entered.resolve(); await gate.promise; f.state.retire(); return await register(name); };
    const pending = show(f, [50, 0, 0, 0, 0, 0]); await entered.promise; gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(calls).toBe(1); expect(f.owner.menu.itemCount).toBe(0); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
  const f2 = await fixture(); try {
    const escaped: { promise: Promise<void> | null } = { promise: null };
    f2.consoleCommands.register("escaped", context => { escaped.promise = f2.owner.showFromCommand(context); });
    f2.consoleCommands.executeNow("escaped 0 0 0 0 0 0 0 0");
    if (escaped.promise === null) throw new Error("Missing escaped postgame work");
    await expect(escaped.promise).rejects.toThrow("closed"); expect(f2.owner.menu.itemCount).toBe(0);
    expect(f2.consoleCommands.pendingText).toBe("");
  } finally { f2.close(); }
});

test("Postgame command argv uses 1024-byte source copies, missing arguments are empty and integers wrap", async () => {
  const f = await fixture(); try {
    await f.consoleCommands.executeNowAsync(`postgame 1 0 ${"0".repeat(1023)}99 0 0 0 0 0 0 0 20`);
    expect(f.game.getAwardLevel(0)).toBe(0); expect(score(f, 0)).toBe(1);
    f.game.newGame();
    await f.consoleCommands.executeNowAsync("postgame 4294967297rest 0 4294967346tail 0 0 0 0 0 0 16384 20");
    expect(f.game.getAwardLevel(0)).toBe(1); expect(score(f, 0)).toBe(1);
    f.game.newGame(); await f.consoleCommands.executeNowAsync("postgame"); expect(score(f, 0)).toBe(8);
    expect(f.registrations.at(-1)).toBe("sound:sound/player/announce/Sarge_wins.wav:false");
  } finally { f.close(); }
});

test("Postgame medal placement, amount omission and float32 fade reach the actual draw queue", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await show(f, [75, 2, 1, -3, 200, 1]); await press(f, KeyCode.Space, 1500);
    const text = observeFixedText(f), rectangles: number[][] = [], colors: number[] = [];
    const picture = f.state.draw.drawPic.bind(f.state.draw), color = f.state.draw.setColor.bind(f.state.draw);
    f.state.draw.drawPic = (rect, media) => { rectangles.push([rect.x, rect.y, rect.width, rect.height]); picture(rect, media); };
    f.state.draw.setColor = value => { if (value !== null) colors.push(value.w); color(value); };
    await draw(f, 1501); expect(colors).toContain(Math.fround(1999 / 2000));
    expect(rectangles).toEqual([[144, 64, 48, 48]]);
    expect(text.glyphs.filter(glyph => glyph.y === 116).map(glyph => [glyph.x, glyph.code])).toEqual([[144, 55], [160, 53], [176, 37]]);
    await press(f, KeyCode.Space, 1750); rectangles.length = 0; text.clear(); await draw(f, 2000);
    expect(rectangles).toEqual([[144, 64, 48, 48], [448, 64, 48, 48], [88, 64, 48, 48], [504, 64, 48, 48], [32, 64, 48, 48], [560, 64, 48, 48]]);
    expect(text.glyphs.filter(glyph => glyph.y === 116).map(glyph => [glyph.x, glyph.code])).toEqual([
      [144, 55], [160, 53], [176, 37], [464, 50], [512, 45], [528, 51], [32, 50], [48, 48], [64, 48],
    ]);
    expect(f.commands.submit().batches).toBeGreaterThan(0);
  } finally { f.close(); }
});

test("Postgame award zero sound resolves source handle zero on announcer channel while winner zero skips playback", async () => {
  const f = await fixture(); try {
    const read = f.assets.readFileRetained.bind(f.assets);
    f.assets.readFileRetained = async path => path === "sound/feedback/accuracy.wav" || path === "sound/player/announce/youwin.wav"
      ? undefined : await read(path);
    await show(f, [50, 0, 0, 0, 0, 0]); await draw(f, 1000); expect(f.events).toEqual([]);
    await draw(f, 5000); expect(f.events).toEqual(["sound:sound/feedback/hit.wav:7"]);
    expect(f.mixer.mix(4096).some(value => value !== 0)).toBe(true);
  } finally { f.close(); }
});

test("Postgame award and scoreboard negative timer storage fail only at the reached source array read", async () => {
  const f = await fixture(); try {
    await show(f, [50, 0, 0, 0, 0, 0]); await press(f, KeyCode.Space, 1500);
    await expect(draw(f, -500)).rejects.toThrow("array index -1");
    await press(f, KeyCode.Space, 1750); await draw(f, 2000);
    f.state.realtime = 0; await show(f, [0, 0, 0, 0, 0, 0], [[0, 0, 20], [1, 1, 19], [2, 2, 18], [3, 3, 17]]);
    await skip(f); f.cvars.set("ui_spScoreboard", "1", true);
    await expect(draw(f, -1500)).rejects.toThrow("array index -1");
    expect(f.owner.menu.items.every(value => (value.common.flags & MenuFlag.Inactive) === 0)).toBe(true);
  } finally { f.close(); }
});
