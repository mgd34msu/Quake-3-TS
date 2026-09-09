import { HunkArena } from "../src/core/hunk.ts";
import { describe, expect, test } from "bun:test";
import type { Md3Model } from "../src/assets/md3.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { PacketEntityPresenter, adjustPositionForMover, positionEntityOnTag, positionRotatedEntityOnTag } from "../src/cgame/entities.ts";
import type { MissileTrail, PacketEntityImports, PacketEntityMedia, PacketEntityOptions, PacketWeaponInfo } from "../src/cgame/entities.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import type { ClientEntity } from "../src/cgame/state.ts";
import { CommonError } from "../src/core/common-error.ts";
import { anglesToAxis, vec3, vec4 } from "../src/core/math.ts";
import type { Axis, Vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { retailSnapshot } from "../src/cgame/retail-snapshot.ts";
import type { RetailSnapshot } from "../src/cgame/retail-snapshot.ts";
import { decodeServerMessage, encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext } from "../src/protocol/server-message.ts";
import type { DynamicLight } from "../src/render/lighting.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { DEFAULT_MODEL, createModelEntity } from "../src/render/ref-entity.ts";
import type { RefEntity, RefModelEntity, SceneModel } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { EntityType, GameType, ItemType, Team, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { itemList } from "../src/shared/items.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const zero = vec3(0, 0, 0);
const identity: Axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
const options: PacketEntityOptions = { gameType: GameType.GT_FFA, smoothClients: true, simpleItems: false, obeliskRespawnDelay: 10 };
const sound: PcmSound = { sampleRate: 22050, channels: 1, samples: new Int16Array([123]), frameCount: 1, loopStart: null };

function model(path: string): SceneModel {
  const md3: Md3Model = { name: path, flags: 0, skinCount: 0, frames: [], tags: [], surfaces: [] };
  return { kind: "md3", path, md3: [md3, null, null], numLods: 1, md4: null };
}

function media(product: Product): PacketEntityMedia {
  const weapon: PacketWeaponInfo = { weaponModel: model("weapon"), weaponMidpoint: vec3(2, 3, 4), barrelModel: null,
    missileModel: model("missile"), missileRenderfx: 0, missileSound: null, missileDlight: 0, missileDlightColor: zero,
    missileTrail: null, trailRadius: 0, trailTime: 0 };
  return {
    gameModels: [DEFAULT_MODEL, model("game1"), model("game2")], gameSounds: [null, sound],
    inlineModels: [{ model: DEFAULT_MODEL, midpoint: zero }, { model: model("inline1"), midpoint: vec3(8, 16, 24) }],
    items: itemList(product).map(item => ({ models: [model(item.worldModels[0] ?? "empty"), item.worldModels[1] === null ? null : model(item.worldModels[1])], icon: item.icon === null ? null : { name: item.icon } })),
    weapons: Array.from({ length: 64 }, () => weapon), plasmaBallShader: { name: "plasma" },
    redFlagBaseModel: model("redflag"), blueFlagBaseModel: model("blueflag"), neutralFlagBaseModel: model("neutralflag"),
    variant: product === "baseq3" ? { product } : { product, media: {
      weaponHoverSound: sound, blueProxMine: model("blueprox"), overloadBaseModel: model("base"), overloadEnergyModel: model("energy"),
      overloadLightsModel: model("lights"), overloadTargetModel: model("target"), obeliskRespawnSound: sound,
      harvesterModel: model("harvester"), harvesterNeutralModel: model("harvesterneutral"),
      harvesterRedSkin: { path: "red", surfaces: [] }, harvesterBlueSkin: { path: "blue", surfaces: [] },
    } },
  };
}

interface Loop { readonly entity: number; readonly origin: Vec3; readonly velocity: Vec3; readonly sound: PcmSound | null; readonly real: boolean }
class Recorder implements PacketEntityImports {
  readonly refs: RefEntity[] = [];
  readonly lights: DynamicLight[] = [];
  readonly positions: { readonly entity: number; readonly origin: Vec3 }[] = [];
  readonly loops: Loop[] = [];
  readonly starts: { readonly origin: Vec3 | null; readonly entity: number; readonly channel: number; readonly sound: PcmSound | null }[] = [];
  readonly order: string[] = [];
  readonly players: ClientEntity[] = [];
  readonly trails: MissileTrail[] = [];
  readonly powerups: { readonly entity: RefModelEntity; readonly state: EntityState; readonly team: Team }[] = [];
  nextRandom = 0;
  addRefEntity(entity: RefEntity): void { this.refs.push(entity); this.order.push(`ref:${entity.kind}`); }
  addLight(light: DynamicLight): void { this.lights.push(light); this.order.push("light"); }
  updateSoundPosition(entity: number, origin: Vec3): void { this.positions.push({ entity, origin }); this.order.push(`position:${entity}`); }
  addLoopSound(entity: number, origin: Vec3, velocity: Vec3, sound: PcmSound | null, real: boolean): void { this.loops.push({ entity, origin, velocity, sound, real }); this.order.push("loop"); }
  startSound(origin: Vec3 | null, entity: number, channel: number, sound: PcmSound | null): void { this.starts.push({ origin, entity, channel, sound }); this.order.push("sound"); }
  randomInteger(): number { this.order.push("random"); return this.nextRandom; }
  player(entity: ClientEntity): void { this.players.push(entity); this.order.push("player"); }
  missileTrail(kind: MissileTrail, _entity: ClientEntity, _weapon: PacketWeaponInfo): void { this.trails.push(kind); this.order.push(`trail:${kind}`); }
  grappleTrail(_entity: ClientEntity, _weapon: PacketWeaponInfo): void { this.order.push("grapple"); }
  addEntityWithPowerups(entity: RefModelEntity, state: EntityState, team: Team): void { this.powerups.push({ entity, state, team }); this.order.push("powerups"); }
}

function snapshot(product: Product, time: number, entities: readonly EntityState[] = []): RetailSnapshot {
  return { messageNumber: 1, serverTime: time, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
    areaMask: new Uint8Array(), playerState: createPlayerState(product), entities };
}

function fixture(product: Product = "baseq3", time = 1000) {
  const state = new ClientGameState(product, 0, 0), imports = new Recorder(), resources = media(product);
  state.snap = snapshot(product, time); state.time = time;
  state.autoAxis = identity; state.autoAxisFast = identity;
  const presenter = new PacketEntityPresenter(state, resources, imports);
  return { state, imports, resources, presenter };
}

function entity(state: ClientGameState, number: number, type: EntityType): ClientEntity {
  const result = state.entityAt(number);
  result.currentState.number = number; result.currentState.eType = type;
  result.currentState.pos = { type: TrajectoryType.TR_STATIONARY, time: 0, duration: 0, base: vec3(10, 20, 30), delta: zero };
  return result;
}

function refAt(imports: Recorder, index: number): RefEntity {
  const ref = imports.refs[index];
  if (ref === undefined) throw new Error(`missing submitted entity ${index}`);
  return ref;
}

function modelAt(imports: Recorder, index: number): RefModelEntity {
  const ref = refAt(imports, index);
  if (ref.kind !== "model") throw new Error(`expected model, got ${ref.kind}`);
  return ref;
}

function axisBits(axis: Axis): readonly (readonly number[])[] {
  return axis.map(row => [float32ToBits(row.x), float32ToBits(row.y), float32ToBits(row.z)]);
}

// Original q3lcc/CGAME QVM arithmetic capture, linked with unchanged q_math.c/bg_lib.c.
// /tmp/q3-cg-ents-math-oracle-aVPcrQ/{fixture.c,build.sh,run.sh,output.hex.log}.
// Independently compiled cg_ents.c assembly confirms the extracted expression order.
describe("original QVM packet entity numeric captures", () => {
  test("item bob and automatic axes preserve float bits across ordinary, negative and wrapped time", () => {
    const cases = [
      { time: 12345, z: 0x428d9054 }, { time: -1000, z: 0x42900000 },
      { time: -12345, z: 0x42850d80 }, { time: 2147483647, z: 0x428ac899 },
    ];
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) for (const value of cases) {
      const { state, presenter, imports } = fixture(product, value.time);
      const item = entity(state, 71, EntityType.ET_ITEM); item.currentState.modelindex = 1;
      item.currentState.pos = { ...item.currentState.pos, base: vec3(0, 0, 64) };
      state.snap = snapshot(product, value.time, [item.currentState.copy()]);
      presenter.addPacketEntities(options);
      expect(float32ToBits(item.lerpOrigin.z)).toBe(value.z);
      expect(float32ToBits(modelAt(imports, 0).origin.z)).toBe(value.z);
      if (value.time === 12345) {
        expect(float32ToBits(state.autoAngles.y)).toBe(0x41205000);
        expect(float32ToBits(state.autoAnglesFast.y)).toBe(0x41a05000);
        expect(axisBits(state.autoAxis)).toEqual([[0x3f7c187a, 0x3e3228d4, 0x80000000], [0xbe3228d4, 0x3f7c187a, 0], [0, 0, 0x3f800000]]);
        expect(axisBits(state.autoAxisFast)).toEqual([[0x3f708066, 0x3eaf713a, 0x80000000], [0xbeaf713a, 0x3f708066, 0], [0, 0, 0x3f800000]]);
      }
    }
  });

  test("speaker scheduling retains int overflow before QVM float conversion and truncates negative jitter", () => {
    const cases = [
      { time: 2147483600, random: 0, expected: -2147482240 },
      { time: 2147483600, random: 16384, expected: -2147481984 },
      { time: 2147483600, random: 32767, expected: -2147481728 },
      { time: -12345, random: 16384, expected: -10644 },
    ];
    for (const value of cases) {
      const { state, presenter, imports } = fixture("baseq3", value.time);
      const speaker = entity(state, 71, EntityType.ET_SPEAKER);
      speaker.miscTime = -20000; speaker.currentState.clientNum = 3; speaker.currentState.frame = 17; speaker.currentState.eventParm = 1;
      imports.nextRandom = value.random;
      presenter.addEntity(speaker, options);
      expect(speaker.miscTime).toBe(value.expected);
    }
  });

  test("obelisk threshold, acos spin, target axis scaling and byte color match original QVM", () => {
    const cases = [
      { elapsed: 5000, color: 0, axes: null },
      { elapsed: 6500, color: 76, axes: [[0x3e8c230c, 0x3dfb8af3, 0x80000000], [0xbdfb8af3, 0x3e8c230c, 0], [0, 0, 0x3e99999a]] },
      { elapsed: 11000, color: 255, axes: [[0x3f7746e9, 0x3e8483f4, 0x80000000], [0xbe8483f4, 0x3f7746e9, 0], [0, 0, 0x3f800000]] },
    ];
    for (const value of cases) {
      const { state, presenter, imports } = fixture("missionpack", value.elapsed + 1000);
      const base = entity(state, 71, EntityType.ET_TEAM); base.miscTime = 1000;
      base.currentState.frame = 2; base.currentState.angles = vec3(0, 15, 0);
      presenter.addEntity(base, { ...options, gameType: GameType.GT_OBELISK });
      expect(modelAt(imports, 1).shaderRGBA).toEqual(vec4(value.color, value.color, value.color, value.color));
      if (value.axes === null) { expect(imports.refs.length).toBe(2); expect(imports.starts.length).toBe(0); }
      else expect(axisBits(modelAt(imports, 2).axis)).toEqual(value.axes);
    }
  });
});

describe("source packet entity interpolation and order", () => {
  test("both-product protocol snapshots present through independent canonical entity copies", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const { state, presenter, imports } = fixture(product);
      const player = new EntityState(); player.number = 1; player.eType = EntityType.ET_PLAYER;
      player.pos = { ...player.pos, type: TrajectoryType.TR_LINEAR_STOP, time: 1000, duration: 50, base: vec3(32, 16, 8), delta: vec3(20, 0, 0) };
      const item = new EntityState(); item.number = 70; item.eType = EntityType.ET_ITEM; item.modelindex = 5;
      item.pos = { ...item.pos, base: vec3(4, 8, 12) };
      const context: ServerMessageContext = { product, messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
      const bytes = encodeServerMessage(0, [{ kind: "snapshot", validity: { kind: "valid" }, snapshot: snapshot(product, 1000, [player, item]) }], context);
      const operation = decodeServerMessage(bytes, context).operations[0];
      if (operation === undefined || operation.kind !== "snapshot" || operation.validity.kind !== "valid") throw new Error("snapshot decode failed");
      state.snap = retailSnapshot(operation.snapshot);
      for (const current of state.snap.entities) state.entityAt(current.number).currentState = current.copy();
      presenter.addPacketEntities({ ...options, smoothClients: false });
      expect(imports.players.length).toBe(2); expect(imports.refs.length).toBe(2);
      expect(state.entityAt(1).currentState.pos.type).toBe(TrajectoryType.TR_INTERPOLATE);
      expect(operation.snapshot.entities[0]?.pos.type).toBe(TrajectoryType.TR_LINEAR_STOP);
      expect(modelAt(imports, 0).origin.x).toBe(4);
      expect(encodeServerMessage(0, [operation], context)).toEqual(bytes);
    }
  });

  test("packet frame publishes predicted player first and copies no source snapshot state", () => {
    const { state, presenter, imports } = fixture();
    state.time = 1050;
    const general = entity(state, 71, EntityType.ET_GENERAL); general.currentState.modelindex = 1;
    general.currentState.frame = 7;
    state.snap = snapshot("baseq3", 1000, [general.currentState.copy()]);
    state.nextSnap = snapshot("baseq3", 1200);
    presenter.addPacketEntities(options);
    expect(state.frameInterpolation).toBe(.25);
    expect(imports.order).toEqual(["position:0", "player", "position:71", "ref:model"]);
    expect(imports.players[0]).toBe(state.predictedPlayerEntity);
    expect(state.autoAngles).toEqual(vec3(0, 184.5703125, 0));
    expect(state.autoAnglesFast).toEqual(vec3(0, 9.140625, 0));
    const ref = modelAt(imports, 0);
    expect(ref.frame).toBe(7); expect(ref.oldFrame).toBe(7); expect(ref.origin).toEqual(vec3(10, 20, 30));
    expect(ref.shaderRGBA).toEqual(vec4(0, 0, 0, 0));
  });

  test("packet auto axes use the original lcc float constant, not the renderer native profile", () => {
    const { state, presenter } = fixture("baseq3", 47);
    presenter.addPacketEntities(options);
    expect(state.autoAngles.y).toBe(8.26171875);
    // Original q_math.c QVM AngleVectors CNSTF4 1016003125 then MULF4.
    expect(float32ToBits(state.autoAxis[0].y)).toBe(1041441994);
    expect(float32ToBits(state.autoAxis[1].z)).toBe(0);
  });

  test("snapshot linear-stop clients lerp shortest angles; disabled smoothing mutates canonical trajectories", () => {
    const { state, presenter } = fixture();
    const client = entity(state, 3, EntityType.ET_PLAYER);
    state.time = 1025; state.frameInterpolation = .25; state.nextSnap = snapshot("baseq3", 1100);
    client.interpolate = true;
    client.currentState.pos = { ...client.currentState.pos, type: TrajectoryType.TR_LINEAR_STOP, time: 1000, duration: 100, delta: vec3(100, 0, 0) };
    client.nextState.pos = { ...client.currentState.pos, base: vec3(30, 40, 50), time: 1100 };
    client.currentState.apos = { ...client.currentState.apos, base: vec3(350, 10, 170) };
    client.nextState.apos = { ...client.nextState.apos, base: vec3(10, 350, -170) };
    presenter.calculateLerpPositions(client, true);
    expect(client.lerpOrigin).toEqual(vec3(15, 25, 35));
    expect(client.lerpAngles).toEqual(vec3(355, 5, 175));
    presenter.calculateLerpPositions(client, false);
    expect(client.currentState.pos.type).toBe(TrajectoryType.TR_INTERPOLATE);
    expect(client.nextState.pos.type).toBe(TrajectoryType.TR_INTERPOLATE);
    state.nextSnap = null;
    client.currentState.pos = { ...client.currentState.pos, type: TrajectoryType.TR_LINEAR_STOP };
    client.nextState.pos = { ...client.nextState.pos, type: TrajectoryType.TR_LINEAR_STOP };
    let failure: unknown;
    try { presenter.calculateLerpPositions(client, false); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CommonError);
    expect(failure).toMatchObject({ code: "drop", message: "CG_InterpoateEntityPosition: cg.nextSnap == NULL" });
    expect(client.currentState.pos.type).toBe(TrajectoryType.TR_INTERPOLATE);
    expect(client.nextState.pos.type).toBe(TrajectoryType.TR_INTERPOLATE);
    expect(client.lerpOrigin).toEqual(vec3(15, 25, 35));
    expect(client.lerpAngles).toEqual(vec3(355, 5, 175));
  });

  test("mover translation excludes predicted entity and preserves source no-rotation behavior", () => {
    const { state, presenter } = fixture();
    const mover = entity(state, 80, EntityType.ET_MOVER);
    mover.currentState.pos = { ...mover.currentState.pos, type: TrajectoryType.TR_LINEAR, time: 1000, delta: vec3(20, 30, 40) };
    mover.currentState.apos = { ...mover.currentState.apos, type: TrajectoryType.TR_LINEAR, time: 1000, delta: vec3(0, 90, 0) };
    expect(adjustPositionForMover(state, vec3(1, 2, 3), 80, 1000, 1500)).toEqual(vec3(11, 17, 23));
    for (const number of [0, 1022, 1023, 1]) expect(adjustPositionForMover(state, vec3(1, 2, 3), number, 1000, 1500)).toEqual(vec3(1, 2, 3));
    state.time = 1500;
    const standing = entity(state, 81, EntityType.ET_GENERAL); standing.currentState.groundEntityNum = 80;
    presenter.calculateLerpPositions(standing, true);
    expect(standing.lerpOrigin).toEqual(vec3(20, 35, 50));
    state.predictedPlayerEntity.currentState = standing.currentState.copy();
    presenter.calculateLerpPositions(state.predictedPlayerEntity, true);
    expect(state.predictedPlayerEntity.lerpOrigin).toEqual(vec3(10, 20, 30));
  });

  test("events skip before effects; invisible entities retain raw-byte constant lights and loops", () => {
    const { state, presenter, imports } = fixture();
    const event = entity(state, 80, EntityType.ET_EVENTS); event.currentState.loopSound = 1;
    presenter.addEntity(event, options);
    expect(imports.order).toEqual([]);
    const invisible = entity(state, 81, EntityType.ET_INVISIBLE);
    invisible.currentState.loopSound = 1; invisible.currentState.constantLight = 0x80302010;
    presenter.addEntity(invisible, options);
    expect(imports.order).toEqual(["position:81", "loop", "light"]);
    expect(imports.lights).toEqual([{ origin: vec3(10, 20, 30), radius: 512, color: vec3(16, 32, 48) }]);
    expect(imports.loops[0]?.real).toBe(false);
  });
});

describe("source packet render and sound types", () => {
  test("inline mover sound midpoint, secondary model and skin phase", () => {
    const { state, presenter, imports } = fixture("baseq3", 64);
    const mover = entity(state, 70, EntityType.ET_MOVER);
    mover.currentState.solid = 0xffffff; mover.currentState.modelindex = 1; mover.currentState.modelindex2 = 2;
    presenter.addEntity(mover, options);
    expect(imports.positions).toEqual([{ entity: 70, origin: vec3(18, 36, 54) }]);
    expect(modelAt(imports, 0).model.path).toBe("inline1"); expect(modelAt(imports, 0).skinNum).toBe(1);
    expect(modelAt(imports, 1).model.path).toBe("game2"); expect(modelAt(imports, 1).skinNum).toBe(0);
    expect(modelAt(imports, 0).renderFlags).toBe(64);
  });

  test("beam uses trajectory base; portal retains camera metadata and rolled basis", () => {
    const { state, presenter, imports } = fixture();
    const beam = entity(state, 70, EntityType.ET_BEAM);
    beam.currentState.pos = { ...beam.currentState.pos, type: TrajectoryType.TR_LINEAR, delta: vec3(100, 0, 0) };
    beam.currentState.origin2 = vec3(20, 30, 40);
    presenter.addEntity(beam, options);
    const beamRef = refAt(imports, 0);
    expect(beamRef.kind).toBe("beam"); expect(beamRef.origin).toEqual(vec3(10, 20, 30));
    if (beamRef.kind !== "beam") throw new Error("missing beam");
    expect(beamRef.oldOrigin).toEqual(vec3(20, 30, 40)); expect(beamRef.radius).toBe(0);
    const portal = entity(state, 71, EntityType.ET_PORTAL);
    portal.currentState.eventParm = 5; portal.currentState.clientNum = 129;
    portal.currentState.origin2 = vec3(1, 2, 3); portal.currentState.frame = 25; portal.currentState.powerups = 1;
    presenter.addEntity(portal, options);
    const ref = refAt(imports, 1);
    if (ref.kind !== "portal-surface") throw new Error("missing portal");
    expect(ref.axis).toEqual([vec3(0, 0, 1), vec3(-1, 0, 0), vec3(0, -1, 0)]);
    expect(ref.skinNum).toBe(181); expect(ref.frame).toBe(25); expect(ref.oldFrame).toBe(1);
    expect(ref.oldOrigin).toEqual(vec3(1, 2, 3));
  });

  test("speaker real loop and source 15-bit random timing", () => {
    for (const [random, expected] of [[0, 13745], [16384, 14045], [32767, 14345]]) {
      if (random === undefined || expected === undefined) throw new Error("bad random fixture");
      const { state, presenter, imports } = fixture("baseq3", 12345);
      const speaker = entity(state, 80, EntityType.ET_SPEAKER);
      speaker.currentState.clientNum = 3; speaker.currentState.frame = 17; speaker.currentState.eventParm = 1; speaker.currentState.loopSound = 1;
      imports.nextRandom = random;
      presenter.addEntity(speaker, options);
      expect(speaker.miscTime).toBe(expected);
      expect(imports.order).toEqual(["position:80", "loop", "sound", "random"]);
      expect(imports.loops[0]?.real).toBe(true);
      expect(imports.starts[0]).toEqual({ origin: null, entity: 80, channel: 4, sound });
      presenter.addEntity(speaker, options); expect(imports.starts.length).toBe(1);
    }
  });

  test("missile and grapple direction fallback uses the original length", () => {
    for (const type of [EntityType.ET_MISSILE, EntityType.ET_GRAPPLE]) {
      for (const delta of [vec3(-0, -0, -0), vec3(-1e-30, 1e-30, -1e-30)]) {
        const { state, imports, presenter } = fixture();
        const missile = entity(state, 80, type);
        missile.currentState.weapon = Weapon.WP_ROCKET_LAUNCHER;
        missile.currentState.pos = { ...missile.currentState.pos, delta };
        presenter.addEntity(missile, options);
        const ref = type === EntityType.ET_MISSILE ? imports.powerups[0]?.entity : modelAt(imports, 0);
        if (ref === undefined) throw new Error("missing missile submission");
        expect(axisBits(ref.axis)[0]).toEqual([0, 0, 0x3f800000]);
      }
    }
    const { state, imports, presenter } = fixture();
    const grapple = entity(state, 80, EntityType.ET_GRAPPLE);
    grapple.currentState.weapon = Weapon.WP_ROCKET_LAUNCHER;
    grapple.currentState.pos = { ...grapple.currentState.pos, delta: vec3(1e30, -1e30, 1e30) };
    presenter.addEntity(grapple, options);
    expect(axisBits(modelAt(imports, 0).axis)[0]).toEqual([0, 0x80000000, 0]);
  });

  test("missile trail/light/velocity order, plasma sprite and grapple zero axes", () => {
    const { state, resources, imports } = fixture();
    const base = resources.weapons[0];
    if (base === undefined) throw new Error("missing test weapon");
    const rocket: PacketWeaponInfo = { ...base, missileTrail: "rocket", missileSound: sound, missileDlight: 200, missileDlightColor: vec3(1, .75, 0) };
    const presenter = new PacketEntityPresenter(state, { ...resources, weapons: Array.from({ length: 64 }, () => rocket) }, imports);
    const missile = entity(state, 80, EntityType.ET_MISSILE);
    missile.currentState.weapon = Weapon.WP_ROCKET_LAUNCHER;
    missile.currentState.pos = { ...missile.currentState.pos, type: TrajectoryType.TR_GRAVITY, time: 1000, delta: vec3(10, 20, 30) };
    state.time = 1250; state.clientFrame = 3;
    presenter.addEntity(missile, options);
    expect(imports.order).toEqual(["position:80", "trail:rocket", "light", "loop", "powerups"]);
    expect(imports.loops[0]?.velocity).toEqual(vec3(10, 20, -170));
    expect(imports.powerups[0]?.entity.skinNum).toBe(1);
    missile.currentState.weapon = Weapon.WP_PLASMAGUN;
    presenter.addEntity(missile, options);
    const plasma = refAt(imports, 0);
    if (plasma.kind !== "sprite") throw new Error("missing plasma sprite");
    expect(plasma.radius).toBe(16); expect(plasma.shaderRGBA).toEqual(vec4(0, 0, 0, 0));
    missile.currentState.eType = EntityType.ET_GRAPPLE; missile.currentState.pos = { ...missile.currentState.pos, delta: zero };
    presenter.addEntity(missile, options);
    expect(modelAt(imports, 1).axis).toEqual([vec3(0, 0, 1), zero, zero]);
    missile.currentState.weapon = 99;
    presenter.addEntity(missile, options); expect(missile.currentState.weapon).toBe(0);
  });
});

describe("source item and Team Arena presentation", () => {
  test("simple items skip bob and use opaque icon sprites", () => {
    const { state, presenter, imports } = fixture();
    const item = entity(state, 71, EntityType.ET_ITEM); item.currentState.modelindex = 5;
    presenter.addEntity(item, { ...options, simpleItems: true });
    const ref = refAt(imports, 0);
    if (ref.kind !== "sprite") throw new Error("missing item sprite");
    expect(ref.radius).toBe(14); expect(ref.origin).toEqual(vec3(10, 20, 30));
    expect(ref.shaderRGBA).toEqual(vec4(255, 255, 255, 255)); expect(item.lerpOrigin).toEqual(vec3(10, 20, 30));
  });

  test("health has independently oriented shell, source scale ramp, and no shared submission mutation", () => {
    const { state, presenter, imports } = fixture("baseq3", 1500);
    state.autoAxisFast = anglesToAxis(vec3(0, 90, 0)); state.autoAnglesFast = vec3(0, 90, 0);
    const item = entity(state, 71, EntityType.ET_ITEM); item.currentState.modelindex = 5; item.miscTime = 1250;
    presenter.addEntity(item, options);
    const cross = modelAt(imports, 0), shell = modelAt(imports, 1);
    expect(cross.model.path).toContain("medium_cross"); expect(shell.model.path).toContain("medium_sphere");
    expect(cross.axis[0].y).toBe(.25); expect(shell.axis[0].x).toBe(.25);
    expect(cross.nonNormalizedAxes).toBe(true); expect(item.lerpAngles).toEqual(vec3(0, 90, 0));
    expect(shell.origin).toEqual(cross.origin); expect(shell.oldOrigin).toEqual(cross.origin);
    const firstOrigin = cross.origin;
    state.time = 2000; presenter.addEntity(item, options);
    expect(cross.origin).toEqual(firstOrigin);
  });

  test("mission weapon hover uses offset bobbed origin, and barrel inherits scaled parent axis", () => {
    const { state, resources, imports } = fixture("missionpack", 2000);
    const base = resources.weapons[0]; if (base === undefined) throw new Error("missing test weapon");
    const weapon = { ...base, barrelModel: model("barrel") };
    const presenter = new PacketEntityPresenter(state, { ...resources, weapons: Array.from({ length: 64 }, () => weapon) }, imports);
    const item = entity(state, 70, EntityType.ET_ITEM);
    item.currentState.modelindex = itemList("missionpack").findIndex(item => item.type === ItemType.IT_WEAPON);
    presenter.addEntity(item, options);
    const ref = modelAt(imports, 0), barrel = modelAt(imports, 1);
    expect(ref.origin.x).toBe(8); expect(ref.origin.y).toBe(17); expect(ref.axis[0].x).toBe(1.5);
    expect(ref.renderFlags).toBe(1); expect(barrel.model.path).toBe("barrel"); expect(barrel.axis).toEqual(ref.axis);
    expect(barrel.origin).toEqual(ref.origin); expect(barrel.oldOrigin).toEqual(zero);
    expect(imports.positions[0]?.origin).toEqual(vec3(10, 20, 30)); expect(imports.loops[0]?.origin).toEqual(ref.origin);
  });

  test("obelisk hit, respawn threshold, single sound, target flags and reset", () => {
    const { state, presenter, imports } = fixture("missionpack", 1000);
    const base = entity(state, 80, EntityType.ET_TEAM); base.currentState.frame = 1; base.currentState.modelindex2 = 100;
    const obelisk = { ...options, gameType: GameType.GT_OBELISK };
    presenter.addEntity(base, obelisk);
    expect(imports.refs.map(ref => ref.kind === "model" ? ref.model.path : ref.kind)).toEqual(["base", "energy", "lights", "target"]);
    expect(modelAt(imports, 0).shaderRGBA).toEqual(vec4(0, 0, 0, 0));
    expect(modelAt(imports, 1).shaderRGBA).toEqual(vec4(255, 100, 100, 255));
    base.currentState.frame = 2; state.time = 2000; presenter.addEntity(base, obelisk);
    expect(base.miscTime).toBe(2000); expect(imports.starts.length).toBe(0);
    state.time = 8500; presenter.addEntity(base, obelisk);
    const lights = modelAt(imports, 7), target = modelAt(imports, 8);
    expect(lights.shaderRGBA).toEqual(vec4(76, 76, 76, 76));
    expect(target.nonNormalizedAxes).toBe(false); expect(target.origin.z).toBe(86);
    expect(imports.starts).toEqual([{ origin: vec3(10, 20, 30), entity: 1023, channel: 5, sound }]);
    expect(base.muzzleFlashTime).toBe(1);
    presenter.addEntity(base, obelisk); expect(imports.starts.length).toBe(1);
    base.currentState.frame = 0; presenter.addEntity(base, obelisk);
    expect(base.miscTime).toBe(0); expect(base.muzzleFlashTime).toBe(0);
  });

  test("CTF and Harvester choose actual team handles, baseq3 omits mission-only bases", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const { state, presenter, imports } = fixture(product);
      const base = entity(state, 80, EntityType.ET_TEAM); base.currentState.modelindex = Team.TEAM_BLUE;
      presenter.addEntity(base, { ...options, gameType: GameType.GT_CTF });
      expect(modelAt(imports, 0).model.path).toBe("blueflag");
      presenter.addEntity(base, { ...options, gameType: GameType.GT_HARVESTER });
      if (product === "missionpack") { expect(modelAt(imports, 1).model.path).toBe("harvester"); expect(modelAt(imports, 1).customSkin?.path).toBe("blue"); }
      else expect(imports.refs.length).toBe(1);
    }
  });
});

test("tag positioning preserves missing-tag source identity, parent backlerp and rotated child's own backlerp", () => {
  const parent = createModelEntity(); parent.origin = vec3(10, 20, 30); parent.axis = identity; parent.backLerp = .3;
  const child = createModelEntity(); child.axis = anglesToAxis(vec3(0, 90, 0)); child.backLerp = .7;
  positionRotatedEntityOnTag(child, parent, DEFAULT_MODEL, "tag_missing");
  expect(child.origin).toEqual(parent.origin); expect(child.backLerp).toBe(.7); expect(child.axis[0].y).toBe(1);
  positionEntityOnTag(child, parent, DEFAULT_MODEL, "tag_missing");
  expect(child.axis).toEqual(identity); expect(child.backLerp).toBe(.3);
  expect(float32ToBits(child.origin.z)).toBe(0x41f00000);
});

test("bad item errors, no-draw and zero model respect effect ordering", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const { state, presenter, imports } = fixture(product);
    const item = entity(state, 70, EntityType.ET_ITEM);
    item.currentState.loopSound = 1; item.currentState.eFlags = 0x80;
    item.currentState.modelindex = itemList(product).length;
    let failure: unknown;
    try { presenter.addEntity(item, options); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CommonError);
    expect(failure).toMatchObject({ code: "drop", message: `Bad item index ${item.currentState.modelindex} on entity` });
    expect(imports.order).toEqual(["position:70", "loop"]);
    expect(item.lerpOrigin).toEqual(vec3(10, 20, 30));
    expect(imports.refs).toHaveLength(0);
  }
  const { state, presenter, imports } = fixture();
  const item = entity(state, 70, EntityType.ET_ITEM); item.currentState.loopSound = 1;
  item.currentState.modelindex = 999;
  expect(() => presenter.addEntity(item, options)).toThrow("Bad item index");
  expect(imports.order).toEqual(["position:70", "loop"]);
  item.currentState.modelindex = 5; item.currentState.eFlags = 0x80;
  presenter.addEntity(item, options); expect(imports.refs.length).toBe(0);
  const general = entity(state, 71, EntityType.ET_GENERAL);
  presenter.addEntity(general, options); expect(imports.refs.length).toBe(0);
  general.currentState.eType = EntityType.ET_MOVER;
  presenter.addEntity(general, options); expect(modelAt(imports, 0).model).toBe(DEFAULT_MODEL);
});

test("unknown entity type drops after interpolation and automatic effects", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const { state, presenter, imports } = fixture(product);
    const invalid = entity(state, 70, EntityType.ET_GENERAL);
    invalid.currentState.eType = -1;
    invalid.currentState.loopSound = 1; invalid.currentState.constantLight = 0x80302010;
    let failure: unknown;
    try { presenter.addEntity(invalid, options); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CommonError);
    expect(failure).toMatchObject({ code: "drop", message: "Bad entity type: -1\n" });
    expect(invalid.lerpOrigin).toEqual(vec3(10, 20, 30));
    expect(imports.order).toEqual(["position:70", "loop", "light"]);
    expect(imports.refs).toHaveLength(0);
  }
});

test("failed optional model registrations preserve source zero-handle branch checks", () => {
  const { state, resources, imports } = fixture("missionpack", 2000);
  const base = resources.weapons[0]; if (base === undefined) throw new Error("missing weapon fixture");
  const presenter = new PacketEntityPresenter(state, { ...resources,
    weapons: Array.from({ length: 64 }, () => ({ ...base, barrelModel: DEFAULT_MODEL })),
    items: resources.items.map(item => ({ ...item, models: [item.models[0], DEFAULT_MODEL] })),
  }, imports);
  const item = entity(state, 70, EntityType.ET_ITEM); item.currentState.modelindex = 5;
  presenter.addEntity(item, options); expect(imports.refs.length).toBe(1);
  item.currentState.modelindex = itemList("missionpack").findIndex(item => item.type === ItemType.IT_WEAPON);
  presenter.addEntity(item, options); expect(imports.refs.length).toBe(2);
});

test("powerup rings spin backwards without changing oldorigin; team icons remain models", () => {
  const { state, presenter, imports } = fixture("missionpack", 2048 + 256);
  const powerup = entity(state, 71, EntityType.ET_ITEM);
  powerup.currentState.modelindex = itemList("missionpack").findIndex(item => item.type === ItemType.IT_POWERUP);
  presenter.addEntity(powerup, options);
  const base = modelAt(imports, 0), ring = modelAt(imports, 1);
  expect(ring.origin.z).toBe(Math.fround(base.origin.z + 12)); expect(ring.oldOrigin).toEqual(base.origin);
  expect(ring.axis[0].y).toBe(-1);
  const team = entity(state, 72, EntityType.ET_ITEM);
  team.currentState.modelindex = itemList("missionpack").findIndex(item => item.type === ItemType.IT_TEAM);
  presenter.addEntity(team, { ...options, simpleItems: true });
  expect(refAt(imports, 2).kind).toBe("model");
});

test("mission kamikaze doubles item axes and blue stationary prox uses snapshot angles", () => {
  const { state, presenter, imports } = fixture("missionpack", 2000);
  const kamikaze = entity(state, 70, EntityType.ET_ITEM);
  kamikaze.currentState.modelindex = itemList("missionpack").findIndex(item => item.className === "holdable_kamikaze");
  presenter.addEntity(kamikaze, options); expect(modelAt(imports, 0).axis[0].x).toBe(2);
  const mine = entity(state, 71, EntityType.ET_MISSILE);
  mine.currentState.weapon = Weapon.WP_PROX_LAUNCHER; mine.currentState.generic1 = Team.TEAM_BLUE; mine.currentState.angles = vec3(0, 90, 0);
  presenter.addEntity(mine, options);
  const ref = imports.powerups[0]?.entity;
  if (ref === undefined) throw new Error("missing prox submission");
  expect(ref.model.path).toBe("blueprox"); expect(ref.axis[0].y).toBe(1);
});

test("weapon upper bound is strictly greater, frame interpolation allows zero and extrapolation", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const { state, presenter } = fixture(product);
    const missile = entity(state, 71, EntityType.ET_MISSILE), boundary = product === "baseq3" ? 11 : 14;
    missile.currentState.weapon = boundary;
    presenter.addEntity(missile, options); expect(missile.currentState.weapon).toBe(boundary);
    missile.currentState.weapon = boundary + 1;
    presenter.addEntity(missile, options); expect(missile.currentState.weapon).toBe(0);
    state.nextSnap = snapshot(product, 1000); state.time = 1020;
    presenter.addPacketEntities(options); expect(state.frameInterpolation).toBe(0);
    state.nextSnap = snapshot(product, 1010);
    presenter.addPacketEntities(options); expect(state.frameInterpolation).toBe(2);
    state.nextSnap = null;
    presenter.addPacketEntities(options); expect(state.frameInterpolation).toBe(0);
  }
});

test("real tag frame interpolation and parent-scaled basis are applied in source order", () => {
  const md3: Md3Model = {
    name: "synthetic-tag", flags: 0, skinCount: 0, surfaces: [],
    frames: [0, 1].map(() => ({ name: "frame", bounds: { min: zero, max: zero }, origin: zero, radius: 1 })),
    tags: [[{ name: "tag_child", origin: vec3(1, 2, 3), axes: identity }], [{ name: "tag_child", origin: vec3(5, 6, 7), axes: identity }]],
  };
  const model: SceneModel = { kind: "md3", path: "synthetic-tag", md3: [md3, null, null], numLods: 1, md4: null };
  const parent = createModelEntity(model), child = createModelEntity();
  parent.origin = vec3(10, 20, 30); parent.axis = [vec3(0, 2, 0), vec3(-2, 0, 0), vec3(0, 0, 2)];
  parent.oldFrame = 0; parent.frame = 1; parent.backLerp = .75;
  positionEntityOnTag(child, parent, model, "tag_child");
  expect(child.origin).toEqual(vec3(4, 24, 38)); expect(child.axis).toEqual(parent.axis); expect(child.backLerp).toBe(.75);
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("retail both-product item registrations feed packet presentation and renderer-owned model handles", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const images = new RendererImageCatalog();
    const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Packet entity model parity", width: 64, height: 64, backend: "gl", hidden: true }) : null;
    const gl = window === null ? null : new GlRenderer(window, images);
    const settings = createRendererSettings();
    gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const cpu = new SoftwareRenderer(64, 64, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
    const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
    const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 5000 };
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
    let commands: RenderCommandBuffer | null = null;
    try {
      const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
      commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
      const visuals = await Promise.all(itemList(product).map(async item => {
        const first = item.worldModels[0] === null ? DEFAULT_MODEL : await resources.registerModel(item.worldModels[0]);
        const second = item.worldModels[1] === null ? null : await resources.registerModel(item.worldModels[1]);
        const icon = item.icon === null ? null : await resources.registerShader(item.icon);
        const models: readonly [SceneModel, SceneModel | null] = [first, second];
        return { models, icon };
      }));
      const { state, resources: base, imports } = fixture(product, 5000);
      const presenter = new PacketEntityPresenter(state, { ...base, items: visuals }, imports);
      for (let index = 1; index < visuals.length; index++) {
        const current = entity(state, 70 + index, EntityType.ET_ITEM); current.currentState.modelindex = index;
        presenter.addEntity(current, options);
        const visual = visuals[index];
        if (visual === undefined) throw new Error("missing registered retail item");
        expect(visual.models[0].kind).toBe("md3");
        expect(await resources.registerModel(visual.models[0].path)).toBe(visual.models[0]);
      }
      expect(imports.refs.length).toBeGreaterThan(visuals.length - 1);
      const cross = imports.refs.find(ref => ref.kind === "model" && ref.model.path.includes("medium_cross"));
      if (cross === undefined || cross.kind !== "model") throw new Error("missing real health model submission");
      commands.addView({ viewport: { x: 0, y: 0, width: 64, height: 64 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
      commands.addPreparedViews(resources.prepareFrame({ refdef: { ...state.refdef, viewOrigin: vec3(100, 20, 30), viewAxis: anglesToAxis(vec3(0, 180, 0)), width: 64, height: 64, fovX: 90, fovY: 90, time: 5000, renderFlags: 1 }, entities: [cross] }));
      commands.submit();
      const batches = recording.trace().flatMap(view => view.batches);
      expect(batches.length).toBeGreaterThan(0);
      expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value !== 0).length).toBeGreaterThan(30);
      if (gl !== null) {
        const pixels = gl.readPixels();
        let error = 0;
        for (let index = 0; index < pixels.length; index++) {
          const expected = cpu.pixels[index], actual = pixels[index];
          if (expected === undefined || actual === undefined) throw new Error("missing frame pixel");
          error += Math.abs(actual - expected);
        }
        expect(error / pixels.length).toBeLessThan(2);
      }
    } finally { commands?.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
  }
}, 120000);
