import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { GamestateEntry, ServerMessageContext } from "../src/protocol/server-message.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseRemoveBotsMenu } from "../src/ui/base/remove-bots.ts";
import { COLORS, itemAt, MenuEvent } from "../src/ui/base/state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const art = ["menu/art/addbotframe", "menu/art/back_0", "menu/art/back_1", "menu/art/delete_0", "menu/art/delete_1"];
const roster: readonly (readonly [number, string])[] = Array.from({ length: 11 }, (_, n) => [544 + n,
  `\\n\\^${n % 7 + 1}Bot${n}\\skill\\${n === 2 || n === 6 ? 0 : n === 3 ? -2 : 3}\\t\\1`]);
async function fixture() {
  const ui = await baseFixture(320, 240), cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
  let sequence = 0;
  async function load(server = "\\sv_maxclients\\11", players = roster): Promise<void> {
    sequence++;
    const entries: GamestateEntry[] = [{ kind: "configstring", index: 0, value: server },
      { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\" },
      ...players.map(([index, value]) => ({ kind: "configstring", index, value } satisfies GamestateEntry))];
    const context: ServerMessageContext = { product: "baseq3", messageNumber: sequence, reliableSequence: 0,
      serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    await session.receiveServerMessage(sequence, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0,
      clientNumber: 7, checksumFeed: 19, entries }], context));
  }
  const close = (): void => { lifecycle.close(); ui.close(); ui.assets.files.close(); };
  try {
    await load();
    return { ...ui, session, load, owner: new BaseRemoveBotsMenu(ui.state), close };
  } catch (error) { close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function item(f: Fixture, id: number) {
  const found = f.owner.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing Remove Bots item ${id}`);
  return found;
}
function rows(f: Fixture) { return f.owner.menu.items.filter(value => value.kind === "proportional"); }
async function activate(f: Fixture, id: number, event = MenuEvent.Activated): Promise<void> {
  const selected = item(f, id), callback = selected.common.callback;
  if (callback === null) throw new Error("Missing source Remove Bots callback");
  await callback(selected, event);
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}

test("Remove Bots caches before live roster reads and installs source rows, order and initial focus", async () => {
  const f = await fixture(); try {
    const read = f.session.getGameState.bind(f.session), register = f.resources.registerShaderNoMip.bind(f.resources), trace: string[] = [];
    f.session.getGameState = () => { trace.push("config"); return read(); };
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); trace.push(name); return await register(name); };
    await f.owner.show(f.session);
    expect(trace).toEqual([...art, ...new Array<string>(19).fill("config")]);
    expect(rows(f).map(row => row.text)).toEqual(["Bot0", "Bot1", "Bot3", "Bot4", "Bot5", "Bot7", "Bot8"]);
    expect(f.owner.menu.items.map((value): (string | number)[] => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["bitmap", 0, 87, 74, 0x4000], ["banner", 0, 320, 16, 0x4000], ["bitmap", 0, 200, 128, 0x4000],
      ["bitmap", 10, 200, 128, 0x104], ["bitmap", 11, 200, 192, 0x104],
      ...Array.from({ length: 7 }, (_, n) => ["proportional", 20 + n, 264, 120 + 20 * n, 0x104]),
      ["bitmap", 12, 320, 320, 0x104], ["bitmap", 13, 192, 320, 0x104],
    ]);
    expect(rows(f).map(row => row.color)).toEqual([COLORS.white, ...new Array<typeof COLORS.normal>(6).fill(COLORS.normal)]);
    expect([f.owner.menu.cursor, f.owner.menu.cursorPrev, f.owner.menu.fullscreen, f.owner.menu.wrapAround]).toEqual([3, 0, false, true]);
    expect(f.owner.menu.items.every((value, n) => value.common.parent === f.owner.menu && value.common.menuPosition === n)).toBe(true);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
  } finally { f.close(); }
});

test("Remove Bots actual keys scroll fresh names but preserve captured client numbers and selected row", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.owner.show(f.session);
    const records = [...rows(f)];
    await setCursorToItem(f.state, f.owner.menu, item(f, 22)); await press(f, KeyCode.Enter);
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await press(f, KeyCode.Enter);
    expect(rows(f).map(row => row.text)).toEqual(["Bot1", "Bot3", "Bot4", "Bot5", "Bot7", "Bot8", "Bot9"]);
    expect(rows(f)[2]?.color).toBe(COLORS.white);
    const changed = roster.map(([index, value]): readonly [number, string] => [index, index === 548 ? "\\n\\Renamed\\skill\\0" : value]);
    await f.load("\\sv_maxclients\\11", changed);
    await setCursorToItem(f.state, f.owner.menu, item(f, 12)); await press(f, KeyCode.Enter); await press(f, KeyCode.Enter);
    expect(f.consoleCommands.pendingText).toBe("clientkick 4\nclientkick 4\n"); expect(f.state.menuDepth).toBe(1);
    await activate(f, 11); expect(rows(f)[1]?.text).toBe("Renamed");
    expect(rows(f).every((row, n) => row === records[n])).toBe(true);
    const bottom = rows(f).map(row => row.text); await activate(f, 11); expect(rows(f).map(row => row.text)).toEqual(bottom);
    await activate(f, 10); await activate(f, 10); await activate(f, 10); expect(rows(f)[0]?.text).toBe("Bot0");
    f.state.cursorX = 200; f.state.cursorY = 340; await mouseEvent(f.state, 0, 0); await press(f, KeyCode.Mouse1);
    expect(f.state.menuDepth).toBe(0); expect(f.keys.getCatcher()).toBe(0);
    expect(f.events).toContain("sound:sound/misc/menu2.wav:6"); expect(f.events).toContain("sound:sound/misc/menu3.wav:6");
  } finally { f.close(); }
});

test("Remove Bots empty roster still permits source clientkick zero and sparse skills use atoi", async () => {
  const f = await fixture(); try {
    await f.load("\\sv_maxclients\\-1"); await f.owner.show(f.session);
    expect(rows(f)).toEqual([]); expect(f.owner.menu.itemCount).toBe(7);
    for (const event of [MenuEvent.GotFocus, MenuEvent.LostFocus]) await activate(f, 12, event);
    expect(f.consoleCommands.pendingText).toBe(""); await activate(f, 12); expect(f.consoleCommands.pendingText).toBe("clientkick 0\n");
    const name = "^1" + "x".repeat(27) + "^2tail";
    await f.load("\\sv_maxclients\\4294967299tail", [[544, `\\n\\${name}\\skill\\-2rest`],
      [545, "\\n\\Human\\skill\\4294967296"], [546, "\\n\\^3Third\u0080\u001f^^\\skill\\1"]]);
    await f.owner.show(f.session); expect(rows(f).map(row => row.text)).toEqual(["x".repeat(27), "Third.^^"]);
    await activate(f, 21); await activate(f, 12); expect(f.consoleCommands.pendingText).toBe("clientkick 0\nclientkick 2\n");
  } finally { f.close(); }
});

test("Remove Bots bounds retain last valid config scratch and reject reached source uninitialized or overflowing storage", async () => {
  const f = await fixture(); try {
    const players: readonly (readonly [number, string])[] = Array.from({ length: 7 }, (_, n) => [1017 + n, `\\n\\Last${n}\\skill\\1`]);
    await f.load("\\sv_maxclients\\487", players); await f.owner.show(f.session);
    expect(rows(f).map(row => row.text)).toEqual(["Last0", "Last1", "Last2", "Last3", "Last4", "Last5", "Last6"]);
    for (let n = 0; n < 6; n++) await activate(f, 11);
    expect(rows(f).map(row => row.text)).toEqual(new Array<string>(7).fill("Last6"));
    await expect(activate(f, 11)).rejects.toThrow("uninitialized configstring storage");
    await activate(f, 12); expect(f.consoleCommands.pendingText).toBe("clientkick 480\n");
    await f.load("\\sv_maxclients\\2000", [[1023, "\\n\\Last\\skill\\1"]]);
    await expect(f.owner.show(f.session)).rejects.toThrow("array index 1024"); expect(f.owner.menu.itemCount).toBe(0);
  } finally { f.close(); }
});

test("Remove Bots resets stable records before cache failure and prevents continuation after retirement", async () => {
  const f = await fixture(); try {
    await f.owner.show(f.session); const menu = f.owner.menu, saved = [...menu.items];
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("Delete image load failed");
    f.resources.registerShaderNoMip = async name => { if (name === art[3]) throw failure; return await register(name); };
    await expect(f.owner.show(f.session)).rejects.toBe(failure); expect(f.state.activeMenu).toBe(menu); expect(menu.itemCount).toBe(0);
    expect(saved.every(value => value.common.parent === null && value.common.callback === null)).toBe(true);
    f.resources.registerShaderNoMip = register; await f.owner.show(f.session);
    expect(menu.items.every((value, n) => value === itemAt(saved, n))).toBe(true);
    const entered = deferred(), gate = deferred(); let calls = 0;
    f.resources.registerShaderNoMip = async name => { calls++; entered.resolve(); await gate.promise; return await register(name); };
    const pending = f.owner.show(f.session); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(menu.itemCount).toBe(0); expect(calls).toBe(1);
  } finally { f.close(); }
});

test("Remove Bots real retail CPU queue draws the background, banner, bot labels and delete art", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.owner.show(f.session); await refresh(f.state, 1000);
    expect(f.commands.submit().batches).toBeGreaterThan(5);
    const textures = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
    expect(textures).toContain("menu/art/addbotframe.tga"); expect(textures).toContain("menu/art/delete_0.tga");
    expect(textures).toContain("menu/art/arrows_vert_0.tga"); expect(textures).toContain("menu/art/font1_prop.tga");
    expect(f.cpu.pixels.some((value, n) => n % 4 !== 3 && value !== 0)).toBe(true);
  } finally { f.close(); }
});
