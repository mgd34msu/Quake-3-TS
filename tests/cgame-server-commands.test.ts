import { HunkArena } from "../src/core/hunk.ts";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { decodeWav } from "../src/assets/wav.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { ClientServerCommandRuntime } from "../src/cgame/server-commands.ts";
import type { ClientServerCommandCvar, ClientServerCommandHost } from "../src/cgame/server-commands.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ClientInfoStore } from "../src/cgame/players.ts";
import { SnapshotRuntime } from "../src/cgame/snapshots.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { tokenizeCommand } from "../src/core/text.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import type { SceneModel } from "../src/render/ref-entity.ts";
import { GameType, Team } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";

function at<T>(array: readonly T[], index: number): T { const value = array[index]; if (value === undefined) throw new Error(`Missing fixture index ${index}`); return value; }
function unavailable(): never { throw new Error("Unexpected external fixture service"); }
function pcm(sample: number): PcmSound { return { sampleRate: 22050, channels: 1, samples: new Int16Array([sample]), frameCount: 1, loopStart: null }; }
function fixture(product: Product = "baseq3") {
  const state = new ClientGameState(product, 0, 0), staticState = new ClientGameStaticState(product);
  state.time = 1234;
  state.snap = { messageNumber: 1, serverTime: 1234, serverCommandNumber: 0, deltaNumber: -1, flags: 0,
    playerState: createPlayerState(product), entities: [], areaMask: new Uint8Array(32), parseEntitiesNumber: 0 };
  const cvars = new CvarRegistry();
  const defaults: [ClientServerCommandCvar, string][] = [["cg_teamChatHeight", "8"], ["cg_teamChatTime", "3000"], ["cg_teamChatsOnly", "0"],
    ["cg_showmiss", "0"], ["ui_singlePlayerActive", "0"], ["ui_recordSPDemo", "0"], ["ui_recordSPDemoName", ""], ["com_buildScript", "0"],
    ["cg_noVoiceChats", "0"], ["cg_noVoiceText", "0"], ["cg_noTaunt", "0"]];
  for (const [name, value] of defaults) cvars.register(name, value);
  const calls: string[] = [], printed: string[] = [], configs = new Map<number, string>(), commands = new Map<number, readonly string[]>();
  let activeConfigs = new Map<number, string>();
  const files = new Map<string, Uint8Array>(), sounds = new Map<string, PcmSound | null>();
  const policy: { model: Promise<SceneModel> | null; sound: Promise<PcmSound | null> | null } = { model: null, sound: null };
  const assets = { has: (path: string) => files.has(path), read: async (path: string) => {
    calls.push(`read:${path}`); const data = files.get(path); if (data === undefined) throw new Error(`Missing fixture file ${path}`); return data;
  }, readSync: (path: string) => {
    calls.push(`readSync:${path}`); const data = files.get(path); if (data === undefined) throw new Error(`Missing fixture file ${path}`); return data;
  }, list: () => [...files.keys()] };
  const resources = { registerModel: async (path: string) => { calls.push(`model:${path}`); return policy.model === null ? DEFAULT_MODEL : await policy.model; }, registerSkin: unavailable };
  const clients = new ClientInfoStore({ state, assets, resources,
    settings: () => ({ gameType: staticState.gameType, maxClients: 64, forceModel: false, model: "sarge", headModel: "sarge", redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false, buildScript: false, loading: true }),
    memoryRemaining: () => 1000000, registerShaderNoMip: unavailable, registerSound: unavailable, sound: unavailable,
    print: text => printed.push(text) }, staticState.clientInfo);
  const host: ClientServerCommandHost = { state, staticState, clients, assets, resources, random: new GameRandom(1),
    resetPlayerEntity: entity => { calls.push(`reset-player:${entity.currentState.number}`); },
    getServerCommand: sequence => { calls.push(`command:${sequence}`); return commands.get(sequence) ?? null; },
    refreshGameState: () => { calls.push("gamestate"); activeConfigs = new Map(configs); }, configString: index => activeConfigs.get(index) ?? "",
    readVmCvar: name => { const value = cvars.get(name); if (value === undefined) throw new Error(`Missing VM cvar ${name}`); return value; },
    setCvar: (name, value) => { calls.push(`cvar:${name}=${value}`); cvars.set(name, value, true); },
    print: text => printed.push(text), centerPrint: (text, y, width) => { calls.push(`center:${y}:${width}:${text}`); },
    sendConsoleCommand: text => { calls.push(`console:${text}`); }, sound: name => { calls.push(`sound:${name}`); return pcm(1); },
    registerSound: async (path, compressed) => { calls.push(`register:${compressed}:${path}`); return policy.sound === null ? sounds.get(path) ?? null : await policy.sound; },
    startLocalSound: (sound, channel) => { calls.push(`local:${channel}:${sound === null ? "null" : sound.samples[0]}`); },
    startBackgroundTrack: async (intro, loop) => { calls.push(`music:${intro}:${loop}`); },
    remapShader: async (original, replacement, offset) => { calls.push(`remap:${original}:${replacement}:${offset}`); },
    clearLocalEntities: () => { calls.push("clear-local"); }, clearMarks: () => { calls.push("clear-marks"); }, clearParticles: () => { calls.push("clear-particles"); },
    clearLoopingSounds: all => { calls.push(`clear-loops:${all}`); }, setScoreSelection: () => { calls.push("score-selection"); },
    showResponseHead: async () => { calls.push("response-head"); }, memoryRemaining: () => 1000000 };
  const runtime = new ClientServerCommandRuntime(host);
  const setConfig = (index: number, value: string) => { configs.set(index, value); host.refreshGameState(); };
  return { state, staticState, clients, cvars, calls, printed, configs, setConfig, commands, files, sounds, policy, host, runtime,
    run: (text: string) => runtime.executeCommand(tokenizeCommand(text)),
    file: (path: string, text: string) => files.set(path, Uint8Array.from(text, character => character.charCodeAt(0))) };
}

describe("received commands against untouched cg_servercmds.c fixtures", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) test(`${product} score rows, clamp and client-info writes match native output`, async () => {
    const f = fixture(product); f.clients.clientInfo(3).team = Team.TEAM_BLUE; f.clients.clientInfo(0).team = Team.TEAM_RED;
    await f.run("scores 2 17 -8 3 42 -1 9 7 5 81 1 2 3 4 5 1 6 99 -4 999 12 0 128 10 0 0 0 0 0 0 0");
    expect(f.state.teamScores).toEqual([17, -8]);
    expect(at(f.state.scores, 0)).toEqual({ client: 3, score: 42, ping: -1, time: 9, scoreFlags: 7, accuracy: 81,
      impressiveCount: 1, excellentCount: 2, guantletCount: 3, defendCount: 4, assistCount: 5, perfect: 1, captures: 6, team: 2 });
    expect(at(f.state.scores, 1)).toEqual({ client: 0, score: -4, ping: 999, time: 12, scoreFlags: 0, accuracy: 10,
      impressiveCount: 0, excellentCount: 0, guantletCount: 0, defendCount: 0, assistCount: 0, perfect: 0, captures: 0, team: 1 });
    expect(f.clients.clientInfo(3).powerups).toBe(5); expect(f.clients.clientInfo(0).powerups).toBe(128);
    expect(f.calls.includes("score-selection")).toBe(product === "missionpack");
    await f.run("scores 99 0 0"); expect(f.state.numScores).toBe(64); expect(at(f.state.scores, 63).score).toBe(0);
    await f.run("scores -1 7 8"); expect(f.state.numScores).toBe(-1); expect(at(f.state.scores, 0).team).toBe(0);
  });
  test("native teaminfo values and explicit undefined-source array bounds", async () => {
    const f = fixture(); await f.run("tinfo 2 3 9 87 25 5 16 0 -2 -9 0 2 1");
    const info = f.clients.clientInfo(3);
    expect([f.state.sortedTeamPlayers[0], info.location, info.health, info.armor, info.curWeapon, info.powerups]).toEqual([3, 9, 87, 25, 5, 16]);
    await expect(f.run("tinfo 9")).rejects.toThrow("TEAM_MAXOVERLAY");
    await expect(fixture().run("tinfo 1 -1")).rejects.toThrow("outside");
    await expect(fixture().run("tinfo 1 64")).rejects.toThrow("outside");
  });
  test("native word wrap carries colors, retains double caret and ring positions", () => {
    const f = fixture(); f.cvars.set("cg_teamChatHeight", "3");
    f.runtime.addToTeamChat(`^1${"a".repeat(75)} hello ^2there everyone`);
    expect(f.staticState.teamChatMsgs.slice(0, 2)).toEqual([`^1${"a".repeat(75)}`, "^1hello ^2there everyone"]);
    expect(f.staticState.teamChatMsgTimes.slice(0, 2)).toEqual([1234, 1234]);
    f.runtime.addToTeamChat("^^double^3color"); expect(f.staticState.teamChatMsgs[2]).toBe("^^double^3color");
    f.runtime.addToTeamChat("fourth"); expect([f.staticState.teamChatPos, f.staticState.teamLastChatPos]).toEqual([4, 1]);
    expect(f.staticState.teamChatMsgs[0]).toBe("fourth");
    f.cvars.set("cg_teamChatTime", "0"); f.runtime.addToTeamChat("disabled");
    expect([f.staticState.teamChatPos, f.staticState.teamLastChatPos]).toEqual([0, 0]);
    expect(() => { f.cvars.set("cg_teamChatTime", "1"); f.runtime.addToTeamChat("^1".repeat(121)); }).toThrow("color-expanded");
  });
});

describe("source configstrings and command dispatch", () => {
  test("shipped base and Team Arena center commands retain their distinct folded coordinates", async () => {
    const base = fixture(), mission = fixture("missionpack");
    await base.run('cp "message"'); await mission.run('cp "message"');
    expect(base.calls).toEqual(["center:143:16:message"]); expect(mission.calls).toEqual(["center:144:16:message"]);
  });
  test("Info_ValueForKey uses first ASCII-insensitive duplicate and source byte length", () => {
    expect(infoValueForKey("\\Name\\first\\name\\last", "NAME")).toBe("first");
    expect(infoValueForKey("\\\xc4\\upper\\\xe4\\lower", "\xe4")).toBe("lower");
    expect(infoValueForKey("\\x\\yes\0\\x\\no", "x")).toBe("yes");
    expect(infoValueForKey("\\dangling", "dangling")).toBe("");
    expect(infoValueForKey(`\\x\\${"\xff".repeat(1020)}`, "x", 1024)).toHaveLength(1020);
    expect(() => infoValueForKey("x".repeat(8192), "x")).toThrow("oversize");
    expect(() => infoValueForKey("\\x\\\u0100", "x")).toThrow("byte");
  });
  test("serverinfo publishes canonical state and source truncation; initial flags do not announce warmup", () => {
    const f = fixture("missionpack");
    f.setConfig(0, "\\G_GAMETYPE\\4\\g_gametype\\0\\dmflags\\3\\teamflags\\7\\fraglimit\\20\\capturelimit\\8\\timelimit\\15\\sv_maxclients\\64\\mapname\\q3ctf1\\g_redTeam\\Stroggs\\g_blueTeam\\Pagans");
    f.runtime.parseServerInfo(); expect(f.staticState.gameType).toBe(GameType.GT_CTF);
    expect([f.staticState.dmFlags, f.staticState.teamFlags, f.staticState.fraglimit, f.staticState.capturelimit, f.staticState.timelimit, f.staticState.maxclients]).toEqual([3, 7, 20, 8, 15, 64]);
    expect(f.staticState.mapname).toBe("maps/q3ctf1.bsp"); expect(f.cvars.get("g_redTeam")?.value).toBe("Stroggs");
    f.setConfig(23, "12"); f.setConfig(5, "4000"); f.setConfig(6, "10"); f.setConfig(7, "-9"); f.setConfig(21, "123");
    f.runtime.setConfigValues(); expect([f.staticState.redflag, f.staticState.blueflag, f.state.warmup, f.staticState.scores1, f.staticState.scores2, f.staticState.levelStartTime]).toEqual([1, 2, 4000, 10, -9, 123]);
    expect(f.calls.some(call => call.startsWith("local:"))).toBe(false);
  });
  test("config changes update votes, warmup transitions, models and sounds in source order", async () => {
    const f = fixture("missionpack"); f.staticState.gameType = GameType.GT_CTF;
    for (const [index, value] of [[5, "1000"], [8, "20"], [9, "map q3dm1"], [10, "3"], [11, "2"], [12, "7"], [15, "leader 1"], [17, "9"], [18, "4"], [22, "-1"]] satisfies [number, string][]) {
      f.configs.set(index, value); await f.run(`cs ${index}`);
    }
    expect(f.state.warmupCount).toBe(-1); expect(f.calls).toContain("sound:countPrepareTeamSound");
    expect([f.staticState.voteTime, f.staticState.voteYes, f.staticState.voteNo, f.staticState.voteModified]).toEqual([20, 3, 2, true]);
    expect(f.staticState.teamVoteTime).toEqual([7, 0]); expect(f.staticState.teamVoteString).toEqual(["", "leader 1"]);
    expect(f.staticState.teamVoteYes).toEqual([0, 9]); expect(f.staticState.teamVoteNo).toEqual([4, 0]); expect(f.state.intermissionStarted).toBe(true);
    f.configs.set(34, "models/item.md3"); await f.run("cs 34"); expect(f.staticState.gameModels[2]).toBe(DEFAULT_MODEL);
    const sound = pcm(17); f.sounds.set("beep.wav", sound); f.configs.set(290, "beep.wav"); await f.run("cs 290"); expect(f.staticState.gameSounds[2]).toBe(sound);
    f.configs.set(290, "*pain.wav"); await f.run("cs 290"); expect(f.staticState.gameSounds[2]).toBe(sound);
    await expect(f.run("cs 1024")).rejects.toThrow("bad index");
  });
  test("shader grammar stops incomplete tails and explicit remap still reports unknown", async () => {
    const f = fixture(); f.setConfig(24, "old=new:1.25@a=b:-2@incomplete=x:");
    await f.runtime.shaderStateChanged(); expect(f.calls.slice(-2)).toEqual(["remap:old:new:1.25", "remap:a:b:-2"]);
    await f.run("ReMaPsHaDeR original replacement 0"); expect(f.calls.at(-1)).toBe("remap:0:0:0");
    expect(f.printed.at(-1)).toBe("Unknown client game command: 0\n");
    await f.run("remapShader original replacement clientLevelShot"); expect(f.state.levelShot).toBe(true);
    expect(f.printed.at(-1)).toBe("Unknown client game command: 0\n");
    await f.run("remapShader original replacement loaddefered");
    expect(f.calls.at(-1)).toBe("remap:loaddefered:loaddefered:loaddefered");
    expect(f.printed.at(-1)).toBe("Unknown client game command: 0\n");
    f.setConfig(24, `${"x".repeat(64)}=y:0@`); await expect(f.runtime.shaderStateChanged()).rejects.toThrow("scratch");
  });
  test("case-sensitive dispatch, chat sanitization, mission vote audio and spectator string", async () => {
    const f = fixture("missionpack"); await f.run('print "VoTe FaIlEd."'); expect(f.calls).toContain("sound:voteFailed");
    await f.run('cp "Center"'); expect(f.calls).toContain("center:144:16:Center");
    await f.runtime.executeCommand(["tchat", `a\x19b${"c".repeat(200)}`]); expect(f.printed.at(-1)).toBe(`ab${"c".repeat(146)}\n`);
    f.cvars.set("cg_teamChatsOnly", "1"); const size = f.printed.length; await f.run('chat "hidden"'); expect(f.printed).toHaveLength(size);
    await f.run("SCORES 0"); expect(f.printed.at(-1)).toBe("Unknown client game command: SCORES\n");
    await f.run("clientLevelShot"); expect(f.state.levelShot).toBe(true);
    const info = f.clients.clientInfo(2); info.infoValid = true; info.team = Team.TEAM_SPECTATOR; info.name = "Spec";
    f.runtime.buildSpectatorString(); expect(f.state.spectatorList).toBe("Spec     "); expect(f.state.spectatorWidth).toBe(-1);
    f.state.spectatorWidth = 5; info.name = "Next"; f.runtime.buildSpectatorString(); expect(f.state.spectatorWidth).toBe(5);
    f.configs.set(546, ""); await f.run("cs 546"); expect(info.infoValid).toBe(false); expect(f.state.spectatorList).toBe("");
  });
  test("restart resets only source state and orders music, loops, fight and demo actions", async () => {
    const f = fixture("missionpack"); f.state.fraglimitWarnings = 7; f.state.timelimitWarnings = 3; f.state.intermissionStarted = true; f.staticState.voteTime = 20;
    f.state.killerName = "retained"; f.setConfig(2, '"music/intro.wav" music/loop.wav'); f.calls.length = 0;
    f.cvars.set("cg_showmiss", "1"); f.cvars.set("ui_singlePlayerActive", "1"); f.cvars.set("ui_recordSPDemo", "1"); f.cvars.set("ui_recordSPDemoName", "demo");
    await f.run("map_restart");
    expect(f.calls).toEqual(["clear-local", "clear-marks", "clear-particles", "music:music/intro.wav:music/loop.wav", "clear-loops:true", "sound:countFightSound", "local:7:1", "center:120:64:FIGHT!", "cvar:ui_matchStartTime=1234", "console:set g_synchronousclients 1 ; record demo \n", "cvar:cg_thirdPerson=0"]);
    expect([f.state.fraglimitWarnings, f.state.timelimitWarnings, f.staticState.voteTime]).toEqual([0, 0, 0]);
    expect(f.state.mapRestart).toBe(true); expect(f.state.intermissionStarted).toBe(false); expect(f.state.killerName).toBe("retained");
  });
});

describe("awaited reliable command ownership", () => {
  test("both source deferred-player paths forward the current presenter callback", async () => {
    const f = fixture(), cent = f.state.entityAt(3);
    cent.currentState.number = 3;
    const runtime = new ClientServerCommandRuntime({ ...f.host, clients: {
      clientInfo: index => f.clients.clientInfo(index), newClientInfo: (index, config) => f.clients.newClientInfo(index, config),
      reset: () => f.clients.reset(), loadDeferredPlayers: async resetPlayerEntity => { resetPlayerEntity(cent); },
    } });
    await runtime.executeCommand(["loaddefered"]);
    await runtime.executeCommand(["remapShader", "original", "replacement", "loaddefered"]);
    expect(f.calls).toEqual(["reset-player:3", "remap:loaddefered:loaddefered:loaddefered", "reset-player:3"]);
  });

  test("media loading blocks later commands and snapshot publication at the source boundary", async () => {
    const f = fixture(); const gate = Promise.withResolvers<SceneModel>(); f.policy.model = gate.promise;
    f.configs.set(32, "blocked.md3"); f.commands.set(1, ["cs", "32"]); f.commands.set(2, ["print", "after"]);
    const initial = f.state.snap; if (initial === null) throw new Error("Missing fixture snapshot"); f.state.snap = null;
    const snapshots = new SnapshotRuntime(f.state, { source: { current: () => ({ number: 1, serverTime: 1234 }), read: () => null }, demoPlayback: false, noPredict: false, synchronousClients: false,
      executeServerCommands: sequence => f.runtime.executeNewServerCommands(sequence), respawn: () => { f.calls.push("respawn"); },
      resetPlayerEntity: unavailable, checkEvents: unavailable, transitionPlayerState: unavailable, lagometerSnapshot: unavailable, warn: unavailable });
    const work = snapshots.setInitialSnapshot({ ...initial, serverCommandNumber: 2 });
    await Promise.resolve(); await Promise.resolve();
    expect(f.staticState.serverCommandSequence).toBe(1); expect(f.printed).not.toContain("after"); expect(f.calls).not.toContain("respawn");
    gate.resolve(DEFAULT_MODEL); await work;
    expect(f.staticState.serverCommandSequence).toBe(2); expect(f.printed).toContain("after"); expect(f.calls.at(-1)).toBe("respawn");
    await f.runtime.executeNewServerCommands(1); expect(f.calls.filter(call => call.startsWith("command:"))).toEqual(["command:1", "command:2"]);
  });
  test("concurrent batches serialize, claimed commands advance and failures remain terminal", async () => {
    const f = fixture(); f.commands.set(2, ["print", "two"]); f.commands.set(3, ["tinfo", "9"]); f.commands.set(4, ["print", "must not execute"]);
    await Promise.all([f.runtime.executeNewServerCommands(1), f.runtime.executeNewServerCommands(2)]);
    expect(f.staticState.serverCommandSequence).toBe(2); expect(f.printed).toEqual(["two"]);
    await expect(f.runtime.executeNewServerCommands(4)).rejects.toThrow("TEAM_MAXOVERLAY");
    expect(f.staticState.serverCommandSequence).toBe(3);
    await expect(f.runtime.executeNewServerCommands(4)).rejects.toThrow("TEAM_MAXOVERLAY"); expect(f.printed).toEqual(["two"]);
  });
  test("disposal blocks delayed publication and owns queued argv independently", async () => {
    const f = fixture(); const gate = Promise.withResolvers<SceneModel>(); f.policy.model = gate.promise;
    f.configs.set(32, "pending.md3"); const work = f.run("cs 32");
    const argv = ["print", "owned"]; const queued = f.runtime.executeCommand(argv); argv[1] = "mutated";
    const rejected = Promise.all([work, queued].map(promise => promise.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : "unexpected error")));
    await Promise.resolve(); await Promise.resolve(); f.runtime.dispose(); gate.resolve(DEFAULT_MODEL);
    expect(await rejected).toEqual(["Cgame command runtime is closed", "Cgame command runtime is closed"]); expect(f.printed).toEqual([]);
    const g = fixture(); const command = ["print", "owned"]; const copy = g.runtime.executeCommand(command); command[1] = "mutated"; await copy; expect(g.printed).toEqual(["owned"]);
  });
  test("disposal during command acquisition blocks immediate dispatch and further sequence acquisition", async () => {
    const commands: (readonly string[] | null)[] = [["cp", "late center"], ["print", "late print"], ["clientLevelShot"], null];
    for (const command of commands) {
      const f = fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<readonly string[] | null>();
      f.host.getServerCommand = sequence => { f.calls.push(`command:${sequence}`); entered.resolve(); return gate.promise; };
      const work = f.runtime.executeNewServerCommands(2);
      await entered.promise; f.runtime.dispose(); gate.resolve(command);
      await expect(work).rejects.toThrow("Cgame command runtime is closed");
      expect(f.staticState.serverCommandSequence).toBe(1); expect(f.calls).toEqual(["command:1"]);
      expect(f.printed).toEqual([]); expect(f.state.levelShot).toBe(false);
    }
  });
});

describe("Team Arena voice files and source queue", () => {
  test("real VFS sees a late head file after a missing lookup and retains successful source selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quake3-headvoice-"));
    try {
      await mkdir(join(directory, "baseq3"));
      await mkdir(join(directory, "missionpack"));
      await writeFile(join(directory, "missionpack", "male.voice"), 'male id { male.wav "male" }');
      await writeFile(join(directory, "missionpack", "mapped.voice"), 'female id { mapped.wav "mapped" }');
      const assets = await VirtualFileSystem.openInspection({ dataPath: directory, homePath: directory, cdPath: null, product: "missionpack" }), f = fixture("missionpack");
      f.sounds.set("male.wav", pcm(1)); f.sounds.set("mapped.wav", pcm(2));
      const runtime = new ClientServerCommandRuntime({ ...f.host, assets });
      await runtime.parseVoiceChats("male.voice", 0); await runtime.parseVoiceChats("mapped.voice", 1);
      const info = f.clients.clientInfo(1); info.headModelName = "late"; info.headSkinName = "default"; info.gender = "male";
      await runtime.voiceChatLocal(0, false, 1, 55, "id"); await runtime.playBufferedVoiceChats();
      expect(f.printed.at(-1)).toBe(": ^7male\n");
      await mkdir(join(directory, "missionpack", "scripts", "late"), { recursive: true });
      const headFile = join(directory, "missionpack", "scripts", "late", "default.vc");
      await writeFile(headFile, "mapped.voice");
      f.state.time += 1001;
      await runtime.voiceChatLocal(0, false, 1, 55, "id"); await runtime.playBufferedVoiceChats();
      expect(f.printed.at(-1)).toBe(": ^7mapped\n");
      await writeFile(headFile, "male.voice");
      f.state.time += 1001;
      await runtime.voiceChatLocal(0, false, 1, 55, "id"); await runtime.playBufferedVoiceChats();
      expect(f.printed.at(-1)).toBe(": ^7mapped\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  for (const overflow of [false, true]) test(`${overflow ? "full ring" : "timer"} playback awaits the response head before text and queue advancement`, async () => {
    const f = fixture("missionpack"), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    f.file("list", 'male getflag { voice.wav "one" }'); f.sounds.set("voice.wav", pcm(7));
    const runtime = new ClientServerCommandRuntime({ ...f.host, showResponseHead: async () => {
      f.calls.push("head:begin"); entered.resolve(); await gate.promise; f.calls.push("head:end");
    } });
    await runtime.parseVoiceChats("list", 0);
    for (let i = 0; i < (overflow ? 31 : 1); i++) await runtime.voiceChatLocal(1, false, 1, 55, "getflag");
    const work = overflow ? runtime.voiceChatLocal(1, false, 1, 55, "getflag") : runtime.playBufferedVoiceChats();
    await entered.promise;
    expect(f.calls.slice(-2)).toEqual(["local:3:7", "head:begin"]);
    expect([f.staticState.acceptTask, f.staticState.acceptLeader, f.staticState.acceptOrderTime]).toEqual([1, 1, 6234]);
    expect(f.printed).toEqual([]); expect(f.staticState.teamChatPos).toBe(0);
    expect([f.state.voiceChatBufferIn, f.state.voiceChatBufferOut, f.state.voiceChatTime]).toEqual([overflow ? 0 : 1, 0, 0]);
    gate.resolve(); await work;
    expect(f.calls.at(-1)).toBe("head:end"); expect(f.printed).toEqual(["(): ^7one\n"]);
    expect([f.state.voiceChatBufferOut, f.state.voiceChatTime]).toEqual([1, overflow ? 0 : 2234]);
  });
  test("rejected response head stops reliable commands after prior sound/order mutations, before text or queue clearing", async () => {
    const f = fixture("missionpack"); f.file("list", 'male getflag { voice.wav "one" }'); f.sounds.set("voice.wav", pcm(7));
    const runtime = new ClientServerCommandRuntime({ ...f.host, showResponseHead: async () => { throw new Error("head registration failed"); } });
    await runtime.parseVoiceChats("list", 0);
    for (let i = 0; i < 31; i++) await runtime.executeCommand(["vtchat", "0", "1", "55", "getflag"]);
    await expect(runtime.executeCommand(["vtchat", "0", "1", "55", "getflag"])).rejects.toThrow("head registration failed");
    expect(f.calls).toContain("local:3:7"); expect(f.staticState.acceptTask).toBe(1);
    expect(f.state.voiceChatBufferOut).toBe(0); expect(f.printed).toEqual([]);
    await expect(runtime.executeCommand(["print", "later"])).rejects.toThrow("head registration failed");
    expect(f.printed).toEqual([]);
  });
  test("native quoted voice bytes preserve CRLF exactly", async () => {
    const f = fixture("missionpack"); f.file("quoted.voice", 'female id { tone.wav "A\r\nB" }'); f.sounds.set("tone.wav", pcm(9));
    await f.runtime.parseVoiceChats("quoted.voice", 0);
    await f.runtime.voiceChatLocal(0, false, 0, 55, "id"); await f.runtime.playBufferedVoiceChats();
    expect(f.printed.at(-1)).toBe(": ^7A\r\nB\n");
  });
  test("source signed-byte separators, quoted high bytes and token scratch limits remain distinct", async () => {
    const f = fixture("missionpack"); f.file("bytes.voice", 'male\xffid { tone.wav "A\xffB" }'); f.sounds.set("tone.wav", pcm(9));
    expect(await f.runtime.parseVoiceChats("bytes.voice", 0)).toBe(true);
    await f.runtime.voiceChatLocal(0, false, 0, 55, "id"); await f.runtime.playBufferedVoiceChats(); expect(f.printed.at(-1)).toBe(": ^7A\xffB\n");
    f.file("word.voice", `male ${"x".repeat(1024)} { tone.wav hello }`);
    expect(await f.runtime.parseVoiceChats("word.voice", 1)).toBe(true);
    f.file("quote.voice", `male "${"x".repeat(1024)}" { tone.wav hello }`);
    await expect(f.runtime.parseVoiceChats("quote.voice", 1)).rejects.toThrow("Quoted source token");
  });
  test("voice compression option is captured before file I/O, not reread after awaiting", async () => {
    const f = fixture(); f.file("list.voice", 'male id { one.wav "one" two.wav "two" }');
    const gate = Promise.withResolvers<PcmSound | null>(); f.policy.sound = gate.promise;
    const work = f.runtime.parseVoiceChats("list.voice", 0); f.cvars.set("com_buildScript", "1"); gate.resolve(pcm(1));
    expect(await work).toBe(true);
    expect(f.calls.filter(call => call.startsWith("register:"))).toEqual(["register:true:one.wav", "register:true:two.wav"]);
  });
  test("source first-use order fills only the 64-head semantic cache", async () => {
    const f = fixture("missionpack"); f.file("male", 'male id { one.wav "male" }'); f.file("mapped", 'female id { two.wav "mapped" }');
    f.sounds.set("one.wav", pcm(1)); f.sounds.set("two.wav", pcm(2));
    await f.runtime.parseVoiceChats("male", 0); await f.runtime.parseVoiceChats("mapped", 1);
    const info = f.clients.clientInfo(1); info.headSkinName = "default"; info.gender = "male";
    for (let i = 64; i >= 0; i--) {
      info.headModelName = `head${i}`; f.file(`scripts/head${i}/default.vc`, "mapped");
    }
    expect(f.printed).toEqual([]); expect(f.state.voiceChatBufferIn).toBe(0);
    for (let i = 0; i <= 64; i++) {
      info.headModelName = `head${i}`;
      expect(await f.runtime.voiceChatLocal(0, true, 1, 55, "id")).toBeUndefined();
      f.state.time += 1001; await f.runtime.playBufferedVoiceChats();
    }
    const played = f.calls.filter(call => call.startsWith("local:"));
    expect(played.slice(0, 64)).toEqual(Array.from({ length: 64 }, () => "local:3:2"));
    expect(played[64]).toBe("local:3:1");
  });
  test("oversized vc diagnostics occur only at source first use", async () => {
    const f = fixture("missionpack"); f.file("male", 'male id { one.wav "one" }'); f.sounds.set("one.wav", pcm(1));
    await f.runtime.parseVoiceChats("male", 0); f.clients.clientInfo(1).headModelName = "large"; f.clients.clientInfo(1).headSkinName = "default";
    f.file("scripts/large/default.vc", "x".repeat(16384));
    expect(f.printed).toEqual([]); await f.runtime.voiceChatLocal(0, true, 1, 55, "id");
    expect(f.printed).toEqual(["^1voice chat file too large: scripts/large/default.vc is 16384, max allowed is 16384"]);
  });
  test("native failed sound registration compacts alternatives; source64 sound break retains its closing brace", async () => {
    const f = fixture("missionpack"); f.file("fixture.voice", 'female id { tone.wav "Hello" missing.wav "skip" tone.wav "Again" }'); f.sounds.set("tone.wav", pcm(9));
    const chooser = { value: 0 };
    const runtime = new ClientServerCommandRuntime({ ...f.host, random: { random: () => chooser.value } });
    expect(await runtime.parseVoiceChats("fixture.voice", 0)).toBe(true);
    await runtime.voiceChatLocal(0, false, 0, 55, "id"); await runtime.playBufferedVoiceChats(); expect(f.printed.at(-1)).toBe(": ^7Hello\n");
    chooser.value = 0.75; f.state.time += 1001; await runtime.voiceChatLocal(0, false, 0, 55, "id"); await runtime.playBufferedVoiceChats(); expect(f.printed.at(-1)).toBe(": ^7Again\n");
    expect(f.calls.filter(call => call.startsWith("register:"))).toEqual(["register:true:tone.wav", "register:true:missing.wav", "register:true:tone.wav"]);
    f.state.time += 1001; await runtime.voiceChatLocal(0, false, 0, 256, "id"); await runtime.playBufferedVoiceChats(); expect(f.printed.at(-1)).toBe(": ^\n");
    f.file("limit.voice", `male id { ${'tone.wav "message" '.repeat(64)}}`);
    expect(await runtime.parseVoiceChats("limit.voice", 1)).toBe(false);
    expect(f.printed.at(-1)).toBe("^1expected { found  in voice chat file: limit.voice\n");
    expect(await runtime.parseVoiceChats("limit.voice", 1, 1)).toBe(true);
  });
  test("quoted/comment tokens, registered sounds, head mapping, orders and strict playback timer", async () => {
    const f = fixture("missionpack"); f.file("scripts/female1.voice", 'female // comment\ngetflag { "voice/get.wav" "Get the flag!" }');
    f.file("scripts/sarge/default.vc", '"scripts/female1.voice"'); f.sounds.set("voice/get.wav", pcm(9));
    const info = f.clients.clientInfo(1); info.name = "Commander"; info.headModelName = "*sarge"; info.headSkinName = "default";
    expect(await f.runtime.parseVoiceChats("scripts/female1.voice", 0)).toBe(true);

    await f.run("vtchat 0 1 50 getflag"); expect(f.calls).toContain("readSync:scripts/sarge/default.vc");
    await f.runtime.playBufferedVoiceChats();
    expect(f.calls).toContain("local:3:9"); expect(f.printed).toContain("(Commander): ^2Get the flag!\n");
    expect([f.staticState.acceptOrderTime, f.staticState.acceptTask, f.staticState.acceptLeader, f.staticState.acceptVoice]).toEqual([6234, 1, 1, "getflag"]);
    expect(f.calls).toContain("response-head"); expect(f.state.voiceChatTime).toBe(2234);
    await f.run("vtell 1 1 51 GETFLAG"); f.state.time = 2234; await f.runtime.playBufferedVoiceChats(); expect(f.state.voiceChatBufferOut).toBe(1);
    f.state.time++; await f.runtime.playBufferedVoiceChats(); expect(f.state.voiceChatBufferOut).toBe(2); expect(f.printed).toHaveLength(1);
    expect(f.calls.filter(call => call === "readSync:scripts/sarge/default.vc")).toHaveLength(1);
  });
  test("missing, large, malformed and partial voice files preserve source parser results", async () => {
    const f = fixture("missionpack"); expect(await f.runtime.parseVoiceChats("missing", 0)).toBe(false);
    f.file("large", "a".repeat(16384)); expect(await f.runtime.parseVoiceChats("large", 0)).toBe(false);
    f.file("gender", "alien"); expect(await f.runtime.parseVoiceChats("gender", 0)).toBe(false);
    f.file("brace", "male id nope"); expect(await f.runtime.parseVoiceChats("brace", 0)).toBe(false);
    f.file("partial", "male id { sound"); expect(await f.runtime.parseVoiceChats("partial", 0)).toBe(true);
    expect(f.printed).toEqual(["^1voice chat file not found: missing\n", "^1voice chat file too large: large is 16384, max allowed is 16384", "^1expected gender not found in voice chat file: gender\n", "^1expected { found nope in voice chat file: brace\n"]);
    f.file("scripts/female1.voice", 'male empty { missing.wav "zero" }'); await f.runtime.parseVoiceChats("scripts/female1.voice", 0);

    await f.run("vchat 0 0 55 empty"); await f.runtime.playBufferedVoiceChats();
    expect(f.state.voiceChatBufferIn).toBe(1); expect(f.state.voiceChatBufferOut).toBe(0);
  });
  test("no-taunt matching is case-sensitive; intermission suppresses queues; base voice commands are empty", async () => {
    const f = fixture("missionpack"); f.file("list", 'male taunt { voice.wav "Taunt" }'); f.sounds.set("voice.wav", pcm(3)); await f.runtime.parseVoiceChats("list", 0);

    f.cvars.set("cg_noTaunt", "1"); await f.run("vchat 0 0 55 taunt"); expect(f.state.voiceChatBufferIn).toBe(0);
    await f.run("vchat 0 0 55 TAUNT"); expect(f.state.voiceChatBufferIn).toBe(1);
    f.state.intermissionStarted = true; await f.run("vchat 0 0 55 TAUNT"); expect(f.state.voiceChatBufferIn).toBe(1);
    await f.runtime.playBufferedVoiceChats(); expect(f.state.voiceChatBufferOut).toBe(1); expect(f.calls.some(call => call.startsWith("local:"))).toBe(false);
    const base = fixture(); await base.run("vchat 0 0 55 taunt"); expect(base.printed).toEqual([]); expect(base.calls).toEqual([]);
  });
  test("full voice ring plays oldest immediately and preserves source unmodded overflow index", async () => {
    const f = fixture("missionpack"); f.file("list", 'male id { voice.wav "one" }'); f.sounds.set("voice.wav", pcm(7)); await f.runtime.parseVoiceChats("list", 0);

    for (let i = 0; i < 32; i++) await f.run("vchat 1 0 55 id");
    expect([f.state.voiceChatBufferIn, f.state.voiceChatBufferOut]).toEqual([0, 1]); expect(f.calls.filter(call => call === "local:3:7")).toHaveLength(1);
    for (let i = 0; i < 31; i++) await f.run("vchat 1 0 55 id");
    expect(f.state.voiceChatBufferOut).toBe(32);
    await expect(f.runtime.playBufferedVoiceChats()).rejects.toThrow("outside 32");
  });
});

const retailPath = process.env["Q3_DATA"];
test.skipIf(retailPath === undefined)("shipped command QVM anchors prove center coordinates and left-to-right argv aliasing", async () => {
  if (retailPath === undefined) throw new Error("Q3_DATA required");
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const assets = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product }), bytes = await assets.read("vm/cgame.qvm");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x12721444);
    const instructions: { op: number; value: number | null }[] = []; let cursor = view.getInt32(8, true);
    const count = view.getInt32(4, true); expect(count).toBeLessThan(1000000);
    for (let i = 0; i < count; i++) {
      const op = view.getUint8(cursor++); let value: number | null = null;
      if (op === 3 || op === 4 || op === 8 || op === 9 || (op >= 11 && op <= 26) || op === 34) { value = view.getInt32(cursor, true); cursor += 4; }
      else if (op === 33) value = view.getUint8(cursor++);
      instructions.push({ op, value });
    }
    expect(cursor).toBeLessThanOrEqual(view.getInt32(8, true) + view.getInt32(12, true));
    const data = bytes.subarray(view.getInt32(16, true)), pattern = new TextEncoder().encode("Unknown client game command: %s\n"), addresses: number[] = [];
    for (let i = 0; i <= data.length - pattern.length; i++) if (pattern.every((byte, j) => data[i + j] === byte)) addresses.push(i);
    const starts = new Set<number>();
    for (let i = 0; i < instructions.length; i++) {
      const item = at(instructions, i); if (item.op !== 8 || item.value === null || !addresses.includes(item.value)) continue;
      let start = i; while (start > 0 && at(instructions, start).op !== 3) start--; starts.add(start);
    }
    expect(starts.size).toBe(1); const start = starts.values().next().value; if (start === undefined) throw new Error("Missing command function anchor");
    expect(start).toBe(product === "baseq3" ? 82352 : 57747);
    expect(instructions.slice(start + 41, start + 45)).toEqual([{ op: 8, value: product === "baseq3" ? 143 : 144 }, { op: 33, value: 12 }, { op: 8, value: 16 }, { op: 33, value: 16 }]);
    const remap = start + (product === "baseq3" ? 343 : 431), getArgv = product === "baseq3" ? 519 : 527;
    for (let i = 0; i < 3; i++) expect(instructions.slice(remap + i * 6, remap + i * 6 + 6)).toEqual([
      { op: 8, value: i + 1 }, { op: 33, value: 8 }, { op: 9, value: 232 + i * 4 }, { op: 8, value: getArgv }, { op: 5, value: null }, { op: 32, value: null },
    ]);
    expect(at(instructions, remap + 27)).toEqual({ op: 8, value: -80 });
  }
});
test.skipIf(retailPath === undefined)("retail client config media and all eight Team Arena voice lists reach actual decoded PCM", async () => {
  if (retailPath === undefined) throw new Error("Q3_DATA required");
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product), assets = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product });
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images), target = new RenderTarget(images, [cpu]);
    const builtins = new BuiltinImages(images, identityImageUploadProfile);
    const cinematicMixer = new AudioMixer(22050, () => 0);
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: text => { f.printed.push(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    try {
    const resources = await RendererResources.create(assets, { kind: "unaccounted" }, createRendererSettings(),
      { patchMemory: { kind: "diagnostic" }, print: text => { f.printed.push(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    const registered = new Map<string, PcmSound | null>();
    const registerSound = async (path: string): Promise<PcmSound | null> => {
      if (registered.has(path)) { const sound = registered.get(path); if (sound === undefined) throw new Error("Missing cached sound"); return sound; }
      const sound = assets.has(path) ? decodeWav(await assets.read(path), path) : null; registered.set(path, sound); return sound;
    };
    const clients = new ClientInfoStore({ state: f.state, assets, resources,
      settings: () => ({ gameType: GameType.GT_FFA, maxClients: 64, forceModel: false, model: "sarge", headModel: "sarge", redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false, buildScript: false, loading: true }),
      memoryRemaining: () => 10000000, registerShaderNoMip: path => resources.registerShaderNoMip(path), registerSound,
      sound: path => { const sound = registered.get(path); if (sound === undefined) throw new Error(`Unprepared sound ${path}`); return sound; },
      print: text => f.printed.push(text) }, f.staticState.clientInfo);
    const runtime = new ClientServerCommandRuntime({ ...f.host, assets, resources, clients, registerSound });
    f.configs.set(545, "\\n\\Retail\\t\\0\\model\\sarge/default\\hmodel\\sarge/default\\c1\\4\\c2\\3\\hc\\100");
    await runtime.executeCommand(["cs", "545"]);
    expect(clients.clientInfo(1).infoValid).toBe(true); expect(clients.clientInfo(1).legsModel.kind).toBe("md3");
    expect(clients.clientInfo(1).sounds.some(sound => sound !== null && sound.frameCount > 0)).toBe(true);
    if (product === "missionpack") {
      await runtime.loadVoiceChats();
      clients.clientInfo(1).headModelName = "unmapped-test"; clients.clientInfo(1).headSkinName = "default"; clients.clientInfo(1).gender = "female";
      await runtime.voiceChatLocal(1, false, 1, 50, "getflag"); await runtime.playBufferedVoiceChats();
      expect(f.printed.at(-1)).toBe("(Retail): ^2Get the flag\n");
      expect(registered.get("sound/voices/female1/or_01.wav")?.frameCount).toBeGreaterThan(0);
      expect([...registered.keys()].filter(path => path.startsWith("sound/voices/")).length).toBeGreaterThan(100);
      expect(f.staticState.acceptTask).toBe(1);
    }
    f.configs.set(545, ""); await runtime.executeCommand(["cs", "545"]); expect(clients.clientInfo(1).infoValid).toBe(false);
    runtime.dispose();
    } finally { try { target.close(); } finally { cinematics.dispose(); } }
  }
});
