import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { vec3 } from "../src/core/math.ts";
import { encodePng } from "../src/core/png.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import type { DynamicLight } from "../src/render/lighting.ts";
import type { SourceRefEntity, RefModelEntity } from "../src/render/ref-entity.ts";
import type { WorldFrame } from "../src/render/world.ts";
import { Weapon } from "../src/shared/definitions.ts";
import { PlayerAnimation } from "../src/shared/player-state.ts";
import { BasePlayerInfo, BaseUiPlayers } from "../src/ui/base/players.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
type CapturedFrame = Omit<WorldFrame, "entities"> & { readonly entities: readonly SourceRefEntity[] };
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const rect = { x: 0, y: 0, width: 320, height: 480 };
const idle = { legsAnim: PlayerAnimation.LEGS_IDLE, torsoAnim: PlayerAnimation.TORSO_STAND,
  viewAngles: vec3(0, 150, 0), moveAngles: vec3(0, 150, 0), weaponNumber: -1, chat: false };

async function preview() {
  const base = await baseFixture(320, 240); cleanups.push(base.close);
  const home = await mkdtemp(join(tmpdir(), "quake3-ui-players-"));
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }); });
  await mkdir(join(home, "baseq3/models/players/sarge"), { recursive: true });
  const data = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: data, homePath: home, cdPath: null, product: "baseq3" }, text => { base.prints.push(text); }, sound, base.cvars);
  cleanups.push(() => { try { files.close(); } finally { sound.close(); } });
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => { base.state.assertActive(); });
  const scenes: CapturedFrame[] = [], lights: DynamicLight[] = [];
  const render = base.resources.renderScene.bind(base.resources), clear = base.resources.clearScene.bind(base.resources);
  const addLight = base.resources.addLight.bind(base.resources);
  base.resources.clearScene = () => { lights.length = 0; return clear(); };
  base.resources.addLight = light => { lights.push(light); return addLight(light); };
  base.resources.renderScene = refdef => {
    scenes.push({ refdef, entities: base.resources.sceneEntities.sceneRange().copyRefEntities(), dynamicLights: lights.slice() });
    return render(refdef);
  };
  const players = new BaseUiPlayers(base.state, files), info = new BasePlayerInfo();
  return { ...base, files, home, scenes, players, info };
}
function model(scene: CapturedFrame | undefined, index: number): RefModelEntity {
  const entity = scene?.entities?.[index];
  if (entity?.kind !== "model") throw new Error(`Missing actual preview model ${index}`);
  if (typeof entity.model === "number" || typeof entity.customShader === "number" || typeof entity.customSkin === "number")
    throw new Error("Typed preview caller submitted a numeric resource");
  return { ...entity, model: entity.model, customShader: entity.customShader, customSkin: entity.customSkin };
}

test("player preview uses Q3_VM sine over cosine at both tangent call sites", async () => {
  const p = await preview(); await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, idle);
  const f = Math.fround, pi = f(Math.PI), angle = f(f(2 / 360) * pi);
  const xx = f(15 / f(f(Math.sin(angle)) / f(Math.cos(angle))));
  expect(xx).toBe(859.349365234375);
  expect(xx).not.toBe(f(15 / f(Math.tan(angle))));
  await p.players.drawPlayer({ x: 0, y: 0, width: 30, height: 100 }, p.info, 100);
  const scene = p.scenes[0]; if (scene === undefined) throw new Error("Missing actual preview scene");
  expect(scene.refdef.fovX).toBe(2);
  expect(scene.refdef.fovY).toBe(f(f(Math.atan2(50, xx)) * f(360 / Math.PI)));
  const originAngle = f(f(f(2 * pi) / 180) * .5);
  const origin = f(f(f(.7) * 56) / f(f(Math.sin(originAngle)) / f(Math.cos(originAngle))));
  expect(origin).not.toBe(f(f(f(.7) * 56) / f(Math.tan(originAngle))));
  expect(model(scene, 0).origin.x).toBe(origin);
});

test("source zero storage, actual sarge media and stable embedded animation cells", async () => {
  const p = await preview(), legs = p.info.legs, torso = p.info.torso, rows = p.info.animations, first = rows[0];
  expect(rows).toHaveLength(31); expect(p.info.pendingWeapon).toBe(0); expect(p.info.newModel).toBe(false);
  expect(p.info.legsModel).toBe(DEFAULT_MODEL); expect(p.info.legs.currentAnimation).toBeNull();
  await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, idle);
  expect(p.info.legsModel.path).toBe("models/players/sarge/lower.md3");
  expect(p.info.legsSkin?.path).toBe("models/players/sarge/lower_default.skin");
  expect(p.info.weaponModel.path).toBe("models/weapons2/machinegun/machinegun.md3");
  expect(p.info.animations[0]).toMatchObject({ firstFrame: 0, numFrames: 30, frameLerp: 50 });
  expect(p.info.animations[PlayerAnimation.LEGS_IDLE]).toMatchObject({ firstFrame: 166, numFrames: 10, loopFrames: 10, frameLerp: 66 });
  // UI keeps the missing rows' atoi("") values and subtracts the legs skip even from torso rows.
  expect(p.info.animations[30]).toMatchObject({ firstFrame: -63, numFrames: 0, loopFrames: 0, frameLerp: 1000, reversed: false });
  p.state.frameTime = 16;
  await p.players.drawPlayer(rect, p.info, 100);
  const cached = p.info.legs.currentAnimation;
  await p.players.registerClientModelname(p.info, "sarge/red");
  expect(p.info.legs.currentAnimation).toBe(cached);
  expect(p.info.legsSkin?.path).toBe("models/players/sarge/lower_red.skin");
  await p.players.setModel(p.info, "visor/blue");
  expect(p.info.legs).toBe(legs); expect(p.info.torso).toBe(torso); expect(p.info.animations).toBe(rows); expect(p.info.animations[0]).toBe(first);
  expect(p.info.legs.currentAnimation).toBeNull(); expect(p.info.newModel).toBe(true);
  expect(p.info.legsModel.path).toBe("models/players/visor/lower.md3");
});

test("retail preview submits source body tags, viewport, weapon, chat and accent lights to CPU", async () => {
  const p = await preview();
  await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, { ...idle, chat: true });
  p.state.frameTime = 16;
  await p.players.drawPlayer(rect, p.info, 100);
  const scene = p.scenes[0];
  expect(scene?.refdef).toMatchObject({ x: 0, y: 0, width: 160, height: 240, fovX: 22, time: 100, renderFlags: 1 });
  expect(scene?.entities).toHaveLength(6);
  const legs = model(scene, 0), torso = model(scene, 1), head = model(scene, 2), gun = model(scene, 3), barrel = model(scene, 4);
  expect(legs.oldOrigin).toEqual(legs.origin); expect(legs.lightingOrigin).toEqual(legs.origin);
  expect(torso.origin.z).toBeGreaterThan(legs.origin.z); expect(head.origin.z).toBeGreaterThan(torso.origin.z);
  expect(gun.model.path).toContain("machinegun.md3"); expect(barrel.model.path).toContain("machinegun_barrel.md3");
  expect(scene?.entities?.[5]).toMatchObject({ kind: "sprite", origin: { z: 44 }, radius: 10, customShader: { name: "sprites/balloon3" } });
  expect(scene?.dynamicLights).toHaveLength(2);
  p.commands.submit();
  expect(p.recorder.trace()[0]?.state.viewport).toEqual({ x: 0, y: 0, width: 160, height: 240 });
  expect(p.recorder.trace()[0]?.batches.some(batch => batch.indices.length > 100)).toBe(true);
  let colored = 0;
  for (let i = 0; i < p.cpu.pixels.length; i += 4) if (p.cpu.pixels[i] !== 0) colored++;
  expect(colored).toBeGreaterThan(1000);
  const image = process.env["Q3_UI_PREVIEW_IMAGE"];
  if (image !== undefined) await Bun.write(image, encodePng(p.cpu.width, p.cpu.height, p.cpu.pixels));
});

test("shared jump height uses the previous draw value, UI frame time and pending land/run", async () => {
  const p = await preview(), second = new BasePlayerInfo();
  await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, idle);
  await p.players.setModel(second, "visor"); await p.players.setInfo(second, idle);
  await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.LEGS_JUMP });
  p.state.frameTime = 500;
  await p.players.drawPlayer(rect, p.info, 100);
  expect(p.info.legsAnimationTimer).toBe(500); expect(p.scenes[0]?.refdef.y).toBe(0);
  p.state.frameTime = 0;
  await p.players.drawPlayer(rect, second, 200);
  expect(p.scenes[1]?.refdef.y).toBe(-56);
  await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.LEGS_RUN });
  expect(p.info.pendingLegsAnim).toBe(PlayerAnimation.LEGS_RUN);
  p.state.frameTime = 500; await p.players.drawPlayer(rect, p.info, 201);
  expect(p.scenes[2]?.refdef.y).toBe(-56); expect(p.info.legsAnim & ~128).toBe(PlayerAnimation.LEGS_LAND); expect(p.info.legsAnimationTimer).toBe(130);
  p.state.frameTime = 130; await p.players.drawPlayer(rect, p.info, 202);
  expect(p.scenes[3]?.refdef.y).toBe(0); expect(p.info.legsAnim & ~128).toBe(PlayerAnimation.LEGS_RUN); expect(p.info.pendingLegsAnim).toBe(0);
});

test("weapon delay is strict, uses both players' shared clock, and drop/register/raise preserves timing", async () => {
  const p = await preview(), second = new BasePlayerInfo();
  p.state.media.weaponChange = await p.soundBank.registerSound("sound/weapons/change.wav", false);
  await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, idle);
  await p.players.setModel(second, "sarge"); await p.players.setInfo(second, idle);
  await p.players.drawPlayer(rect, second, 1000);
  await p.players.setInfo(p.info, { ...idle, weaponNumber: Weapon.WP_ROCKET_LAUNCHER });
  expect(p.info.weaponTimer).toBe(1250);
  await p.players.drawPlayer(rect, p.info, 1250); expect(p.info.pendingWeapon).toBe(Weapon.WP_ROCKET_LAUNCHER);
  await p.players.drawPlayer(rect, p.info, 1251);
  expect(p.info.pendingWeapon).toBe(-1); expect(p.info.currentWeapon).toBe(Weapon.WP_MACHINEGUN);
  expect(p.info.torsoAnim & ~128).toBe(PlayerAnimation.TORSO_DROP); expect(p.info.torsoAnimationTimer).toBe(300);
  expect(p.events).toContain("sound:sound/weapons/change.wav:1");
  p.state.frameTime = 300; await p.players.drawPlayer(rect, p.info, 1252);
  expect(p.info.currentWeapon).toBe(Weapon.WP_ROCKET_LAUNCHER); expect(p.info.realWeapon).toBe(Weapon.WP_ROCKET_LAUNCHER);
  expect(p.info.weaponModel.path).toBe("models/weapons2/rocketl/rocketl.md3"); expect(p.info.torsoAnim & ~128).toBe(PlayerAnimation.TORSO_RAISE);
  await p.players.drawPlayer(rect, p.info, 1253); expect(p.info.torsoAnim & ~128).toBe(PlayerAnimation.TORSO_STAND);
});

test("attack flash consumes the UI rand owner and real gauntlet uses attack2 and pitch barrel spin", async () => {
  const p = await preview(); await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, idle);
  await p.players.drawPlayer(rect, p.info, 100);
  await p.players.setInfo(p.info, { ...idle, torsoAnim: PlayerAnimation.TORSO_ATTACK });
  expect(p.info.muzzleFlashTime).toBe(120); expect(p.info.torsoAnimationTimer).toBe(500);
  p.state.random.reset(0); await p.players.drawPlayer(rect, p.info, 120);
  expect(p.state.random.seed).toBe(1); expect(p.scenes[1]?.dynamicLights?.[0]?.radius).toBe(201); expect(p.info.barrelSpinning).toBe(true);
  await p.players.drawPlayer(rect, p.info, 121); expect(p.state.random.seed).toBe(1); expect(p.scenes[2]?.dynamicLights).toHaveLength(2);
  await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, { ...idle, weaponNumber: Weapon.WP_GAUNTLET });
  await p.players.setInfo(p.info, { ...idle, torsoAnim: PlayerAnimation.TORSO_ATTACK });
  expect(p.info.torsoAnim & ~128).toBe(PlayerAnimation.TORSO_ATTACK2); expect(p.info.realWeapon).toBe(Weapon.WP_GAUNTLET);
  await p.players.drawPlayer(rect, p.info, 122);
  expect(model(p.scenes[3], 4).model.path).toContain("gauntlet_barrel.md3");
});

test("requested unknown weapon falls back to actual machinegun without replacing currentWeapon", async () => {
  const p = await preview(); await p.players.setModel(p.info, "sarge");
  await p.players.setInfo(p.info, { ...idle, weaponNumber: 99 });
  expect(p.info.currentWeapon).toBe(99); expect(p.info.realWeapon).toBe(Weapon.WP_MACHINEGUN);
  expect(p.info.weaponModel.path).toBe("models/weapons2/machinegun/machinegun.md3");
  await p.players.setInfo(p.info, { ...idle, weaponNumber: -1 });
  expect(p.info.pendingWeapon).toBe(-1); expect(p.info.weaponTimer).toBe(0);
  await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.BOTH_DEATH1 });
  expect(p.info.currentWeapon).toBe(Weapon.WP_NONE); expect(p.info.realWeapon).toBe(Weapon.WP_NONE); expect(p.info.weaponModel).toBe(DEFAULT_MODEL);
});

test("missing model and failed requested skin preserve source partial stores", async () => {
  const p = await preview(); await p.players.setModel(p.info, "sarge/no-such-skin");
  expect(p.info.legsSkin?.path).toBe("models/players/sarge/lower_default.skin");
  const oldLegs = p.info.legsModel, oldSkin = p.info.legsSkin, first = p.info.animations[0];
  expect(await p.players.registerClientModelname(p.info, "")).toBe(false);
  expect(p.info.legsModel).toBe(oldLegs); expect(p.info.torsoModel).toBe(DEFAULT_MODEL); expect(p.info.legsSkin).toBe(oldSkin); expect(p.info.animations[0]).toBe(first);
  await p.players.setModel(p.info, "no-such-player");
  expect(p.info.legsModel).toBe(DEFAULT_MODEL); expect(p.info.currentWeapon).toBe(Weapon.WP_MACHINEGUN); expect(p.info.newModel).toBe(true);
  await p.players.drawPlayer(rect, p.info, 9000);
  await p.players.setInfo(p.info, idle); await p.players.setInfo(p.info, { ...idle, weaponNumber: Weapon.WP_BFG });
  expect(p.info.weaponTimer).toBe(250); expect(p.scenes).toHaveLength(0);
});

test("actual renderer model limit drives requested to machinegun to none fallback", async () => {
  const p = await preview();
  expect(await p.players.registerClientModelname(p.info, "sarge")).toBe(true);
  // The renderer owns 1024 model slots including zero. Named failed registrations consume real slots.
  for (let index = 0; index < 1020; index++) await p.resources.registerModel(`missing-ui-model-${index}.md3`);
  await p.players.setModel(p.info, "sarge");
  expect(p.info.currentWeapon).toBe(Weapon.WP_MACHINEGUN); expect(p.info.realWeapon).toBe(Weapon.WP_NONE);
  await p.players.setInfo(p.info, { ...idle, weaponNumber: 99 });
  expect(p.info.currentWeapon).toBe(99); expect(p.info.realWeapon).toBe(Weapon.WP_NONE);
  expect(p.info.weaponModel).toBe(DEFAULT_MODEL); expect(p.info.barrelModel).toBe(DEFAULT_MODEL); expect(p.info.flashModel).toBe(DEFAULT_MODEL);
  await p.players.drawPlayer(rect, p.info, 100);
  expect(model(p.scenes[0], 3).model).toBe(DEFAULT_MODEL);
});

test("31 source animation cells reload in place; prelude EOF rejects but missing row tokens become zeros", async () => {
  const p = await preview(), animationPath = join(p.home, "baseq3/models/players/sarge/animation.cfg");
  await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, idle); await p.players.drawPlayer(rect, p.info, 100);
  const cached = p.info.legs.currentAnimation;
  await writeFile(animationPath, "footsteps boot\nheadoffset 1 2 3\nsex f\n0 -4 0 0\n");
  expect(await p.players.registerClientModelname(p.info, "sarge")).toBe(true);
  expect(p.info.animations[0]).toMatchObject({ firstFrame: 0, numFrames: -4, frameLerp: 1000, reversed: false });
  expect(p.info.animations[30]).toMatchObject({ firstFrame: 0, numFrames: 0, frameLerp: 1000 });
  expect(p.info.legs.currentAnimation).toBe(cached);
  await writeFile(animationPath, "sex m\n");
  await expect(p.players.registerClientModelname(p.info, "sarge")).rejects.toThrow("source nonprogress cycle");
  expect(p.info.animations.every(row => row.numFrames === 0 && row.frameLerp === 0)).toBe(true);
});

test("animation length cutpoints preserve leaked handles and clear rows before open", async () => {
  const p = await preview(), path = join(p.home, "baseq3/models/players/sarge/animation.cfg");
  await writeFile(path, "0 1 0 10\n".padEnd(19998, " "));
  expect(await p.players.registerClientModelname(p.info, "sarge")).toBe(true);
  await writeFile(path, "0 1 0 10\n".padEnd(19999, " "));
  expect(await p.players.registerClientModelname(p.info, "sarge")).toBe(false);
  expect(p.info.animations[0]?.numFrames).toBe(0); expect(p.prints.some(line => line.includes("too long"))).toBe(true);
  const afterLong = p.files.current.openRead("default.cfg"); if (afterLong === undefined) throw new Error("Missing retail default.cfg");
  expect(afterLong.file.slot).toBe(2); p.files.current.closeFile(afterLong.file);
  await writeFile(path, ""); expect(await p.players.registerClientModelname(p.info, "sarge")).toBe(false);
  const afterEmpty = p.files.current.openRead("default.cfg"); if (afterEmpty === undefined) throw new Error("Missing retail default.cfg");
  expect(afterEmpty.file.slot).toBe(3); p.files.current.closeFile(afterEmpty.file);
});

test("short read preserves parsed cells until the shared parser reaches absent storage", async () => {
  const p = await preview(), path = join(p.home, "baseq3/models/players/sarge/animation.cfg");
  await writeFile(path, "0 3 0 20\n".padEnd(100, " "));
  const open = p.files.current.openRead.bind(p.files.current);
  p.files.current.openRead = name => {
    const opened = open(name);
    if (name === "models/players/sarge/animation.cfg") truncateSync(path, 9);
    return opened;
  };
  await expect(p.players.registerClientModelname(p.info, "sarge")).rejects.toThrow("uninitialized short-read tail");
  expect(p.info.animations[0]).toMatchObject({ firstFrame: 0, numFrames: 3, loopFrames: 0, frameLerp: 50 });
});

test("retirement during actual registration keeps earlier source stores and abandons continuation", async () => {
  const p = await preview(), wait = deferred();
  p.assets.beforeRead = async path => { if (path === "models/players/sarge/upper.md3") await wait.promise; };
  const loading = p.players.setModel(p.info, "sarge");
  for (let spin = 0; spin < 100 && !p.assets.reads.includes("models/players/sarge/upper.md3"); spin++) await Bun.sleep(1);
  expect(p.info.legsModel.kind).toBe("md3");
  p.state.retire(); wait.resolve();
  await expect(loading).rejects.toThrow("retired");
  expect(p.info.legsModel.kind).toBe("md3"); expect(p.info.torsoModel).toBe(DEFAULT_MODEL); expect(p.info.newModel).toBe(false);
});

test("missing flash with retained source light color rejects reached undefined storage", async () => {
  const p = await preview(); await p.players.setModel(p.info, "sarge"); await p.players.setInfo(p.info, idle);
  await p.players.drawPlayer(rect, p.info, 100);
  await p.players.setInfo(p.info, { ...idle, torsoAnim: PlayerAnimation.TORSO_ATTACK });
  await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.BOTH_DEATH1 });
  // SetWeapon(NONE) retains the last flash color and muzzle time, so retail death within a flash reaches the C defect.
  await expect(p.players.drawPlayer(rect, p.info, 101)).rejects.toThrow("uninitialized source flash origin");
});
