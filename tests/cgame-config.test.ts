// Source table and behavior fixtures for code/cgame/cg_main.c and qcommon/cvar.c.
import { describe, expect, test } from "bun:test";
import { ClientConfiguration, ClientVmCvarSymbol } from "../src/cgame/config.ts";
import { ClientInfoStore } from "../src/cgame/players.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { CvarSnapshot } from "../src/core/cvar.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import { GameType } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";

interface Registration {
  readonly name: string;
  readonly defaultValue: string;
  readonly flags: number;
}

function sourceRows(text: string): readonly Registration[] {
  return text.trim().split("\n").map(line => {
    const fields = line.split("|");
    const name = fields[0], defaultValue = fields[1], flags = fields[2];
    if (name === undefined || defaultValue === undefined || flags === undefined) throw new Error(`Invalid source cvar row ${line}`);
    return { name, defaultValue, flags: Number.parseInt(flags, 10) };
  });
}

// Exact active baseq3 table order followed by the four NULL-vmCvar registrations.
const BASE_SOURCE_ROWS = sourceRows(`
cg_ignore|0|0
cg_autoswitch|1|1
cg_drawGun|1|1
cg_zoomfov|22.5|1
cg_fov|90|1
cg_viewsize|100|1
cg_stereoSeparation|0.4|1
cg_shadows|1|1
cg_gibs|1|1
cg_draw2D|1|1
cg_drawStatus|1|1
cg_drawTimer|0|1
cg_drawFPS|0|1
cg_drawSnapshot|0|1
cg_draw3dIcons|1|1
cg_drawIcons|1|1
cg_drawAmmoWarning|1|1
cg_drawAttacker|1|1
cg_drawCrosshair|4|1
cg_drawCrosshairNames|1|1
cg_drawRewards|1|1
cg_crosshairSize|24|1
cg_crosshairHealth|1|1
cg_crosshairX|0|1
cg_crosshairY|0|1
cg_brassTime|2500|1
cg_simpleItems|0|1
cg_marks|1|1
cg_lagometer|1|1
cg_railTrailTime|400|1
cg_gunX|0|512
cg_gunY|0|512
cg_gunZ|0|512
cg_centertime|3|512
cg_runpitch|0.002|1
cg_runroll|0.005|1
cg_bobup|0.005|512
cg_bobpitch|0.002|1
cg_bobroll|0.002|1
cg_swingSpeed|0.3|512
cg_animspeed|1|512
cg_debuganim|0|512
cg_debugposition|0|512
cg_debugevents|0|512
cg_errordecay|100|0
cg_nopredict|0|0
cg_noplayeranims|0|512
cg_showmiss|0|0
cg_footsteps|1|512
cg_tracerchance|0.4|512
cg_tracerwidth|1|512
cg_tracerlength|100|512
cg_thirdPersonRange|40|512
cg_thirdPersonAngle|0|512
cg_thirdPerson|0|0
cg_teamChatTime|3000|1
cg_teamChatHeight|0|1
cg_forceModel|0|1
cg_predictItems|1|1
cg_deferPlayers|1|1
cg_drawTeamOverlay|0|1
teamoverlay|0|66
cg_stats|0|0
cg_drawFriend|1|1
cg_teamChatsOnly|0|1
cg_noVoiceChats|0|1
cg_noVoiceText|0|1
com_buildScript|0|0
cl_paused|0|64
com_blood|1|1
g_synchronousClients|0|0
cg_cameraOrbit|0|512
cg_cameraOrbitDelay|50|1
cg_timescaleFadeEnd|1|0
cg_timescaleFadeSpeed|0|0
timescale|1|0
cg_scorePlums|1|3
cg_smoothClients|0|3
com_cameraMode|0|512
pmove_fixed|0|0
pmove_msec|8|0
cg_noTaunt|0|1
cg_noProjectileTrail|0|1
ui_smallFont|0.25|1
ui_bigFont|0.4|1
cg_oldRail|1|1
cg_oldRocket|1|1
cg_oldPlasma|1|1
cg_trueLightning|0.0|1
model|sarge|3
headmodel|sarge|3
team_model|sarge|3
team_headmodel|sarge|3`);

// Missionpack inserts these twelve rows before cg_cameraOrbit and changes defer/team defaults.
const MISSION_INSERT = sourceRows(`
g_redteam|Stroggs|7
g_blueteam|Pagans|7
cg_currentSelectedPlayer|0|1
cg_currentSelectedPlayerName||1
ui_singlePlayerActive|0|2
g_enableDust|0|4
g_enableBreath|0|4
ui_singlePlayerActive|0|2
ui_recordSPDemo|0|1
ui_recordSPDemoName||1
g_obeliskRespawnDelay|10|4
cg_hudFiles|ui/hud.txt|1`);

function missionSourceRows(): readonly Registration[] {
  const rows = BASE_SOURCE_ROWS.map(row => row.name === "cg_deferPlayers" ? { ...row, defaultValue: "0" }
    : row.name === "team_model" ? { ...row, defaultValue: "james" }
    : row.name === "team_headmodel" ? { ...row, defaultValue: "*james" } : row);
  const index = rows.findIndex(row => row.name === "cg_cameraOrbit");
  if (index < 0) throw new Error("Source fixture lost cg_cameraOrbit insertion point");
  return [...rows.slice(0, index), ...MISSION_INSERT, ...rows.slice(index)];
}

class RecordingCvars extends CvarRegistry {
  readonly registrations: Registration[] = [];
  readonly sets: { readonly name: string; readonly value: string; readonly force: boolean }[] = [];
  readonly hidden = new Set<string>();

  override register(name: string, defaultValue: string, flags = CvarFlag.None): CvarSnapshot {
    this.registrations.push({ name, defaultValue, flags });
    return super.register(name, defaultValue, flags);
  }

  override get(name: string): CvarSnapshot | undefined {
    return this.hidden.has(name.toLowerCase()) ? undefined : super.get(name);
  }

  override set(name: string, value: string, force = false): CvarSnapshot {
    this.sets.push({ name, value, force });
    return super.set(name, value, force);
  }
}

function fixture(product: Product = "baseq3") {
  const cvars = new RecordingCvars();
  cvars.set("sv_running", "2", true);
  cvars.registrations.length = 0;
  cvars.sets.length = 0;
  const state = new ClientGameState(product, 0, 0), staticState = new ClientGameStaticState(product);
  const configstrings = new Map<number, string>();
  const calls: number[] = [];
  let onClient: (index: number) => Promise<void> = () => Promise.resolve();
  const clients = { async newClientInfo(index: number): Promise<void> { calls.push(index); await onClient(index); } };
  const configuration = new ClientConfiguration(product, { cvars, state, staticState, clients,
    configString: index => configstrings.get(index) ?? "" });
  return { cvars, state, staticState, configstrings, calls, configuration,
    setClientCallback(callback: (index: number) => Promise<void>): void { onClient = callback; } };
}

describe("CG_RegisterCvars", () => {
  test("direct VM scalar writes preserve engine state and untouched cached fields until modification", async () => {
    const setup = fixture("missionpack");
    setup.configuration.registerCvars();
    const angle = ClientVmCvarSymbol.cg_thirdPersonAngle;
    const selected = ClientVmCvarSymbol.cg_currentSelectedPlayer;
    const beforeAngle = setup.configuration.readVmSymbol(angle);
    const beforeSelected = setup.configuration.readVmSymbol(selected);
    setup.configuration.setVmNumericValue(angle, 1 / 3);
    setup.configuration.setVmInteger(selected, 7);
    expect(setup.configuration.readVmSymbol(angle)).toEqual({ ...beforeAngle, numericValue: Math.fround(1 / 3) });
    expect(setup.configuration.readVmSymbol(selected)).toEqual({ ...beforeSelected, integerValue: 7 });
    expect(setup.cvars.get("cg_thirdPersonAngle")?.value).toBe("0");
    expect(setup.cvars.get("cg_currentSelectedPlayer")?.integerValue).toBe(0);
    expect(setup.cvars.sets).toEqual([]);
    await setup.configuration.updateCvars();
    expect(setup.configuration.readVmSymbol(angle).numericValue).toBe(Math.fround(1 / 3));
    expect(setup.configuration.readVmSymbol(selected).integerValue).toBe(7);
    setup.cvars.set("cg_thirdPersonAngle", "12.5", true);
    setup.cvars.set("cg_currentSelectedPlayer", "2", true);
    await setup.configuration.updateCvars();
    expect(setup.configuration.readVmSymbol(angle).numericValue).toBe(12.5);
    expect(setup.configuration.readVmSymbol(angle).integerValue).toBe(12);
    expect(setup.configuration.readVmSymbol(selected).integerValue).toBe(2);
    expect(setup.configuration.readVmSymbol(selected).numericValue).toBe(2);
    expect(Object.isFrozen(setup.configuration.readVmSymbol(angle))).toBe(true);
  });

  test("VM globals exist source-zero before registration and retain source int32 writes", () => {
    const setup = fixture();
    const initial = setup.configuration.readVmSymbol(ClientVmCvarSymbol.cg_fov);
    expect([initial.value, initial.integerValue, initial.numericValue, initial.modificationCount]).toEqual(["", 0, 0, 0]);
    setup.configuration.setVmInteger(ClientVmCvarSymbol.cg_fov, 1);
    expect(setup.configuration.readVmSymbol(ClientVmCvarSymbol.cg_fov).integerValue).toBe(1);
    expect(setup.cvars.get("cg_fov")).toBeUndefined();
    expect(setup.cvars.registrations).toEqual([]);
    setup.configuration.registerCvars();
    setup.configuration.setVmInteger(ClientVmCvarSymbol.cg_fov, 2147483648);
    expect(setup.configuration.readVmSymbol(ClientVmCvarSymbol.cg_fov).integerValue).toBe(-2147483648);
    expect(() => setup.configuration.setVmInteger(ClientVmCvarSymbol.cg_currentSelectedPlayer, 0)).toThrow("not registered");
  });

  test("registers every base and missionpack table row in exact source order", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      setup.configuration.registerCvars();
      expect(setup.cvars.registrations).toEqual([...(product === "baseq3" ? BASE_SOURCE_ROWS : missionSourceRows())]);
      expect(setup.staticState.localServer).toBe(2);
    }
  });

  test("keeps both duplicate missionpack VM cache cells and resolves registered names to the last", () => {
    const setup = fixture("missionpack");
    setup.configuration.registerCvars();
    const first = setup.configuration.readVmSymbol(ClientVmCvarSymbol.cg_singlePlayer);
    const second = setup.configuration.readVmSymbol(ClientVmCvarSymbol.cg_singlePlayerActive);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(setup.configuration.readVmCvar("UI_SINGLEPLAYERACTIVE")).toBe(second);
    expect(() => setup.configuration.readVmSymbol(ClientVmCvarSymbol.cg_singlePlayer)).not.toThrow();
    expect(fixture().configuration.readVmCvar("cg_fov").value).toBe("");
    expect(() => {
      const base = fixture(); base.configuration.registerCvars();
      base.configuration.readVmSymbol(ClientVmCvarSymbol.cg_hudFiles);
    }).toThrow("not registered for baseq3");
  });

  test("reads sv_running through the source 1024-byte buffer before game atoi", () => {
    const setup = fixture();
    setup.cvars.set("sv_running", `${" ".repeat(1023)}2`, true);
    setup.configuration.registerCvars();
    expect(setup.staticState.localServer).toBe(0);
  });
});

describe("Cvar_Update vmCvar_t copies", () => {
  test("copies binary32 values and preserves cache identity while unchanged or cleared", async () => {
    const setup = fixture();
    setup.configuration.registerCvars();
    const initial = setup.configuration.readVmCvar("cg_fov");
    await setup.configuration.updateCvars();
    expect(setup.configuration.readVmCvar("cg_fov")).toBe(initial);
    setup.cvars.set("cg_fov", "0.1", true);
    await setup.configuration.updateCvars();
    const changed = setup.configuration.readVmCvar("cg_fov");
    expect(changed).not.toBe(initial);
    expect(changed.numericValue).toBe(Math.fround(0.1));
    await setup.configuration.updateCvars();
    expect(setup.configuration.readVmCvar("cg_fov")).toBe(changed);
    setup.cvars.hidden.add("cg_fov");
    setup.cvars.set("cg_fov", "7", true);
    await setup.configuration.updateCvars();
    expect(setup.configuration.readVmCvar("cg_fov")).toBe(changed);
  });

  test("commits modificationCount before rejecting an oversized VM string", async () => {
    const setup = fixture();
    setup.configuration.registerCvars();
    setup.cvars.set("cg_fov", "x".repeat(255), true);
    await setup.configuration.updateCvars();
    const retained = setup.configuration.readVmCvar("cg_fov");
    expect(retained.value.length).toBe(255);
    setup.cvars.set("cg_fov", "y".repeat(256), true);
    const engine = setup.cvars.get("cg_fov");
    if (engine === undefined) throw new Error("Fixture cvar disappeared");
    await expect(setup.configuration.updateCvars()).rejects.toThrow("exceeds MAX_CVAR_VALUE_STRING");
    const failed = setup.configuration.readVmCvar("cg_fov");
    expect(failed.modificationCount).toBe(engine.modificationCount);
    expect(failed.value).toBe("x".repeat(255));
    expect(failed.numericValue).toBe(retained.numericValue);
  });

  test("engine byte rejection leaves both cvar and VM cache unchanged, while valid source bytes copy", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product); setup.configuration.registerCvars();
      const engine = setup.cvars.get("cg_fov"), cached = setup.configuration.readVmCvar("cg_fov");
      expect(() => setup.cvars.set("cg_fov", "snowman-☃", true)).toThrow("source bytes");
      expect(setup.cvars.get("cg_fov")).toEqual(engine);
      await setup.configuration.updateCvars();
      expect(setup.configuration.readVmCvar("cg_fov")).toBe(cached);
      setup.cvars.set("cg_fov", "100\0☃", true);
      await setup.configuration.updateCvars();
      expect(setup.configuration.readVmCvar("cg_fov").value).toBe("100");
      expect(setup.configuration.readVmCvar("cg_fov").numericValue).toBe(100);
      setup.cvars.set("cg_fov", "100\xff", true);
      await setup.configuration.updateCvars();
      expect(setup.configuration.readVmCvar("cg_fov").value).toBe("100\xff");
      expect(setup.configuration.readVmCvar("cg_fov").numericValue).toBe(100);
    }
  });
});

describe("CG_UpdateCvars callbacks", () => {
  test("preserves the source teamoverlay one-update VM lag and unconditional E3 override", async () => {
    const setup = fixture(); setup.configuration.registerCvars();
    expect(setup.configuration.readVmCvar("teamoverlay").value).toBe("0");
    await setup.configuration.updateCvars();
    expect(setup.cvars.sets.slice(-2)).toEqual([
      { name: "teamoverlay", value: "0", force: true },
      { name: "teamoverlay", value: "1", force: true },
    ]);
    expect(setup.cvars.get("teamoverlay")?.value).toBe("1");
    expect(setup.configuration.readVmCvar("teamoverlay").value).toBe("0");
    await setup.configuration.updateCvars();
    expect(setup.configuration.readVmCvar("teamoverlay").value).toBe("1");
  });

  test("updates all VM cells before strictly ordered force-model loads and rejects reentry", async () => {
    const setup = fixture(); setup.configuration.registerCvars();
    setup.configstrings.set(544, "player-zero");
    setup.configstrings.set(547, "player-three");
    setup.configstrings.set(607, "player-sixty-three");
    let installed = false;
    let release = (): void => { throw new Error("Fixture release callback was not installed"); };
    const blocked = new Promise<void>(resolve => { release = resolve; installed = true; });
    setup.setClientCallback(async index => {
      expect(setup.configuration.readVmCvar("cg_fov").value).toBe("111");
      expect(setup.configuration.readVmCvar("cg_forceModel").value).toBe("1");
      expect(setup.configuration.readVmCvar("cg_trueLightning").value).toBe("0.75");
      if (index === 0) await blocked;
    });
    setup.cvars.set("cg_fov", "111", true);
    setup.cvars.set("cg_forceModel", "1", true);
    setup.cvars.set("cg_trueLightning", "0.75", true);
    const update = setup.configuration.updateCvars();
    await Promise.resolve();
    expect(setup.calls).toEqual([0]);
    await expect(setup.configuration.updateCvars()).rejects.toThrow("already active");
    await expect(setup.configuration.forceModelChange()).rejects.toThrow("already active");
    if (!installed) throw new Error("Fixture did not install release callback");
    release();
    await update;
    expect(setup.calls).toEqual([0, 3, 63]);
  });

  test("restores the reentry guard after an asynchronous client-load failure", async () => {
    const setup = fixture(); setup.configuration.registerCvars();
    setup.configstrings.set(544, "player-zero");
    setup.setClientCallback(() => Promise.reject(new Error("model load failed")));
    setup.cvars.set("cg_forceModel", "1", true);
    await expect(setup.configuration.updateCvars()).rejects.toThrow("model load failed");
    setup.setClientCallback(() => Promise.resolve());
    await expect(setup.configuration.forceModelChange()).resolves.toBeUndefined();
  });

  test("publishes force-model changes through the actual canonical ClientInfoStore", async () => {
    const product: Product = "baseq3";
    const state = new ClientGameState(product, 0, 0), staticState = new ClientGameStaticState(product);
    const store = new ClientInfoStore({ state,
      assets: { read: () => Promise.reject(new Error("Unexpected fixture asset read")), has: () => false, list: () => [] },
      resources: { registerModel: () => Promise.resolve(DEFAULT_MODEL), registerSkin: () => Promise.resolve(null) },
      settings: () => ({ gameType: GameType.GT_FFA, maxClients: 64, forceModel: false, model: "sarge/default",
        headModel: "sarge/default", redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false,
        buildScript: false, loading: true }),
      memoryRemaining: () => 10_000_000, registerShaderNoMip: () => Promise.resolve(null),
      registerSound: () => Promise.resolve(null), sound: () => null, print: () => undefined }, staticState.clientInfo);
    const reusable = store.clientInfo(1);
    reusable.infoValid = true;
    reusable.modelName = "sarge";
    reusable.skinName = "default";
    reusable.headModelName = "sarge";
    reusable.headSkinName = "default";
    const cvars = new CvarRegistry();
    const configstring = "\\n\\Fresh\\t\\0\\model\\sarge/default\\hmodel\\sarge/default\\c1\\4\\c2\\3\\hc\\100";
    const configuration = new ClientConfiguration(product, { cvars, state, staticState, clients: store,
      configString: index => index === 544 ? configstring : "" });
    configuration.registerCvars();
    await configuration.forceModelChange();
    expect(store.clientInfo(0).infoValid).toBe(true);
    expect(store.clientInfo(0).name).toBe("Fresh");
    expect(store.clientInfo(0).modelName).toBe("sarge");
  });
});
