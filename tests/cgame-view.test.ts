import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseMd3 } from "../src/assets/md3.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { ViewRuntime } from "../src/cgame/view.ts";
import type { ViewSettings } from "../src/cgame/view.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { DEFAULT_MODEL, RF_DEPTHHACK, RF_FIRST_PERSON, RF_MINLIGHT } from "../src/render/ref-entity.ts";
import type { SceneModel } from "../src/render/ref-entity.ts";
import { RDF_HYPERSPACE, RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { GameType, MoveType, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { MoveFlags } from "../src/shared/player-state.ts";

function map(contents = 0): BspMap {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  const planes = contents === 1
    ? [{ normal: vec3(1, 0, 0), distance: -20 }, { normal: vec3(-1, 0, 0), distance: 30 },
      { normal: vec3(0, 1, 0), distance: 1000 }, { normal: vec3(0, -1, 0), distance: 1000 },
      { normal: vec3(0, 0, 1), distance: 1000 }, { normal: vec3(0, 0, -1), distance: 1000 }]
    : [{ normal: vec3(1, 0, 0), distance: 1000 }, { normal: vec3(-1, 0, 0), distance: 1000 },
      { normal: vec3(0, 1, 0), distance: 1000 }, { normal: vec3(0, -1, 0), distance: 1000 },
      { normal: vec3(0, 0, 1), distance: 1000 }, { normal: vec3(0, 0, -1), distance: 1000 }];
  return { entities: "", entityRecords: [], shaders: [{ name: "fixture", surfaceFlags: 0, contentFlags: contents }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: contents === 0 ? 0 : 1 }],
    leafSurfaces: [], leafBrushes: contents === 0 ? [] : [0],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: contents === 0 ? 0 : 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function fixture(product: Product = "baseq3", bsp = map(), registerModel: (path: string) => Promise<SceneModel> = async () => DEFAULT_MODEL) {
  const state = new ClientGameState(product, 0, 0);
  state.time = 1000;
  state.predictedPlayerState.health = 100;
  state.predictedPlayerState.viewheight = 26;
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: state.predictedPlayerState.copy(), entities: [] };
  const prediction = new PredictionRuntime(state, new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" }), {
    commands: new ClientCommandHistory(), settings: () => ({ gameType: GameType.GT_FFA, dmFlags: 0, demoPlayback: false,
      noPredict: false, synchronousClients: false, predictItems: true, pmoveFixed: false, pmoveMsec: 8,
      errorDecayInteger: 100, errorDecayValue: 100, showMiss: 0 }),
    setPmoveMsec: () => {}, transitionPlayerState: async () => {}, warn: () => {},
  });
  let settings: ViewSettings = { videoWidth: 640, videoHeight: 480, viewSize: 100, thirdPerson: false,
    thirdPersonRange: 40, thirdPersonAngle: 0, cameraMode: false, cameraOrbitInteger: 0, cameraOrbitValue: 0,
    cameraOrbitDelay: 50, errorDecay: 100, runPitch: 0.002, runRoll: 0.005, bobPitch: 0.002, bobRoll: 0.002,
    bobUp: 0.005, fov: 90, zoomFov: 22.5, dmFlags: 0, gunX: 0, gunY: 0, gunZ: 0 };
  const prints: string[] = [], sizes: number[] = [], orbit: number[] = [];
  const view = new ViewRuntime(state, prediction, {
    settings: () => settings,
    setViewSize: value => { sizes.push(value); settings = { ...settings, viewSize: value }; },
    setThirdPersonAngleValue: value => { orbit.push(value); settings = { ...settings, thirdPersonAngle: value }; },
    registerModel, print: message => { prints.push(message); },
  });
  return { state, prediction, view, prints, sizes, orbit,
    configure: (changes: Partial<ViewSettings>) => { settings = { ...settings, ...changes }; } };
}

describe("source client view", () => {
  test("standing view publishes source viewport, axes, time and an owned area mask", () => {
    const { state, view } = fixture();
    expect(view.calculateViewValues()).toBe(false);
    expect(state.refdef.viewOrigin).toEqual(vec3(0, 0, 26));
    expect([state.refdef.x, state.refdef.y, state.refdef.width, state.refdef.height]).toEqual([0, 0, 640, 480]);
    expect(state.refdef.fovX).toBe(90);
    expect(state.refdef.fovY).toBeCloseTo(73.73979, 4);
    expect(state.refdef.viewAxis[0]).toEqual(vec3(1, 0, -0));
    expect(state.refdef.time).toBe(0);
    const snapshot = state.snap;
    if (snapshot === null) throw new Error("Missing fixture snapshot");
    snapshot.areaMask[3] = 8;
    const publication = view.finishRefdef();
    expect(publication.time).toBe(1000);
    expect(publication.areaMask[3]).toBe(8);
    snapshot.areaMask[3] = 0;
    state.refdef.areaMask[3] = 0;
    expect(publication.areaMask[3]).toBe(8);
  });

  test("viewsize clamps cvars and rounds the centered viewport to even dimensions", () => {
    const { state, view, configure, sizes } = fixture();
    configure({ videoWidth: 801, videoHeight: 601, viewSize: 10 });
    view.calculateViewValues();
    expect(sizes).toEqual([30]);
    expect([state.refdef.x, state.refdef.y, state.refdef.width, state.refdef.height]).toEqual([280, 210, 240, 180]);
    configure({ viewSize: 110 });
    view.calculateViewValues();
    expect(sizes).toEqual([30, 100]);
    expect([state.refdef.width, state.refdef.height]).toEqual([800, 600]);
  });

  test("intermission skips viewheight, bob, orbit and hyperspace while forcing fullscreen and 90 FOV", () => {
    const { state, view, configure, sizes, orbit } = fixture();
    const snapshot = state.snap;
    if (snapshot === null) throw new Error("Missing fixture snapshot");
    snapshot.playerState.pmType = MoveType.PM_INTERMISSION;
    state.predictedPlayerState.pmType = MoveType.PM_INTERMISSION;
    state.predictedPlayerState.origin = vec3(1, 2, 3);
    state.bobCycle = 1;
    state.hyperspace = true;
    configure({ viewSize: 10, fov: 160, cameraOrbitInteger: 5, cameraOrbitValue: 5 });
    view.calculateViewValues();
    expect(state.refdef.viewOrigin).toEqual(vec3(1, 2, 3));
    expect([state.refdef.width, state.refdef.height, state.refdef.fovX, state.refdef.renderFlags]).toEqual([640, 480, 90, 0]);
    expect(state.bobCycle).toBe(1);
    expect(sizes).toEqual([]);
    expect(orbit).toEqual([]);
  });

  test("first-person source ordering leaves velocity pitch/roll axes zero until after offsets", () => {
    const { state, view, configure } = fixture();
    state.predictedPlayerState.velocity = vec3(400, 200, 0);
    configure({ runPitch: 100, runRoll: 100 });
    view.calculateViewValues();
    expect(state.refdefViewAngles).toEqual(vec3(0, 0, 0));
    expect(state.refdef.viewOrigin.z).toBe(26);
  });

  test("scalar first-person offsets preserve the yaw left by the weapon-kick vector addition", () => {
    const { state, view } = fixture();
    state.predictedPlayerState.viewangles = vec3(0, -0, 0);
    state.kickAngles = vec3(0, -0, 0);
    state.damageTime = 950;
    view.calculateViewValues();
    expect(Object.is(state.refdefViewAngles.y, -0)).toBe(true);
  });

  test("duck, landing and step offsets preserve source transition boundaries", () => {
    const { state, view } = fixture();
    state.duckChange = 12; state.duckTime = 950;
    view.calculateViewValues(); expect(state.refdef.viewOrigin.z).toBe(20);
    state.duckTime = 900;
    state.landChange = -16; state.landTime = 925;
    view.calculateViewValues(); expect(state.refdef.viewOrigin.z).toBe(18);
    state.landTime = 850;
    view.calculateViewValues(); expect(state.refdef.viewOrigin.z).toBe(10);
    state.landTime = 700;
    view.calculateViewValues(); expect(state.refdef.viewOrigin.z).toBe(18);
    state.landTime = 550;
    state.stepChange = 16; state.stepTime = 900;
    view.calculateViewValues(); expect(state.refdef.viewOrigin.z).toBe(18);
    state.stepTime = 800; state.kickOrigin = vec3(1, 2, 3);
    view.calculateViewValues(); expect(state.refdef.viewOrigin).toEqual(vec3(1, 2, 29));
  });

  test("damage deflection/return and bob crouch/sign/height limit are applied", () => {
    const { state, view } = fixture();
    state.damagePitch = 10; state.damageRoll = 20; state.damageTime = 950;
    state.kickAngles = vec3(1, 2, 3);
    view.calculateViewValues(); expect(state.refdefViewAngles).toEqual(vec3(6, 2, 13));
    state.damageTime = 900;
    view.calculateViewValues(); expect(state.refdefViewAngles).toEqual(vec3(11, 2, 23));
    state.damageTime = 700;
    view.calculateViewValues(); expect(state.refdefViewAngles).toEqual(vec3(6, 2, 13));
    state.damageTime = 500;
    view.calculateViewValues(); expect(state.refdefViewAngles).toEqual(vec3(1, 2, 3));
    state.kickAngles = vec3(0, 0, 0); state.damageTime = 0;
    state.predictedPlayerState.bobCycle = 64;
    state.predictedPlayerState.velocity = vec3(10000, 0, 0);
    view.calculateViewValues();
    expect(state.refdef.viewOrigin.z).toBe(32);
    const pitch = state.refdefViewAngles.x;
    expect(state.bobFracSin).toBeCloseTo(0.9999235, 6);
    state.predictedPlayerState.bobCycle = 192;
    state.predictedPlayerState.pmFlags |= MoveFlags.DUCKED;
    view.calculateViewValues();
    expect(state.bobCycle).toBe(1);
    expect(state.refdefViewAngles.x).toBe(Math.fround(pitch * 3));
    expect(state.refdefViewAngles.z).toBe(-Math.fround(pitch * 3));
  });

  test("prediction errors decay only strictly inside their source interval", () => {
    const { state, view } = fixture();
    state.predictedError = vec3(10, 20, 30); state.predictedErrorTime = 950;
    view.calculateViewValues(); expect(state.refdef.viewOrigin).toEqual(vec3(5, 10, 41));
    state.predictedErrorTime = 1000;
    view.calculateViewValues(); expect(state.refdef.viewOrigin).toEqual(vec3(0, 0, 26));
    expect(state.predictedErrorTime).toBe(0);
    state.predictedErrorTime = 900;
    view.calculateViewValues(); expect(state.predictedErrorTime).toBe(0);
  });

  test("third-person camera uses actual swept collision and cameraMode bypasses both traces", () => {
    const { state, view, configure } = fixture("baseq3", map(1));
    configure({ thirdPerson: true });
    view.calculateViewValues();
    expect(state.renderingThirdPerson).toBe(true);
    expect(state.refdef.viewOrigin.x).toBe(-15.875);
    expect(state.refdef.viewOrigin.z).toBeGreaterThan(34);
    configure({ cameraMode: true });
    view.calculateViewValues();
    expect(state.refdef.viewOrigin).toEqual(vec3(-40, 0, 34));
    // q3lcc cg_view.asm: CNSTF4 3261411041, atan2(-8, 552), MULF4.
    expect(state.refdefViewAngles.x).toBe(0.8303154706954956);
  });

  test("death uses the product's dead-yaw slot and source orbit advances only after its deadline", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const { state, view, configure, orbit } = fixture(product);
      const snapshot = state.snap;
      if (snapshot === null) throw new Error("Missing fixture snapshot");
      snapshot.playerState.health = 0; state.predictedPlayerState.health = 0;
      state.predictedPlayerState.stats.set(statSchema(product).deadYaw, 90);
      configure({ cameraOrbitInteger: 1, cameraOrbitValue: 5 });
      state.nextOrbitTime = 1000;
      view.calculateViewValues();
      expect(state.refdefViewAngles.y).toBe(90);
      expect(orbit).toEqual([]);
      state.time = 1001;
      view.calculateViewValues();
      expect(orbit).toEqual([5]);
      expect(state.refdefViewAngles.y).toBe(85);
      expect(state.nextOrbitTime).toBe(1051);
    }
  });

  test("zoom commands are idempotent and interpolate fixed/user FOV with separate vertical water warp", () => {
    const { state, view, configure } = fixture();
    configure({ fov: 200 });
    view.calculateViewValues(); expect(state.refdef.fovX).toBe(160);
    configure({ dmFlags: 16 });
    view.calculateViewValues(); expect(state.refdef.fovX).toBe(90);
    view.zoomDown(); state.time = 1050; view.zoomDown();
    expect(state.zoomTime).toBe(1000);
    state.time = 1075;
    view.calculateViewValues(); expect(state.refdef.fovX).toBe(56.25);
    expect(state.zoomSensitivity).toBe(Math.fround(state.refdef.fovY / 75));
    state.time = 1150;
    view.calculateViewValues(); expect(state.refdef.fovX).toBe(22.5);
    view.zoomUp(); state.time = 1200; view.zoomUp();
    expect(state.zoomTime).toBe(1150);
    state.time = 1225;
    view.calculateViewValues(); expect(state.refdef.fovX).toBe(56.25);
    expect(state.zoomSensitivity).toBe(1);
    const water = fixture("baseq3", map(32));
    water.state.time = 625;
    expect(water.view.calculateViewValues()).toBe(true);
    expect(water.state.refdef.fovX).toBe(91);
    expect(water.state.refdef.fovY).toBeCloseTo(72.73979, 4);
    water.state.time = 16777223;
    water.view.calculateViewValues();
    // QVM converts the integer clock to float32 before division by 1000.
    expect(water.state.refdef.fovX).toBe(89.36271667480469);
  });

  test("hyperspace flags and damage sprite use canonical view axes and source byte alpha", () => {
    const { state, view } = fixture();
    state.hyperspace = true;
    view.calculateViewValues();
    expect(state.refdef.renderFlags).toBe(RDF_NOWORLDMODEL | RDF_HYPERSPACE);
    state.damageValue = 10; state.damageTime = 750; state.damageX = 0.5; state.damageY = -0.25;
    const blob = view.damageBlendBlob({ name: "viewBlood" }, false);
    if (blob === null) throw new Error("Missing damage sprite");
    expect(blob.origin).toEqual(vec3(8, -4, 24));
    expect(blob.radius).toBe(30);
    expect(blob.shaderRGBA).toEqual({ x: 255, y: 255, z: 255, w: 100 });
    expect(blob.renderFlags).toBe(RF_FIRST_PERSON);
    const sourceZero = view.damageBlendBlob(null, false);
    if (sourceZero === null) throw new Error("Zero shader handle must not omit an unconditional damage sprite");
    expect(sourceZero.customShader).toBeNull();
    expect(sourceZero.origin).toEqual(blob.origin);
    expect(sourceZero.shaderRGBA).toEqual(blob.shaderRGBA);
    expect(view.damageBlendBlob({ name: "viewBlood" }, true)).toBeNull();
    state.damageTime = 999.5;
    expect(view.damageBlendBlob({ name: "viewBlood" }, false)).toBeNull();
    state.damageTime = 500;
    expect(view.damageBlendBlob({ name: "viewBlood" }, false)).toBeNull();
  });

  test("testmodel/model-frame/skin commands and testgun placement use the canonical camera", async () => {
    const bsp = map(), model: SceneModel = { kind: "inline", path: "*0", index: 0, map: bsp };
    const registrations: string[] = [];
    const { state, view, configure, prints } = fixture("baseq3", bsp, async path => { registrations.push(path); return model; });
    view.calculateViewValues();
    await view.testModel("*0", 0.25);
    expect(state.testModelEntity.origin).toEqual(vec3(100, 0, 26));
    expect(state.testModelEntity.frame).toBe(1);
    expect(state.testModelEntity.backLerp).toBe(0.25);
    view.previousModelFrame(); view.previousModelFrame(); view.nextModelFrame();
    view.previousModelSkin(); view.nextModelSkin();
    expect([state.testModelEntity.frame, state.testModelEntity.skinNum]).toEqual([1, 1]);
    expect(prints).toContain("frame 0\n");
    await view.testGun("*0");
    configure({ gunX: 2, gunY: 3, gunZ: 4 });
    const entity = await view.addTestModel();
    if (entity === null || entity.kind !== "model") throw new Error("Missing test gun");
    expect(entity.origin).toEqual(vec3(2, 3, 30));
    expect(entity.renderFlags).toBe(RF_MINLIGHT | RF_DEPTHHACK | RF_FIRST_PERSON);
    expect(entity.axis).toEqual(state.refdef.viewAxis);
    expect(registrations).toEqual(["*0", "*0", "*0"]);
    entity.origin = vec3(999, 0, 0);
    expect(state.testModelEntity.origin).toEqual(vec3(2, 3, 30));
  });

  test("late model requests cannot replace newer guns or publish after lifecycle cancellation", async () => {
    const old = Promise.withResolvers<SceneModel>(), current = Promise.withResolvers<SceneModel>();
    const bsp = map(), model: SceneModel = { kind: "inline", path: "*0", index: 0, map: bsp };
    const { state, view } = fixture("baseq3", bsp, path => path === "old" ? old.promise : current.promise);
    view.calculateViewValues();
    const first = view.testModel("old"), second = view.testGun("new");
    current.resolve(model); await second;
    old.resolve(DEFAULT_MODEL); await first;
    expect(state.testModelName).toBe("new");
    expect(state.testModelEntity.model).toBe(model);
    expect(state.testGun).toBe(true);
    const pending = Promise.withResolvers<SceneModel>();
    const cancelled = fixture("baseq3", bsp, () => pending.promise);
    const loading = cancelled.view.testGun("pending");
    cancelled.view.clearTestModel();
    pending.resolve(model); await loading;
    expect(cancelled.state.testModelEntity.model.kind).toBe("default");
    expect(cancelled.state.testGun).toBe(false);
  });

  test("testgun applies interpolation and gun flags at the source registration and command-return boundaries", async () => {
    const pending = Promise.withResolvers<SceneModel>();
    const bsp = map(), model: SceneModel = { kind: "inline", path: "*0", index: 0, map: bsp };
    const { state, view } = fixture("baseq3", bsp, () => pending.promise);
    const loading = view.testGun("*0", 0.25);
    expect([state.testModelEntity.frame, state.testModelEntity.backLerp, state.testModelEntity.renderFlags]).toEqual([0, 0, 0]);
    expect(state.testGun).toBe(false);
    pending.resolve(model); await loading;
    expect([state.testModelEntity.frame, state.testModelEntity.backLerp]).toEqual([1, 0.25]);
    expect(state.testModelEntity.renderFlags).toBe(RF_MINLIGHT | RF_DEPTHHACK | RF_FIRST_PERSON);
    expect(state.testGun).toBe(true);
    await view.testModel(null);
    expect(state.testGun).toBe(true);
    expect(state.testModelEntity.renderFlags).toBe(0);
  });

  test("testgun registration and diagnostic failures stop before the source gun-command tail", async () => {
    const registration = fixture("baseq3", map(), async () => { throw new Error("registration stopped"); });
    await expect(registration.view.testGun("missing", 0.25)).rejects.toThrow("registration stopped");
    expect([registration.state.testModelEntity.frame, registration.state.testModelEntity.backLerp, registration.state.testModelEntity.renderFlags]).toEqual([0, 0, 0]);
    expect(registration.state.testGun).toBe(false);

    const diagnostic = fixture();
    const view = new ViewRuntime(diagnostic.state, diagnostic.prediction, {
      ...diagnostic.view.host, print: () => { throw new Error("diagnostic stopped"); },
    });
    await expect(view.testGun("missing", 0.25)).rejects.toThrow("diagnostic stopped");
    expect([diagnostic.state.testModelEntity.frame, diagnostic.state.testModelEntity.backLerp, diagnostic.state.testModelEntity.renderFlags]).toEqual([1, 0.25, 0]);
    expect(diagnostic.state.testGun).toBe(false);
  });

  test("pending model republication is invalidated and model names follow source buffer bounds", async () => {
    const pending = Promise.withResolvers<SceneModel>();
    const bsp = map(), model: SceneModel = { kind: "inline", path: "*0", index: 0, map: bsp };
    const registrations: string[] = [];
    const { state, view } = fixture("baseq3", bsp, path => {
      registrations.push(path);
      return registrations.length === 2 ? pending.promise : Promise.resolve(model);
    });
    await view.testGun("*0\0ignored");
    expect(state.testModelName).toBe("*0");
    const publication = view.addTestModel();
    view.clearTestModel();
    pending.resolve(model);
    expect(await publication).toBeNull();
    expect(state.testModelEntity.model).toBe(DEFAULT_MODEL);
    await view.testModel("a".repeat(100));
    expect(state.testModelName).toBe("a".repeat(63));
    expect(registrations).toEqual(["*0", "*0", "a".repeat(63)]);
  });

  test("missing snapshots and invalid viewport fail explicitly; missing model handles stay absent", async () => {
    const { state, view, configure, prints } = fixture();
    configure({ videoWidth: 0 });
    expect(() => view.calculateViewValues()).toThrow("viewport");
    state.snap = null;
    expect(() => view.calculateViewValues()).toThrow("snapshot");
    expect(() => view.finishRefdef()).toThrow("snapshot");
    await view.testModel("absent.md3");
    expect(prints).toContain("Can't register model\n");
    expect(await view.addTestModel()).toBeNull();
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retailRoot, "baseq3/pak0.pk3")))("retail rocket model registers for source testgun and follows the calculated player eye", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "baseq3" });
  const path = "models/weapons2/rocketl/rocketl.md3";
  const model: SceneModel = { kind: "md3", path, md3: [parseMd3(await vfs.read(path), path), null, null], numLods: 1, md4: null };
  const { state, view } = fixture("baseq3", map(), async name => name === path ? model : DEFAULT_MODEL);
  state.predictedPlayerState.origin = vec3(10, 20, 30);
  state.predictedPlayerState.viewangles = vec3(10, 45, 0);
  view.calculateViewValues();
  await view.testGun(path);
  const entity = await view.addTestModel();
  if (entity === null || entity.kind !== "model") throw new Error("Missing retail testgun");
  expect(entity.model).toBe(model);
  expect(entity.origin).toEqual(state.refdef.viewOrigin);
  expect(entity.axis).toEqual(state.refdef.viewAxis);
});
