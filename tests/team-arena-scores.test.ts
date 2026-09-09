import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { CvarReference, CvarStringInput } from "../src/core/cvar.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
import { KEY_CHAR_FLAG, KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { keynumToString } from "../src/engine/client-keys.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { loadMenuDefinitions, UiWindowFlag } from "../src/ui/menu.ts";
import { UiMenuCommand } from "../src/ui/public.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaGameInfo, TeamArenaMenuBuffer, infoSlot } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaMenuController } from "../src/ui/team-arena/menu-controller.ts";
import { TeamArenaPlayerList } from "../src/ui/team-arena/player-list.ts";
import { TeamArenaPostGame } from "../src/ui/team-arena/postgame.ts";
import { PostGameInfo, TeamArenaScores } from "../src/ui/team-arena/scores.ts";
import { TeamArenaSettings } from "../src/ui/team-arena/settings.ts";
import { TeamArenaVisibility, TeamArenaVisibilityFlag } from "../src/ui/team-arena/visibility.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture } from "./base-ui-fixture.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

function savedRecord(values: readonly number[], size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(68), view = new DataView(bytes.buffer);
  view.setInt32(0, size, true);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === undefined) throw new Error("Missing fixture score integer");
    view.setInt32(4 + index * 4, value, true);
  }
  return bytes;
}

async function fixture(entries: Readonly<Record<string, Uint8Array>> = {}, packed = false, cvars = new CvarRegistry()) {
  const root = mkdtempSync(join(tmpdir(), "quake3-team-scores-")), home = join(root, "home");
  mkdirSync(join(root, "baseq3")); mkdirSync(join(root, "missionpack"));
  mkdirSync(join(home, "missionpack"), { recursive: true });
  writeFileSync(join(root, "baseq3", "default.cfg"), "fixture\n");
  if (packed) {
    writeFileSync(join(root, "missionpack", "pak0.pk3"), sourceZip(Object.entries(entries).map(([name, data]) => ({
      name: new TextEncoder().encode(name), data, method: 8, utf8: false,
    }))));
  } else for (const [name, bytes] of Object.entries(entries)) {
    const path = join(root, "missionpack", name);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
  }
  const prints: string[] = [], sound = new SoundOutput();
  const print = (text: string): undefined => { prints.push(text); };
  const files = new CommonFileState({ dataPath: root, homePath: home, cdPath: null, product: "missionpack" }, print, sound, cvars);
  let active = true;
  const assertActive = (): void => { if (!active) throw new Error("retired score owner"); };
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, assertActive);
    cvars.register("protocol", "68");
    const scores = new TeamArenaScores({ files, cvars, print, assertActive });
    return { root, home, files, cvars, scores, prints, print, assertActive, retire: () => { active = false; },
      close: () => { files.close(); sound.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { files.close(); sound.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

const fields = ["Accuracy", "Impressives", "Excellents", "Defends", "Assists", "Gauntlets", "Score", "Perfect", "Team",
  "Base", "TimeBonus", "SkillBonus", "ShutoutBonus", "Time", "Captures"];

function unused(): never { throw new Error("Postgame calculation fixture does not exercise painting, media or feeders"); }

async function postgameFixture(entries: Readonly<Record<string, Uint8Array>> = {}) {
  const graphics = await baseFixture();
  let f: Awaited<ReturnType<typeof fixture>> | null = null, runtime: UiRuntime | null = null;
  const lifecycle = new ProtocolClientLifecycle(graphics.cvars);
  try {
    const encoder = new TextEncoder();
    f = await fixture({ ...entries,
      "ui/set.txt": encoder.encode('{ loadMenu { "ui/postgame.menu" } }'),
      "ui/postgame.menu": encoder.encode(["main", "error_popmenu", "team", "ingame", "endofgame"].map(name =>
        `menuDef { name ${name} rect 0 0 640 480 visible 0 fullScreen ${name === "main" ? 1 : 0}
          onESC { setcvar closed_by_escape ${name} }
          ${name === "endofgame" ? "onOpen { setcvar postgame_open 1 }" : ""} }`).join("\n")),
    }, false, graphics.cvars);
    const files = f.files, assertActive = f.assertActive;
    const ui = new TeamArenaUiCvars(f.cvars, () => { assertActive(); });
    const game = new TeamArenaGameInfo({ menuBuffer: new TeamArenaMenuBuffer(files, f.print, assertActive),
      sourceParser: new CommonParseState(), memory: new TeamArenaUiMemory("qvm32", f.print),
      resources: graphics.resources, print: f.print, assertActive });
    const source = (path: string) => files.current.has(path)
      ? { path, text: new TextDecoder().decode(files.current.readSync(path)) } : undefined;
    const definitions = await loadMenuDefinitions({ resolver: { resolveRoot: source, resolve: request => source(request.requestedPath) },
      random: { nextInt: () => 0 } }, { kind: "ui", setPaths: ["ui/set.txt"] });
    const white = graphics.resources.picture(await graphics.resources.registerShaderNoMip("white"));
    runtime = await UiRuntime.create({ definitions, cvars: f.cvars, commands: graphics.consoleCommands,
      resources: { handles: { kind: "diagnostic" }, registerFont: unused, registerPicture: unused, registeredPicture: unused, registerSound: unused,
        registeredSound: unused, registerModel: unused, registeredModel: unused, prepareCinematic: unused },
      fonts: { get small() { return unused(); }, get normal() { return unused(); }, get big() { return unused(); },
        profile: "ui", smallThreshold: .25, bigThreshold: .4 },
      widgetAssets: { whiteShader: white, gradientBar: white, scrollBar: white, scrollBarArrowDown: white,
        scrollBarArrowUp: white, scrollBarArrowLeft: white, scrollBarArrowRight: white, scrollBarThumb: white,
        sliderBar: white, sliderThumb: white }, zeroPicture: graphics.resources.picture(null),
      audio: { playLocal: unused, startBackground: unused, stopBackground: unused },
      cinematics: { play: unused, run: unused, draw: unused, stop: unused }, paintModel: unused,
      context: { kind: "ui", bindings: {
        keyName: keynumToString, getBinding: key => graphics.keys.getBinding(key) ?? "",
        setBinding: (key, text) => { graphics.keys.setBinding(key, text); },
        getOverstrike: () => graphics.keys.getOverstrike(), setOverstrike: enabled => { graphics.keys.setOverstrike(enabled); },
      }, pause: paused => { graphics.cvars.set("cl_paused", paused ? "1" : "0", true); } },
      feeder: { count: unused, item: unused, image: unused, select: unused },
      ownerDraw: { visible: unused, width: unused, value: unused, handleKey: unused, paint: unused, closeCinematic: unused },
      externalScript: { run: unused }, getTeamColor: unused,
    });
    const session = new EngineClientSession({ product: "missionpack", cvars: f.cvars, lifecycle,
      mode: { kind: "network", challenge: 1, qport: 27961 } });
    let sequence = 0;
    const load = async (map = "map", gameType = "4"): Promise<void> => {
      sequence++;
      await session.receiveServerMessage(sequence, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0,
        clientNumber: 0, checksumFeed: 19, entries: [
          { kind: "configstring", index: 0, value: `\\mapname\\${map}\\g_gametype\\${gameType}\\sv_maxclients\\1` },
          { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\missionpack" },
          { kind: "configstring", index: 544, value: "\\n\\^1Player\\t\\1" },
        ] }], { product: "missionpack", messageNumber: sequence, reliableSequence: 0,
        serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
    };
    await load();
    const players = new TeamArenaPlayerList(f.cvars, assertActive);
    const menus = new TeamArenaMenuController({ runtime, keys: graphics.keys, cvars: ui, players,
      loader: { inGameLoad: false, loadNonIngame: () => { throw new Error("Postgame fixture has no deferred in-game load"); } },
      readClient: () => session, assertActive });
    const postgame = new TeamArenaPostGame({ cvars: ui, gameInfo: game, scores: f.scores, menus, assertActive });
    let currentTime = 0;
    graphics.consoleCommands.registerAsync("postgame", context => postgame.calculate(context, session, currentTime));
    const calculate = async (args = "42 1 2 3 4 5 100 1 8 0 61000 2", realTime = 1000): Promise<void> => {
      currentTime = realTime;
      graphics.consoleCommands.append(`postgame ignored ignored ${args}\n`);
      await graphics.consoleCommands.executeAsync();
    };
    const owner = f, menusRuntime = runtime;
    return { ...owner, graphics, ui, game, postgame, runtime: menusRuntime, menus, players, session, load, calculate,
      close: () => { menusRuntime.dispose(); lifecycle.close(); owner.close(); graphics.close(); } };
  } catch (error) { runtime?.dispose(); lifecycle.close(); f?.close(); graphics.close(); throw error; }
}

test("Team Arena visibility reads the source live cvars, VM selections and retained player rows", async () => {
  const f = await postgameFixture();
  try {
    const visibility = new TeamArenaVisibility({ cvars: f.ui, gameInfo: f.game, players: f.players,
      postgame: f.postgame, scores: f.scores, sound: { startLocalSound: unused }, newHighScoreSound: unused,
      assertActive: f.assertActive });
    const flag = TeamArenaVisibilityFlag;
    expect(visibility.visible(0x40000000, 0)).toBe(true);
    f.cvars.set("g_gametype", "0", true);
    expect(visibility.visible(flag.Ffa, 0)).toBe(true);
    expect(visibility.visible(flag.NotFfa, 0)).toBe(false);
    f.cvars.set("g_gametype", "0.5", true);
    expect(visibility.visible(flag.Ffa, 0)).toBe(false);
    expect(visibility.visible(flag.NotFfa, 0)).toBe(true);
    f.players.myTeamCount = 2; f.players.playerNumber = 5;
    f.players.teamClientNums[0] = 5; f.players.teamClientNums[1] = 9;
    f.ui.writeInteger("ui_selectedPlayer", -1);
    expect(visibility.visible(flag.Leader, 0)).toBe(false);
    expect(visibility.visible(flag.NotLeader, 0)).toBe(true);
    f.players.teamLeader = 1;
    expect(() => visibility.visible(flag.Leader, 0)).toThrow("64-entry array");
    f.ui.writeInteger("ui_selectedPlayer", 0);
    expect(visibility.visible(flag.Leader, 0)).toBe(false);
    expect(visibility.visible(flag.NotLeader, 0)).toBe(true);
    for (const selected of [1, 2]) {
      f.ui.writeInteger("ui_selectedPlayer", selected);
      expect(visibility.visible(flag.Leader, 0)).toBe(true);
      expect(visibility.visible(flag.NotLeader, 0)).toBe(false);
    }
    f.cvars.set("ui_netSource", "3", true);
    expect(visibility.visible(flag.FavoriteServers, 0)).toBe(false);
    f.ui.update();
    expect(visibility.visible(flag.FavoriteServers, 0)).toBe(true);
    expect(visibility.visible(flag.NotFavoriteServers, 0)).toBe(false);
    f.ui.writeInteger("ui_gameType", 0); f.ui.writeInteger("ui_netGameType", 1);
    infoSlot(f.game.gameTypes, 0).gtEnum = 3; infoSlot(f.game.gameTypes, 1).gtEnum = 4;
    expect(visibility.visible(flag.AnyTeamGame, 0)).toBe(false);
    expect(visibility.visible(flag.AnyNonTeamGame, 0)).toBe(true);
    expect(visibility.visible(flag.NetAnyTeamGame, 0)).toBe(true);
    expect(visibility.visible(flag.NetAnyNonTeamGame, 0)).toBe(false);
    expect(visibility.visible(flag.DemoAvailable, 0)).toBe(false);
    f.scores.demoAvailable = true;
    expect(visibility.visible(flag.DemoAvailable, 0)).toBe(true);
    expect(visibility.visible(flag.NewBestTime, 0)).toBe(true);
    expect(visibility.visible(flag.NewBestTime, 1)).toBe(false);
    f.retire();
    expect(() => visibility.visible(0, 0)).toThrow("retired score owner");
  } finally { f.close(); }
});

test("Team Arena high-score visibility waits for server shutdown and plays the actual announcer sound once", async () => {
  const f = await postgameFixture();
  const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  try {
    const bank = new ClientSoundBank(files, { debugPrint: text => { f.print(text); }, print: f.print }), mixer = new AudioMixer(22050, () => 0);
    await bank.beginRegistration();
    const sound = await bank.registerSound("sound/feedback/voc_newhighscore.wav", false);
    if (sound === null) throw new Error("Missing retail Team Arena high-score sound");
    const channels: number[] = [];
    const visibility = new TeamArenaVisibility({ cvars: f.ui, gameInfo: f.game, players: f.players,
      postgame: f.postgame, scores: f.scores, newHighScoreSound: () => sound, assertActive: f.assertActive,
      sound: { startLocalSound: (registered, channel) => {
        const pcm = bank.resolveForPlayback(registered);
        channels.push(channel);
        return pcm !== null && mixer.startLocalSound(pcm, channel);
      } } });
    const flags = TeamArenaVisibilityFlag.NewHighScore | TeamArenaVisibilityFlag.DemoAvailable;
    f.postgame.newHighScoreTime = 20000; f.postgame.soundHighScore = true;
    f.cvars.set("sv_killserver", "1", true);
    expect(visibility.visible(flags, 20000)).toBe(false);
    expect(f.postgame.soundHighScore).toBe(true);
    f.cvars.set("sv_killserver", "0", true);
    expect(channels).toEqual([]);
    expect(visibility.visible(flags, 20000)).toBe(false);
    expect(f.postgame.soundHighScore).toBe(false);
    expect(channels).toEqual([7]);
    expect(visibility.visible(TeamArenaVisibilityFlag.NewHighScore, 20000)).toBe(true);
    expect(channels).toEqual([7]);
    f.postgame.soundHighScore = true;
    expect(visibility.visible(TeamArenaVisibilityFlag.NewHighScore, 20001)).toBe(false);
    expect(f.postgame.soundHighScore).toBe(true);
  } finally { files.close(); f.close(); }
});

test("Team Arena setting updates apply source preset order and preserve untouched stencil state", async () => {
  const f = await postgameFixture();
  try {
    const settings = new TeamArenaSettings(f.ui, f.game, f.assertActive), writes: string[] = [];
    const set = f.cvars.set.bind(f.cvars);
    f.cvars.register("r_stencilbits", "8", CvarFlag.ReadOnly);
    f.cvars.set("r_stencilbits", "8", true);
    f.cvars.register("r_depthbits", "16", CvarFlag.Latch);
    f.cvars.set = (name, value, force) => {
      expect(force).toBe(true); writes.push(`${name}=${value}`);
      return set(name, value, force);
    };
    set("ui_glCustom", "0.9", true);
    settings.update("UI_GLCUSTOM");
    expect(writes).toEqual(["r_fullScreen=1", "r_subdivisions=4", "r_vertexlight=0", "r_lodbias=0",
      "r_colorbits=32", "r_depthbits=24", "r_picmip=0", "r_mode=4", "r_texturebits=32", "r_fastSky=0",
      "r_inGameVideo=1", "cg_shadows=1", "cg_brassTime=2500", "r_texturemode=GL_LINEAR_MIPMAP_LINEAR"]);
    expect(f.cvars.get("r_stencilbits")?.value).toBe("8");
    expect(f.cvars.get("r_depthbits")?.value).toBe("24");
    expect(f.cvars.get("r_depthbits")?.latchedValue).toBeUndefined();
    for (const preset of [1, 2, 3]) {
      writes.length = 0; set("ui_glCustom", String(preset), true); settings.update("ui_glCustom");
      expect(writes).toHaveLength(14);
      expect(f.cvars.get("r_subdivisions")?.value).toBe(preset === 1 ? "12" : preset === 2 ? "8" : "20");
      expect(f.cvars.get("r_vertexlight")?.value).toBe(preset === 3 ? "1" : "0");
      expect(writes.slice(-2)).toEqual(preset === 1 ? ["r_texturemode=GL_LINEAR_MIPMAP_LINEAR", "cg_shadows=0"]
        : preset === 2 ? ["cg_brassTime=0", "r_texturemode=GL_LINEAR_MIPMAP_NEAREST"]
        : ["r_inGameVideo=0", "r_texturemode=GL_LINEAR_MIPMAP_NEAREST"]);
    }
    writes.length = 0; set("ui_glCustom", "4", true); settings.update("ui_glCustom");
    expect(writes).toEqual([]);
    for (const bits of [32, 16, 0]) {
      writes.length = 0; set("r_colorbits", String(bits), true); settings.update("r_colorbits");
      expect(writes).toEqual(bits === 32 ? ["r_depthbits=24"] : [`r_depthbits=${bits}`, "r_stencilbits=0"]);
    }
  } finally { f.close(); }
});

test("Team Arena name, rate, pitch and match-limit updates keep source conversions and VM selection", async () => {
  const f = await postgameFixture();
  try {
    const settings = new TeamArenaSettings(f.ui, f.game, f.assertActive);
    f.cvars.set("ui_Name", "Q".repeat(1100), true);
    settings.update("ui_SetName");
    expect(f.cvars.get("name")?.value).toBe("Q".repeat(1023));
    f.cvars.set("name", "^1Player", true); settings.update("ui_GetName");
    expect(f.cvars.get("ui_Name")?.value).toBe("^1Player");
    const rates: readonly (readonly [number, string, string])[] = [
      [3999, "15", "1"], [4000, "15", "2"], [4999, "15", "2"], [5000, "30", "1"],
    ];
    for (const [rate, packets, duplication] of rates) {
      f.cvars.set("rate", String(rate), true); settings.update("ui_setRate");
      expect([f.cvars.get("cl_maxpackets")?.value, f.cvars.get("cl_packetdup")?.value]).toEqual([packets, duplication]);
    }
    for (const pitch of [0.9, -0.9, 1, -1]) {
      f.cvars.set("ui_mousePitch", String(pitch), true); settings.update("ui_mousePitch");
      expect(f.cvars.get("m_pitch")?.value).toBe(Math.abs(pitch) < 1 ? "0.022000" : "-0.022000");
    }
    f.ui.writeInteger("ui_gameType", 0);
    for (const [type, capture] of [[3, "5"], [6, "4"], [7, "15"]] satisfies readonly (readonly [number, string])[]) {
      infoSlot(f.game.gameTypes, 0).gtEnum = type;
      settings.setCapFragLimits(true);
      expect([f.cvars.get("ui_captureLimit")?.value, f.cvars.get("ui_fragLimit")?.value]).toEqual([capture, "10"]);
      settings.setCapFragLimits(false);
      expect([f.cvars.get("capturelimit")?.value, f.cvars.get("fraglimit")?.value]).toEqual([capture, "10"]);
    }
    f.retire(); expect(() => settings.update("unknown")).toThrow("retired score owner");
  } finally { f.close(); }
});

test("saved scores decode the 16-int source layout, publish forced cvars in order, then sample live protocol", async () => {
  const f = await fixture({
    "games/map_4.game": savedRecord([101, 102, -103, 104, 105, 106, 107, 108, 109, 110, 111, 125, 113, 114, 115, 116]),
    "demos/map_4.dm_69": new Uint8Array(),
  }, true);
  try {
    const writes: string[] = [], events: string[] = [];
    f.cvars.register("ui_scoreAccuracy", "old", CvarFlag.ReadOnly);
    const set = f.cvars.set.bind(f.cvars), open = f.files.current.openRead.bind(f.files.current);
    f.files.current.openRead = path => { events.push(path); return open(path); };
    f.cvars.set = (name, value, force) => {
      expect(force).toBe(true); writes.push(name); events.push(name);
      const result = set(name, value, force);
      if (name === "ui_scoreCaptures") set("protocol", "69.9", true);
      return result;
    };
    f.scores.loadBestScores("map", 4);
    expect(writes).toEqual(fields.map(field => `ui_score${field}`));
    expect(writes.map(name => f.cvars.get(name)?.value)).toEqual([
      "105%", "106", "107", "108", "109", "110", "101", "104", "102 to -103", "116", "113", "115", "114", "02:05", "111",
    ]);
    expect(events).toEqual(["games/map_4.game", ...writes, "demos/map_4.dm_69"]);
    expect(f.scores.demoAvailable).toBe(true);
    const reopened = open("games/map_4.game");
    if (reopened === undefined) throw new Error("Missing generated score fixture");
    expect(reopened.file.slot).toBe(1); f.files.current.closeFile(reopened.file);
  } finally { f.close(); }
});

test("postgame publication reads each current field and preserves QVM integer/time formatting", async () => {
  const f = await fixture();
  try {
    const info = new PostGameInfo(), writes: string[] = [];
    info.accuracy = 99; info.time = -61; info.score = 10; info.baseScore = -2147483648;
    const set = f.cvars.set.bind(f.cvars);
    f.cvars.set = (name, value, force) => {
      writes.push(name); const result = set(name, value, force);
      if (name === "ui_scoreAccuracy") info.score = 20;
      if (name === "ui_scoreCaptures") { info.accuracy = 50; info.time = 3601; }
      return result;
    };
    f.scores.setBestScores(info, true);
    expect(writes).toEqual([...fields.map(field => `ui_score${field}`), ...fields.map(field => `ui_score${field}2`)]);
    expect(f.cvars.get("ui_scoreScore")?.value).toBe("20");
    expect(f.cvars.get("ui_scoreAccuracy")?.value).toBe("99%");
    expect(f.cvars.get("ui_scoreAccuracy2")?.value).toBe("50%");
    expect(f.cvars.get("ui_scoreTime")?.value).toBe("-1:-1");
    expect(f.cvars.get("ui_scoreTime2")?.value).toBe("60:01");
    expect(f.cvars.get("ui_scoreBase")?.value).toBe("-./,),(-*,(");
    info.accuracy = 1.5;
    expect(() => f.scores.setBestScores(info, false)).toThrow("signed 32-bit integer");
  } finally { f.close(); }
});

test("missing, mismatched and partial reads keep source zero-initialized header/record bytes", async () => {
  const f = await fixture({
    "games/empty_0.game": new Uint8Array(),
    "games/header_0.game": new Uint8Array([64]),
    "games/wrong_0.game": savedRecord([999], 63),
    "games/partial_0.game": new Uint8Array([64, 0, 0, 0, 255, 255]),
  });
  try {
    const requests: number[] = [], read = f.files.current.readInto.bind(f.files.current);
    f.files.current.readInto = (file, bytes) => { requests.push(bytes.length); return read(file, bytes); };
    f.cvars.set("ui_scoreScore2", "unchanged", true);
    for (const name of ["missing", "empty", "header", "wrong"]) {
      f.scores.loadBestScores(name, 0);
      expect(f.cvars.get("ui_scoreScore")?.value).toBe("0");
      expect(f.scores.demoAvailable).toBe(false);
    }
    expect(requests).toEqual([4, 4, 64, 4]);
    f.scores.loadBestScores("partial", 0);
    expect(f.cvars.get("ui_scoreScore")?.value).toBe("65535");
    expect(f.cvars.get("ui_scoreTeam")?.value).toBe("0 to 0");
    expect(f.cvars.get("ui_scoreTime")?.value).toBe("00:00");
    expect(f.cvars.get("ui_scoreScore2")?.value).toBe("unchanged");
  } finally { f.close(); }
});

test("score/demo paths preserve Com_sprintf bounds and NUL-terminated map names", async () => {
  const name = "x".repeat(80), scorePath = `games/${name}`.slice(0, 63), demoPath = `demos/${name}`.slice(0, 63);
  const f = await fixture({ [scorePath]: savedRecord([123]), [demoPath]: new Uint8Array(), "games/nul_0.game": savedRecord([7]) });
  try {
    f.scores.loadBestScores(name, 4);
    expect(f.cvars.get("ui_scoreScore")?.value).toBe("123");
    expect(f.scores.demoAvailable).toBe(true);
    expect(f.prints).toEqual(["Com_sprintf: overflow of 93 in 64\n", "Com_sprintf: overflow of 94 in 64\n"]);
    f.scores.loadBestScores("nul\0ignored", 0);
    expect(f.cvars.get("ui_scoreScore")?.value).toBe("7");
  } finally { f.close(); }
});

test("clearing writes separate size/record chunks through actual product handles and skips failed opens", async () => {
  const old = savedRecord([123]), f = await fixture({
    "games/good_4.game": old, "games/fail_4.game": old, "games/ignore.txt": old, "demos/good_4.dm_68": new Uint8Array(),
  }, true);
  try {
    f.scores.loadBestScores("good", 4);
    f.cvars.set("ui_scoreScore2", "keep", true);
    const archive = readFileSync(join(f.root, "missionpack", "pak0.pk3"));
    mkdirSync(join(f.home, "missionpack", "games", "fail_4.game"), { recursive: true });
    const writes: string[] = [], opened: string[] = [], open = f.files.writable.openBinaryWrite.bind(f.files.writable);
    f.files.writable.openBinaryWrite = path => {
      const file = open(path); opened.push(`${path}:${file === null ? "failed" : "open"}`);
      if (file !== null) {
        const write = file.writeBytes.bind(file);
        file.writeBytes = bytes => { writes.push(`${path}:${bytes.length}`); return write(bytes); };
      }
      return file;
    };
    f.scores.clearScores();
    expect(new Set(opened)).toEqual(new Set(["games/good_4.game:open", "games/fail_4.game:failed"]));
    expect(writes).toEqual(["games/good_4.game:4", "games/good_4.game:64"]);
    expect(new Uint8Array(readFileSync(join(f.home, "missionpack", "games", "good_4.game")))).toEqual(savedRecord([]));
    expect(readFileSync(join(f.root, "missionpack", "pak0.pk3"))).toEqual(archive);
    expect(f.scores.demoAvailable).toBe(true);
    expect(f.cvars.get("ui_scoreScore")?.value).toBe("0");
    expect(f.cvars.get("ui_scoreScore2")?.value).toBe("keep");
  } finally { f.close(); }
});

test("retirement during cvar publication preserves earlier writes and the previous demo flag", async () => {
  const f = await fixture({ "demos/map_0.dm_68": new Uint8Array() });
  try {
    f.scores.loadBestScores("map", 0);
    expect(f.scores.demoAvailable).toBe(true);
    f.cvars.set("ui_scoreImpressives", "keep", true);
    const set = f.cvars.set.bind(f.cvars), writes: string[] = [];
    f.cvars.set = (name, value, force) => { writes.push(name); const result = set(name, value, force); f.retire(); return result; };
    expect(() => f.scores.loadBestScores("absent", 0)).toThrow("retired score owner");
    expect(writes).toEqual(["ui_scoreAccuracy"]);
    expect(f.cvars.get("ui_scoreImpressives")?.value).toBe("keep");
    expect(f.scores.demoAvailable).toBe(true);
  } finally { f.close(); }
});

test("postgame saves winning record bytes before overrides, publishes both displays and opens the actual menu", async () => {
  const old = savedRecord([500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200]);
  const f = await postgameFixture({ "games/map_4.game": old });
  try {
    infoSlot(f.game.mapList, 0).timeToBeat[4] = 120;
    f.cvars.set("ui_matchStartTime", "1000", true); f.cvars.set("g_spSkill", "3.9", true);
    const restored = ["capturelimit", "fraglimit", "cg_drawTimer", "g_doWarmup", "g_Warmup", "sv_pure", "g_friendlyFire"];
    const saved = ["ui_saveCaptureLimit", "ui_saveFragLimit", "ui_drawTimer", "ui_doWarmup", "ui_Warmup", "ui_pure", "ui_friendlyFire"];
    saved.forEach((name, index) => f.cvars.set(name, `${index + 10}`, true));
    const trace: string[] = [], open = f.files.writable.openBinaryWrite.bind(f.files.writable), set = f.cvars.set.bind(f.cvars);
    f.files.writable.openBinaryWrite = path => {
      trace.push(`open:${path}`); const file = open(path);
      if (file !== null) {
        const write = file.writeBytes.bind(file), close = file.close.bind(file);
        file.writeBytes = bytes => { trace.push(`write:${bytes.length}`); return write(bytes); };
        file.close = () => { trace.push("close"); close(); };
      }
      return file;
    };
    f.cvars.set = (name, value, force) => {
      trace.push(name); expect(force).toBe(true);
      return set(name, value, force);
    };
    const set2 = f.cvars.set2.bind(f.cvars);
    function observedSet2(name: CvarStringInput | null, value: CvarStringInput, force?: boolean): CvarReference;
    function observedSet2(name: CvarStringInput | null, value: CvarStringInput | null, force?: boolean): CvarReference | undefined;
    function observedSet2(name: CvarStringInput | null, value: CvarStringInput | null, force?: boolean): CvarReference | undefined {
      if (name === "postgame_open") { trace.push(name); expect(force).toBe(true); expect(f.postgame.soundHighScore).toBe(true); }
      return set2(name, value, force);
    }
    f.cvars.set2 = observedSet2;
    await f.calculate(undefined, 2147483640);
    expect(new Uint8Array(readFileSync(join(f.home, "missionpack/games/map_4.game")))).toEqual(
      savedRecord([2400, 8, 0, 1, 42, 1, 2, 3, 4, 5, 2, 60, 600, 100, 3, 100]));
    expect(trace).toEqual(["open:games/map_4.game", "write:4", "write:64", "close", ...restored,
      ...fields.map(field => `ui_score${field}`), ...fields.map(field => `ui_score${field}2`),
      "cg_cameraOrbit", "cg_thirdPerson", "sv_killserver", "postgame_open"]);
    expect(restored.map(name => f.cvars.get(name)?.value)).toEqual(["10", "11", "12", "13", "14", "15", "16"]);
    expect([f.cvars.get("ui_scoreScore")?.value, f.cvars.get("ui_scoreScore2")?.value]).toEqual(["2400", "2400"]);
    expect([f.postgame.newHighScoreTime, f.postgame.newBestTime]).toEqual([-2147463656, -2147463656]);
    expect(f.runtime.snapshot().focusedMenu).toBe("endofgame");
    const endofgame = f.runtime.snapshot().menus.find(menu => menu.name === "endofgame");
    if (endofgame === undefined) throw new Error("Missing fixture postgame menu");
    expect(endofgame.flags & UiWindowFlag.Visible).not.toBe(0);
    expect(f.graphics.keys.getCatcher()).toBe(KeyCatcher.Ui);
  } finally { f.close(); }
});

test("postgame loss, tie and equal score do not save; failed writes still publish high status", async () => {
  const f = await postgameFixture({ "games/map_4.game": savedRecord([100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200]) });
  try {
    f.cvars.set("g_spSkill", "0", true); f.cvars.set("ui_matchStartTime", "1000", true);
    for (const args of ["0 0 0 0 0 0 900 0 1 2 61000", "0 0 0 0 0 0 900 0 2 2 61000", "0 0 0 0 0 0 100 0 3 2 61000"]) {
      await f.calculate(args);
      expect(existsSync(join(f.home, "missionpack/games/map_4.game"))).toBe(false);
      expect(f.postgame.soundHighScore).toBe(false);
      expect(f.postgame.newHighScoreTime).toBe(0);
      expect(f.postgame.newBestTime).toBe(21000);
    }
    mkdirSync(join(f.home, "missionpack/games/map_4.game"), { recursive: true });
    await f.calculate("0 0 0 0 0 0 900 0 3 2 61000", 2000);
    expect(f.postgame.soundHighScore).toBe(true); expect(f.postgame.newHighScoreTime).toBe(22000);
    expect(f.cvars.get("ui_scoreScore2")?.value).toBe("900");
    expect(f.runtime.snapshot().focusedMenu).toBe("endofgame");
  } finally { f.close(); }
});

test("postgame retains QVM atoi, float32 cancellation, overflow and physical map bounds", async () => {
  const f = await postgameFixture();
  try {
    f.cvars.set("ui_matchStartTime", "16777216", true); f.cvars.set("g_spSkill", "2.9", true);
    f.ui.writeInteger("ui_currentMap", 127);
    infoSlot(f.game.mapList, 127).timeToBeat[4] = 2147483647;
    await f.calculate("4294967297suffix 0 0 0 0 0 2147483647 0 1 2 16777217 0");
    expect(f.cvars.get("ui_scoreAccuracy")?.value).toBe("1%");
    expect(f.cvars.get("ui_scoreTime")?.value).toBe("00:00");
    expect(f.cvars.get("ui_scoreTimeBonus")?.value).toBe("-10");
    expect(f.cvars.get("ui_scoreScore")?.value).toBe("-22");
    f.ui.writeInteger("ui_currentMap", 128);
    await expect(f.calculate()).rejects.toThrow("map read outside source 128-entry array");
    f.ui.writeInteger("ui_currentMap", 0); await f.load("map", "16");
    await expect(f.calculate()).rejects.toThrow("time read outside source 16-entry array");
    await f.load(); f.cvars.set("ui_matchStartTime", "NaN", true); f.cvars.set("g_spSkill", "NaN", true);
    await f.calculate("0 0 0 0 0 0 7 0 0 0 0");
    expect(f.cvars.get("ui_scoreSkillBonus")?.value).toBe("1");
    expect(f.cvars.get("ui_scoreScore")?.value).toBe("7");
  } finally { f.close(); }
});

test("postgame merges short old records and stops at retirement after the reached restore", async () => {
  const f = await postgameFixture({ "games/map_4.game": new Uint8Array([64, 0, 0, 0, 255, 255]) });
  try {
    f.cvars.set("g_spSkill", "1", true);
    await f.calculate("0 0 0 0 0 0 200 0 1 0 60000 0");
    expect(f.postgame.soundHighScore).toBe(false);
    expect(existsSync(join(f.home, "missionpack/games/map_4.game"))).toBe(false);
    f.cvars.set("ui_saveCaptureLimit", "7".repeat(1100), true);
    const set = f.cvars.set.bind(f.cvars), writes: string[] = [];
    f.cvars.set = (name, value, force) => {
      writes.push(name); const result = set(name, value, force); if (name === "capturelimit") f.retire(); return result;
    };
    await expect(f.calculate()).rejects.toThrow("retired score owner");
    expect(writes).toEqual(["capturelimit"]);
    expect(f.cvars.get("capturelimit")?.value).toBe("7".repeat(1023));
  } finally { f.close(); }
});

test("Team Arena menu controller preserves source catcher and menu transition behavior", async () => {
  const f = await postgameFixture();
  try {
    await f.menus.setActiveMenu(UiMenuCommand.Main);
    expect(f.runtime.snapshot().focusedMenu).toBe("main");
    await f.menus.setActiveMenu(UiMenuCommand.Team);
    expect(f.runtime.snapshot().focusedMenu).toBe("team");
    const main = f.runtime.snapshot().menus.find(menu => menu.name === "main");
    if (main === undefined) throw new Error("Missing fixture main menu");
    expect(main.flags & UiWindowFlag.Visible).not.toBe(0);
    const before = f.runtime.snapshot();
    await f.menus.setActiveMenu(UiMenuCommand.NeedCd); await f.menus.setActiveMenu(UiMenuCommand.BadCdKey);
    expect(f.runtime.snapshot()).toEqual(before);
    f.cvars.set("com_errorMessage", "fixture error", true);
    await f.menus.setActiveMenu(UiMenuCommand.Main);
    expect(f.runtime.snapshot().focusedMenu).toBe("error_popmenu");
    f.cvars.set("ui_singlePlayerActive", "1", true); f.ui.update();
    await f.menus.setActiveMenu(UiMenuCommand.Main);
    expect(f.runtime.snapshot().focusedMenu).toBe("main"); expect(f.cvars.get("com_errorMessage")?.value).toBe("");
    await f.menus.setActiveMenu(UiMenuCommand.InGame);
    expect(f.cvars.get("cl_paused")?.value).toBe("1"); expect(f.players.playerNames[0]).toBe("Player");
    expect(f.players.playerCount).toBe(1); expect(f.runtime.snapshot().focusedMenu).toBe("ingame");
    f.graphics.keys.setCatcher(KeyCatcher.Ui | KeyCatcher.Console | KeyCatcher.Cgame);
    await f.menus.setActiveMenu(UiMenuCommand.None);
    expect(f.graphics.keys.getCatcher()).toBe(KeyCatcher.Console | KeyCatcher.Cgame);
    expect(f.cvars.get("cl_paused")?.value).toBe("0");
    expect(f.runtime.snapshot().menus.every(menu => (menu.flags & UiWindowFlag.Visible) === 0)).toBe(true);
  } finally { f.close(); }
});

test("Team Arena input uses focused menu keys, source escape release and clamped display coordinates", async () => {
  const f = await postgameFixture();
  try {
    await f.menus.setActiveMenu(UiMenuCommand.Main);
    expect(f.menus.isFullscreen()).toBe(true);
    await f.menus.mouseEvent(20, 20);
    await f.menus.setActiveMenu(UiMenuCommand.Team);
    await f.menus.keyEvent(KEY_CHAR_FLAG | KeyCode.Escape, true);
    expect(f.cvars.get("closed_by_escape")).toBeUndefined();
    await f.menus.keyEvent(KeyCode.Escape, true);
    expect(f.cvars.get("closed_by_escape")?.value).toBe("team");
    expect(f.runtime.snapshot().focusedMenu).toBe("team");
    await f.menus.setActiveMenu(UiMenuCommand.InGame);
    expect(f.menus.isFullscreen()).toBe(false);
    await f.menus.keyEvent(KeyCode.Escape, false);
    expect(f.runtime.snapshot().focusedMenu).toBe("ingame");
    await f.menus.keyEvent(KeyCode.Escape, true);
    expect(f.runtime.snapshot().focusedMenu).toBeUndefined();
    expect(f.cvars.get("cl_paused")?.value).toBe("1");
    f.graphics.keys.setCatcher(KeyCatcher.Ui | KeyCatcher.Console);
    await f.menus.keyEvent(KeyCode.Space, true);
    expect(f.cvars.get("cl_paused")?.value).toBe("0");
    expect(f.graphics.keys.getCatcher()).toBe(KeyCatcher.Console);
    await f.menus.pause(true);
    expect(f.graphics.keys.getCatcher()).toBe(KeyCatcher.Ui);
    expect(f.cvars.get("cl_paused")?.value).toBe("1");
    await f.menus.pause(false);
    expect(f.graphics.keys.getCatcher()).toBe(0);
    await f.menus.mouseEvent(700, -30);
    expect([f.menus.cursorX, f.menus.cursorY]).toEqual([640, 0]);
    await f.menus.mouseEvent(-100, 500);
    expect([f.menus.cursorX, f.menus.cursorY]).toEqual([540, 480]);
    f.runtime.resetDefinitions("menus");
    await f.menus.pause(true);
    await f.menus.keyEvent(KeyCode.Space, true);
    expect(f.cvars.get("cl_paused")?.value).toBe("1");
    await f.menus.mouseEvent(-600, -600);
    expect([f.menus.cursorX, f.menus.cursorY]).toEqual([0, 0]);
  } finally { f.close(); }
});
