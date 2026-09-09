import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { ClientConsoleRuntime, clientConsoleCommandNames } from "../src/cgame/console.ts";
import type { ClientConsoleCvar, ClientConsoleHost, ClientConsoleHud, ClientConsoleTeamOrders } from "../src/cgame/console.ts";
import { ClientInfoStore } from "../src/cgame/players.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ViewRuntime } from "../src/cgame/view.ts";
import { ClientWeaponSelection } from "../src/cgame/weapons.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import type { CommandFallbackResolver, CommandHandler } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { CvarSnapshot } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { tokenizeCommand } from "../src/core/text.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import type { SceneModel } from "../src/render/ref-entity.ts";
import { GameType, PersistentIndex, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { MoveFlags } from "../src/shared/player-state.ts";
import { loadMenuDefinitions } from "../src/ui/menu.ts";
import type { UiMenuResolver } from "../src/ui/menu.ts";
import type { UiCapturedMenu } from "../src/ui/runtime.ts";

function resolveSynchronously(handler: CommandHandler): CommandFallbackResolver {
  return () => ({ kind: "sync", handler });
}

function unavailable(): never { throw new Error("Unexpected external fixture service"); }
function slot<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new Error(`Missing fixture slot ${index}`); return value; }
function emptyMap(): BspMap {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], leafSurfaces: [], leafBrushes: [],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function fixture(product: Product = "baseq3") {
  const state = new ClientGameState(product, 0, 0), staticState = new ClientGameStaticState(product);
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: state.predictedPlayerState.copy(), entities: [] };
  const cvars = new CvarRegistry(), cached = new Map<ClientConsoleCvar, CvarSnapshot>();
  for (const [name, value] of [["cg_viewsize", "95"], ["cg_cameraOrbit", "0"], ["cg_currentSelectedPlayer", "0"]] satisfies [ClientConsoleCvar, string][]) cached.set(name, cvars.register(name, value));
  const readVmCvar = (name: ClientConsoleCvar) => { const value = cached.get(name); if (value === undefined) throw new Error(`Missing cached cvar ${name}`); return value; };
  const printed: string[] = [], calls: string[] = [], clientCommands: string[] = [], consoleCommands: string[] = [], registered: string[] = [];
  const commandBuffer = new CommandBuffer({ resolveFallback: resolveSynchronously(context => { calls.push(`engine:${context.raw}`); }) });
  const prediction = new PredictionRuntime(state, new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" }), {
    commands: new ClientCommandHistory(), settings: () => ({ gameType: staticState.gameType, dmFlags: 0, demoPlayback: false,
      noPredict: false, synchronousClients: false, predictItems: true, pmoveFixed: false, pmoveMsec: 8, errorDecayInteger: 100, errorDecayValue: 100, showMiss: 0 }),
    setPmoveMsec: unavailable, transitionPlayerState: unavailable, warn: unavailable,
  });
  const policy: { model: Promise<SceneModel> | null; hud: Promise<void> | null } = { model: null, hud: null };
  const view = new ViewRuntime(state, prediction, {
    settings: unavailable, setViewSize: unavailable, setThirdPersonAngleValue: unavailable,
    registerModel: async path => { calls.push(`model:${path}`); return policy.model === null ? DEFAULT_MODEL : await policy.model; }, print: text => { printed.push(text); },
  });
  const clients = new ClientInfoStore({ state,
    assets: { has: () => false, list: () => [], read: unavailable }, resources: { registerModel: unavailable, registerSkin: unavailable },
    settings: () => ({ gameType: staticState.gameType, maxClients: 64, forceModel: false, model: "sarge", headModel: "sarge", redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false, buildScript: false, loading: true }),
    memoryRemaining: () => 1000000, registerShaderNoMip: unavailable, registerSound: unavailable, sound: unavailable, print: text => { printed.push(text); },
  }, staticState.clientInfo);
  const widgets: { menu: UiCapturedMenu | null; otherFlag: boolean; ourFlag: boolean } = { menu: null, otherFlag: false, ourFlag: false };
  const hud: ClientConsoleHud = { kind: "available", resetStrings: () => { calls.push("strings"); }, resetMenus: () => { calls.push("menus"); },
    loadMenus: async path => { calls.push(`hud:${path}`); if (policy.hud !== null) await policy.hud; }, clearScoreboard: () => { calls.push("clear-scoreboard"); widgets.menu = null; },
    menuScoreboard: () => widgets.menu, scrollFeeder: async (menu, feeder, down) => { expect(menu === widgets.menu).toBe(true); calls.push(`scroll:${feeder}:${down}`); } };
  const teamOrders: ClientConsoleTeamOrders = { kind: "available", selectNextPlayer: () => { calls.push("next-player"); }, selectPreviousPlayer: () => { calls.push("previous-player"); },
    otherTeamHasFlag: () => { calls.push("other-flag"); return widgets.otherFlag; }, yourTeamHasFlag: () => { calls.push("our-flag"); return widgets.ourFlag; } };
  const host: ClientConsoleHost = { cvars, view, weapons: new ClientWeaponSelection(state), clients, hud, teamOrders,
    serverCommands: { buildSpectatorString: () => { calls.push("spectators"); } }, readVmCvar, resetPlayerEntity: unavailable,
    addCommand: name => { registered.push(name); }, sendClientCommand: text => { clientCommands.push(text); },
    sendConsoleCommand: text => { consoleCommands.push(text); commandBuffer.append(text); }, print: text => { printed.push(text); },
    centerPrint: (text, y, width) => { calls.push(`center:${y}:${width}:${text}`); }, sound: name => { calls.push(`sound:${name}`); return null; },
    addBufferedSound: sound => { expect(sound).toBeNull(); calls.push("buffer-sound"); },
  };
  const runtime = new ClientConsoleRuntime(state, staticState, host);
  return { state, staticState, cvars, cached, printed, calls, clientCommands, consoleCommands, registered, commandBuffer, policy, widgets, host, runtime, clients,
    run: (text: string) => runtime.execute(tokenizeCommand(text)),
    cache: (name: ClientConsoleCvar, value: string) => { cached.set(name, cvars.set(name, value, true)); } };
}

describe("source cgame console dispatch", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) test(`${product} registration order and forwarding preserve source names`, async () => {
    const f = fixture(product); f.runtime.initializeCommands();
    expect(clientConsoleCommandNames(product)).toEqual(f.registered);
    expect(f.registered.length).toBe(product === "baseq3" ? 50 : 74);
    expect(f.registered.slice(0, 7)).toEqual(["testgun", "testmodel", "nextframe", "prevframe", "nextskin", "prevskin", "viewpos"]);
    expect(f.registered.slice(-5)).toEqual(["callteamvote", "teamvote", "stats", "teamtask", "loaddefered"]);
    expect(f.registered.indexOf("loaddeferred")).toBe(product === "baseq3" ? 22 : 46);
    for (const name of ["kill", "say", "vote", "callteamvote", "loaddefered", "unknown", "camera", "teamMenu"]) expect(await f.run(name)).toBe(false);
    expect(await f.run("LoAdDeFeRrEd")).toBe(true);
    expect(f.clientCommands).toEqual([]);
    if (product === "baseq3") for (const name of ["loadhud", "nextOrder", "taskOffense", "spWin"]) expect(await f.run(name)).toBe(false);
  });

  test("native tcmd fixture preserves slot-zero omission, expired -1 and three-byte atoi", async () => {
    const f = fixture(); f.state.crosshairClientNum = 0; await f.run("tcmd 12345");
    f.state.time = 1001; await f.run("tcmd 12345");
    f.state.crosshairClientNum = 7; f.state.crosshairClientTime = 1001; await f.run("tcmd 12345");
    expect(f.consoleCommands).toEqual(["gc -1 123", "gc 7 123"]);
    f.state.time = 2001; expect(f.runtime.crosshairPlayer()).toBe(7); f.state.time = 2002; expect(f.runtime.crosshairPlayer()).toBe(-1);
    f.state.crosshairClientTime = 2147483600; expect(f.runtime.crosshairPlayer()).toBe(-1);
  });

  test("native tell/vtell output uses decoded args, byte boundaries and source attacker sentinel", async () => {
    const f = fixture(); await f.run('tell_target "a quoted message"');
    const snap = f.state.snap; if (snap === null) throw new Error("Missing fixture snapshot");
    snap.playerState.persistant.set(PersistentIndex.PERS_ATTACKER, 12); await f.run("vtell_attacker ignored");
    f.state.attackerTime = 1; await f.run('vtell_attacker "a quoted message"');
    expect(f.clientCommands).toEqual(["tell 0 a quoted message", "vtell 12 a quoted message"]);
    await f.runtime.execute(["tell_target", "x".repeat(300)]); expect(slot(f.clientCommands, 2)).toBe("tell 0 " + "x".repeat(120));
    await f.runtime.execute(["vtell_target", "é%", "a\0ignored"]); expect(slot(f.clientCommands, 3)).toBe("vtell 0 é% a");
    f.state.time = 1001; await f.run("tell_target expired"); expect(f.clientCommands.length).toBe(4);
    await expect(f.runtime.execute(["tell_target", "€"])).rejects.toThrow("source byte");
    expect(await f.run("viewpos")).toBe(true);
  });

  test("source Cmd_Args buffer overflow is rejected before trap truncation", async () => {
    const f = fixture(); await expect(f.runtime.execute(["tell_target", "x".repeat(1024)])).rejects.toThrow("MAX_STRING_CHARS");
    await expect(f.run("viewpos")).rejects.toThrow("MAX_STRING_CHARS"); expect(f.clientCommands).toEqual([]);
  });

  for (const product of ["baseq3", "missionpack"] satisfies Product[]) test(`${product} native score timing fixture and held-score preservation`, async () => {
    const f = fixture(product); f.state.numScores = 9; f.state.time = 2000; await f.run("+scores");
    expect([f.state.scoresRequestTime, f.state.showScores, f.state.numScores]).toEqual([0, true, 9]);
    await f.run("-scores"); f.state.time = 2001; await f.run("+scores");
    expect([f.state.scoresRequestTime, f.state.showScores, f.state.numScores]).toEqual([2001, true, 0]);
    await f.run("-scores"); expect(f.state.scoreFadeTime).toBe(2001); f.state.time = 3000; await f.run("-scores"); expect(f.state.scoreFadeTime).toBe(2001);
    f.state.numScores = 8; f.state.showScores = true; f.state.time = 5000; await f.run("+scores"); expect(f.state.numScores).toBe(8);
    expect(f.clientCommands).toEqual(["score", "score"]); expect(f.calls).toEqual(product === "missionpack" ? ["spectators", "spectators", "spectators"] : []);
    f.state.scoresRequestTime = 2147483600; await f.run("+scores"); expect(f.state.scoresRequestTime).toBe(5000);
  });

  test("native cvar fixture preserves forced writes, cached VM values and immediate developer reads", async () => {
    const f = fixture(); f.cvars.register("cg_viewsize", "100", CvarFlag.ReadOnly); await f.run("sizeup"); expect(f.cvars.get("cg_viewsize")?.value).toBe("105");
    await f.run("sizedown"); expect(f.cvars.get("cg_viewsize")?.value).toBe("85");
    expect(f.cached.get("cg_viewsize")?.integerValue).toBe(95);
    await f.run("startOrbit"); expect(f.cvars.get("cg_thirdPerson")).toBeUndefined();
    f.cvars.set("developer", "1"); await f.run("startOrbit"); expect(f.cvars.get("cg_cameraOrbit")?.value).toBe("5");
    expect(f.cvars.get("cg_thirdPersonRange")?.value).toBe("100");
    f.cache("cg_cameraOrbit", "0.5"); f.cvars.set("cg_cameraOrbit", "0", true); await f.run("startOrbit");
    expect(f.cvars.get("cg_cameraOrbit")?.value).toBe("0"); expect(f.cvars.get("cg_thirdPerson")?.value).toBe("0");
    f.state.refdef.viewOrigin = vec3(1.9, -2.9, 3); f.state.refdefViewAngles = vec3(0, 179.8, 0); await f.run("viewpos"); expect(f.printed).toEqual(["(1 -2 3) : 179\n"]);
  });

  for (const product of ["baseq3", "missionpack"] satisfies Product[]) test(`${product} real ViewRuntime and ClientWeaponSelection receive commands`, async () => {
    const f = fixture(product); f.state.time = 700; await f.run("+zoom"); expect(f.state.zoomed).toBe(true); expect(f.state.zoomTime).toBe(700);
    f.state.time = 800; await f.run("+zoom"); expect(f.state.zoomTime).toBe(700); await f.run("-zoom"); expect(f.state.zoomTime).toBe(800);
    await f.run("testmodel models/example.md3 .25"); expect(f.state.testModelName).toBe("models/example.md3"); expect(f.state.testModelEntity.backLerp).toBe(0.25);
    await f.run("nextframe"); await f.run("prevframe"); await f.run("nextskin"); await f.run("prevskin"); await f.run("prevskin");
    expect([f.state.testModelEntity.frame, f.state.testModelEntity.skinNum]).toEqual([1, 0]);
    await f.run("testgun"); expect(f.state.testGun).toBe(true); expect(f.state.testModelEntity.frame).toBe(0);
    await f.run("testmodel other .75 ignored"); expect(f.state.testModelEntity.backLerp).toBe(0);
    const snap = f.state.snap; if (snap === null) throw new Error("Missing fixture snapshot");
    snap.playerState.stats.set(statSchema(product).weapons, (1 << Weapon.WP_GAUNTLET) | (1 << Weapon.WP_MACHINEGUN) | (1 << Weapon.WP_ROCKET_LAUNCHER));
    snap.playerState.ammo.set(Weapon.WP_MACHINEGUN, 20); snap.playerState.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 0); f.state.weaponSelect = Weapon.WP_GAUNTLET;
    await f.run("weapnext"); expect(f.state.weaponSelect).toBe(Weapon.WP_MACHINEGUN);
    await f.run("weapon 5"); expect(f.state.weaponSelect).toBe(Weapon.WP_ROCKET_LAUNCHER); await f.run("weapprev"); expect(f.state.weaponSelect).toBe(Weapon.WP_MACHINEGUN);
    snap.playerState.pmFlags = MoveFlags.FOLLOW; await f.run("weapon 1"); expect(f.state.weaponSelect).toBe(Weapon.WP_MACHINEGUN);
  });
});

describe("Team Arena console commands", () => {
  test("native orders fixture preserves voice spelling, task numbers, and button wait commands", async () => {
    const f = fixture("missionpack"); f.state.time = 5000; f.staticState.acceptLeader = 3; f.staticState.acceptTask = 6; f.staticState.acceptOrderTime = 5001;
    await f.run("confirmOrder"); await f.run("denyOrder");
    expect(f.consoleCommands).toEqual(["cmd vtell 3 yes\n", "+button5; wait; -button5", "cmd vtell 3 no\n", "+button6; wait; -button6"]);
    expect(f.clientCommands).toEqual(["teamtask 6\n"]); expect(f.staticState.acceptOrderTime).toBe(0);
    f.commandBuffer.execute(); expect(f.calls).toEqual(["engine:cmd vtell 3 yes", "engine:+button5"]);
    f.staticState.gameType = GameType.GT_CTF;
    for (const name of ["taskOffense", "taskDefense", "taskPatrol", "taskCamp", "taskFollow", "taskRetrieve", "taskEscort", "taskOwnFlag", "tauntGauntlet"]) await f.run(name);
    expect(f.consoleCommands.slice(4)).toEqual(["cmd vsay_team ongetflag\n", "cmd vsay_team ondefense\n", "cmd vsay_team onpatrol\n", "cmd vsay_team oncamp\n", "cmd vsay_team onfollow\n", "cmd vsay_team onreturnflag\n", "cmd vsay_team onfollowcarrier\n", "cmd vsay_team ihaveflag\n", "cmd vsay kill_guantlet\n"]);
    expect(f.clientCommands.slice(1)).toEqual(["teamtask 1\n", "teamtask 2\n", "teamtask 3\n", "teamtask 7\n", "teamtask 4\n", "teamtask 5\n", "teamtask 6\n"]);
    f.staticState.gameType = GameType.GT_TEAM; await f.run("taskOffense"); expect(f.consoleCommands.at(-1)).toBe("cmd vsay_team onoffense\n");
    f.state.crosshairClientTime = 5000; await f.run("taskSuicide"); expect(f.clientCommands.at(-1)).toBe("tell 0 suicide");
    for (const name of ["tauntKillInsult", "tauntPraise", "tauntTaunt", "tauntDeathInsult"]) await f.run(name);
    expect(f.consoleCommands.slice(-4)).toEqual(["cmd vsay kill_insult\n", "cmd vsay praise\n", "cmd vtaunt\n", "cmd vsay death_insult\n"]);
  });

  test("nextOrder checks selected teammate, short-circuits leaders and skips unavailable flag orders", async () => {
    const f = fixture("missionpack"); f.state.time = 5000; f.state.sortedTeamPlayers[0] = 1; await f.run("nextOrder"); expect(f.staticState.orderPending).toBe(false);
    slot(f.staticState.clientInfo, 0).teamLeader = true; f.cache("cg_currentSelectedPlayer", "99"); f.staticState.currentOrder = 4; await f.run("nextOrder");
    expect([f.staticState.currentOrder, f.staticState.orderPending, f.staticState.orderTime]).toEqual([7, true, 8000]); expect(f.calls).toEqual(["other-flag", "our-flag"]);
    await f.run("nextOrder"); expect(f.staticState.currentOrder).toBe(1);
    f.widgets.otherFlag = true; f.staticState.currentOrder = 4; await f.run("nextOrder"); expect(f.staticState.currentOrder).toBe(5);
    f.widgets.ourFlag = true; await f.run("nextOrder"); expect(f.staticState.currentOrder).toBe(6);
    await f.run("nextTeamMember"); await f.run("prevTeamMember"); expect(f.calls.slice(-2)).toEqual(["next-player", "previous-player"]);
    slot(f.staticState.clientInfo, 0).teamLeader = false; await expect(f.run("nextOrder")).rejects.toThrow("outside 8");
  });

  test("source win/lose camera settings precede buffered sound and center printing", async () => {
    const f = fixture("missionpack"); await f.run("spWin"); await f.run("spLose");
    expect(f.calls).toEqual(["sound:winnerSound", "buffer-sound", "center:144:0:YOU WIN!", "sound:loserSound", "buffer-sound", "center:144:0:YOU LOSE..."]);
    expect(["cg_cameraOrbit", "cg_cameraOrbitDelay", "cg_thirdPerson", "cg_thirdPersonAngle", "cg_thirdPersonRange"].map(name => f.cvars.get(name)?.value)).toEqual(["2", "35", "1", "0", "100"]);
  });

  test("order acceptance expires strictly, while expired yes/no voice replies still send", async () => {
    const f = fixture("missionpack"); f.state.time = 3000; f.staticState.acceptOrderTime = 3000; f.staticState.acceptLeader = 2; f.staticState.acceptTask = 7;
    await f.run("confirmOrder"); expect(f.clientCommands).toEqual([]); expect(f.staticState.acceptOrderTime).toBe(3000);
    await f.run("denyOrder"); expect(f.staticState.acceptOrderTime).toBe(3000);
    f.staticState.acceptOrderTime = 3001; await f.run("denyOrder"); expect(f.staticState.acceptOrderTime).toBe(0);
    expect(f.consoleCommands).toEqual(["cmd vtell 2 yes\n", "+button5; wait; -button5", "cmd vtell 2 no\n", "+button6; wait; -button6", "cmd vtell 2 no\n", "+button6; wait; -button6"]);
  });

  test("HUD uses parsed menu identity and source feeder order; async reload blocks later commands", async () => {
    const f = fixture("missionpack");
    const resolver: UiMenuResolver = { resolveRoot: path => ({ path, text: path === "ui/hud.txt" ? '{ loadMenu { "ui/score.menu" } }' : 'menuDef { name "scoreboard" rect 0 0 640 480 }' }), resolve: () => undefined };
    const definitions = await loadMenuDefinitions({ resolver, random: { nextInt: () => 7 } }, { kind: "hud", setPath: "ui/hud.txt" });
    f.widgets.menu = { definition: slot(definitions.menus, 0) }; f.state.scoreBoardShowing = false; await f.run("scoresDown"); expect(f.calls).toEqual([]);
    f.state.scoreBoardShowing = true; await f.run("scoresDown"); await f.run("scoresUp");
    expect(f.calls).toEqual(["scroll:11:true", "scroll:5:true", "scroll:6:true", "scroll:11:false", "scroll:5:false", "scroll:6:false"]);
    const hud = f.host.hud;
    if (hud.kind !== "available") throw new Error("Missing fixture menu owner");
    const gate = Promise.withResolvers<void>(), originalScroll = hud.scrollFeeder.bind(hud);
    hud.scrollFeeder = async (menu, feeder, down) => { await originalScroll(menu, feeder, down); if (feeder === 11) await gate.promise; };
    const scroll = f.run("scoresDown"), zoom = f.run("+zoom");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.calls.at(-1)).toBe("scroll:11:true"); expect(f.state.zoomed).toBe(false);
    gate.resolve(); await scroll; await zoom;
    expect(f.calls.slice(-3)).toEqual(["scroll:11:true", "scroll:5:true", "scroll:6:true"]); expect(f.state.zoomed).toBe(true);
    const pending = Promise.withResolvers<void>(); f.policy.hud = pending.promise; const reload = f.run("loadhud"), later = f.run("sizeup");
    await Promise.resolve(); await Promise.resolve(); expect(f.calls.slice(-3)).toEqual(["strings", "menus", "hud:ui/hud.txt"]); expect(f.cvars.get("cg_viewsize")?.value).toBe("95");
    pending.resolve(); await reload; await later; expect(f.calls.at(-1)).toBe("clear-scoreboard"); expect(f.widgets.menu).toBeNull(); expect(f.cvars.get("cg_viewsize")?.value).toBe("105");
  });

  test("missing HUD and team services reject visibly rather than acknowledging execution", async () => {
    const f = fixture("missionpack"), absent: ClientConsoleHost = { ...f.host, hud: { kind: "unavailable", reason: "HUD owner not initialized" }, teamOrders: { kind: "unavailable", reason: "team HUD not initialized" } };
    await expect(new ClientConsoleRuntime(f.state, f.staticState, absent).execute(["loadhud"])).rejects.toThrow("HUD owner not initialized");
    await expect(new ClientConsoleRuntime(f.state, f.staticState, absent).execute(["nextTeamMember"])).rejects.toThrow("team HUD not initialized");
  });

  test("deferred loading uses the presenter supplied for this cgame instance", async () => {
    const f = fixture(), cent = f.state.entityAt(8);
    const runtime = new ClientConsoleRuntime(f.state, f.staticState, { ...f.host,
      clients: { reset: () => f.clients.reset(), loadDeferredPlayers: async reset => { f.calls.push("deferred"); reset(cent); } },
      resetPlayerEntity: entity => { expect(entity).toBe(cent); f.calls.push("reset-presenter"); },
    });
    expect(await runtime.execute(["loaddeferred"])).toBe(true); expect(f.calls).toEqual(["deferred", "reset-presenter"]);
  });

  test("HUD failure keeps later commands terminal and cannot clear a newer scoreboard", async () => {
    const f = fixture("missionpack"); f.cvars.set("cg_hudFiles", "custom/hud.txt");
    const pending = Promise.withResolvers<void>(); f.policy.hud = pending.promise;
    const loading = f.run("loadhud"), next = f.run("sizeup"), settled = Promise.allSettled([loading, next]);
    await Promise.resolve(); await Promise.resolve(); expect(f.calls).toEqual(["strings", "menus", "hud:custom/hud.txt"]);
    pending.reject(new Error("invalid HUD file"));
    for (const result of await settled) { expect(result.status).toBe("rejected"); if (result.status === "rejected") {
      const reason: unknown = result.reason; expect(reason instanceof Error && reason.message === "invalid HUD file").toBe(true);
    } }
    expect(f.calls).not.toContain("clear-scoreboard"); expect(f.cvars.get("cg_viewsize")?.value).toBe("95");
  });

  test("owned arguments, ordered async model completion and terminal disposal prevent stale publication", async () => {
    const f = fixture(), pending = Promise.withResolvers<SceneModel>(); f.policy.model = pending.promise;
    const argv = ["testmodel", "first.md3"], first = f.runtime.execute(argv); argv[1] = "mutated.md3";
    const second = f.run("nextframe"); await Promise.resolve(); await Promise.resolve(); expect(f.calls).toEqual(["model:first.md3"]); expect(f.state.testModelEntity.frame).toBe(0);
    pending.resolve(DEFAULT_MODEL); await first; await second; expect(f.state.testModelEntity.frame).toBe(1);
    const blocked = Promise.withResolvers<SceneModel>(); f.policy.model = blocked.promise; const loading = f.run("testmodel stale.md3"), queued = f.run("nextskin");
    const failures = Promise.allSettled([loading, queued]);
    await Promise.resolve(); await Promise.resolve(); f.runtime.dispose(); blocked.resolve(DEFAULT_MODEL);
    for (const result of await failures) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") { const reason: unknown = result.reason; expect(reason instanceof Error && reason.message.includes("closed")).toBe(true); }
    }
    expect(f.state.testModelName).toBe(""); expect(f.state.testModelEntity.skinNum).toBe(0);
  });
});
