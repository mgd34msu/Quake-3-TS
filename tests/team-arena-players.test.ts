import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonParseState } from "../src/core/common-parse.ts";
import { vec3 } from "../src/core/math.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { DEFAULT_MODEL, type SourceRefEntity, type RefModelEntity } from "../src/render/ref-entity.ts";
import { RendererResources, type WorldFrame } from "../src/render/world.ts";
import { Weapon } from "../src/shared/definitions.ts";
import { PlayerAnimation } from "../src/shared/player-state.ts";
import { TeamArenaPlayerInfo, TeamArenaUiPlayers } from "../src/ui/team-arena/players.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const rect = { x: 0, y: 0, width: 320, height: 480 };
type CapturedFrame = Omit<WorldFrame, "entities"> & { readonly entities: readonly SourceRefEntity[] };
const idle = { legsAnim: PlayerAnimation.LEGS_IDLE, torsoAnim: PlayerAnimation.TORSO_STAND,
  viewAngles: vec3(0, 150, 0), moveAngles: vec3(0, 150, 0), weaponNumber: -1, chat: false };
function model(scene: CapturedFrame | undefined, index: number): RefModelEntity {
  const entity = scene?.entities?.[index];
  if (entity?.kind !== "model") throw new Error(`Missing actual preview model ${index}`);
  if (typeof entity.model === "number" || typeof entity.customShader === "number" || typeof entity.customSkin === "number")
    throw new Error("Typed preview caller submitted a numeric resource");
  return { ...entity, model: entity.model, customShader: entity.customShader, customSkin: entity.customSkin };
}

async function preview(width = 320, height = 240) {
  const homePath = await mkdtemp(join(tmpdir(), "quake3-team-arena-players-"));
  const printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  const io = new UnixIo(print, clock, { signals: "none" });
  const events = new CommonEvents(new DedicatedEventSource(io), print);
  let current = true;
  const assertActive = (): undefined => { if (!current) throw new Error("Fixture player operation retired"); };
  const common = await CommonConsole.open({
    roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "missionpack" },
    startup: new StartupCommands("+set s_initsound 0"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: print, resolveCommand: () => undefined, assertCommandEntry: assertActive, assertOwnerEntry: assertActive,
  }, assertActive);
  const sound = new EngineSound(common, events), images = new RendererImageCatalog();
  const cpu = new SoftwareRenderer(width, height, images), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile), files = common.files.current;
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => clock.milliseconds() },
    scratchImages: builtins, console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const settings = createRendererSettings();
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { common.output.print(text); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  const scenes: CapturedFrame[] = [], registrations: string[] = [], probes: string[] = [];
  const lights: Parameters<RendererResources["addLight"]>[0][] = [];
  const render = resources.renderScene.bind(resources), registerModel = resources.registerModel.bind(resources);
  const clear = resources.clearScene.bind(resources), addLight = resources.addLight.bind(resources);
  resources.clearScene = () => { lights.length = 0; return clear(); };
  resources.addLight = light => { lights.push(light); return addLight(light); };
  const registerSkin = resources.registerSkin.bind(resources), has = files.has.bind(files);
  resources.renderScene = refdef => {
    scenes.push({ refdef, entities: resources.sceneEntities.sceneRange().copyRefEntities(), dynamicLights: lights.slice() });
    return render(refdef);
  };
  resources.registerModel = path => { registrations.push(`model:${path}`); return registerModel(path); };
  resources.registerSkin = path => { registrations.push(`skin:${path}`); return registerSkin(path); };
  files.has = path => { probes.push(path); return has(path); };
  const parser = new CommonParseState(), random = new GameRandom();
  const players = new TeamArenaUiPlayers({ files: common.files, resources, sound, commands, sourceParser: parser, random, print, assertActive });
  const info = new TeamArenaPlayerInfo(), frame = { time: 9000, frameTime: 16, draw: commands.draw2D("team-ui-640") };
  return { common, files, sound, cpu, commands, resources, scenes, recording, registrations, probes, printed, players, info, frame, random, homePath,
    retire: () => { current = false; },
    close: async () => { current = true; movies.dispose(); commands.close("discard"); target.close(); sound.close(); common.close(); io.close();
      await rm(homePath, { recursive: true, force: true }); } };
}

test("Team Arena retail body, independent head, team skins and repeated registration preserve source cells", async () => {
  const p = await preview();
  try {
    const legs = p.info.legs, torso = p.info.torso, cells = p.info.animations, first = cells[0];
    expect(p.players.weaponChangeSound).toBeNull(); expect(p.info.pendingWeapon).toBe(0); expect(cells).toHaveLength(37);
    await p.players.setModel(p.info, "james/red", "*janet/blue", "Pagans");
    expect(p.info.legsModel.path).toBe("models/players/james/lower.md3");
    expect(p.info.headModel.path).toBe("models/players/heads/janet/janet.md3");
    expect(p.info.legsSkin?.path).toBe("models/players/james/pagans/lower_red.skin");
    expect(p.info.headSkin?.path).toBe("models/players/heads/janet/head_blue.skin");
    expect(p.probes.filter(path => path.startsWith("models/players/heads/janet/") && path.endsWith(".skin")).slice(0, 4)).toEqual(["models/players/heads/janet/blue/Paganshead_default.skin",
      "models/players/heads/janet/Paganshead_blue.skin", "models/players/heads/janet/blue/head_default.skin", "models/players/heads/janet/head_blue.skin"]);
    await p.players.setInfo(p.info, idle); await p.players.drawPlayer(rect, p.info, 100, p.frame);
    const cached = p.info.legs.currentAnimation;
    expect(cached).not.toBeNull();
    const extraAnimation = cells[PlayerAnimation.FLAG_STAND2RUN];
    if (extraAnimation === undefined) throw new Error("Missing source MAX_TOTALANIMATIONS storage");
    extraAnimation.firstFrame = 123; extraAnimation.numFrames = 7;
    expect(await p.players.registerClientModelname(p.info, "james/blue", "janet/red", "Stroggs")).toBe(true);
    expect(p.info.legs.currentAnimation).toBe(cached); expect(p.info.legsSkin?.path).toBe("models/players/james/stroggs/lower_blue.skin");
    expect(extraAnimation).toMatchObject({ firstFrame: 123, numFrames: 7 });
    expect(p.registrations).toContain("model:models/players/janet/head.md3");
    expect(p.registrations).toContain("model:models/players/heads/janet/janet.md3");
    await p.players.setModel(p.info, "sarge", "visor", null);
    expect(p.info.headModel.path).toBe("models/players/visor/head.md3");
    expect(p.info.legs).toBe(legs); expect(p.info.torso).toBe(torso); expect(p.info.animations).toBe(cells); expect(cells[0]).toBe(first);
    expect(cells[PlayerAnimation.FLAG_STAND2RUN]).toBe(extraAnimation);
    expect(extraAnimation).toMatchObject({ firstFrame: 0, numFrames: 0 });
    expect(p.info.legs.currentAnimation).toBeNull(); expect(p.info.newModel).toBe(true);
  } finally { await p.close(); }
}, 20000);

test("Team Arena retail preview reaches CPU with stretched viewport, zero source shader colors and body tags", async () => {
  const p = await preview(400, 240);
  try {
    await p.players.setModel(p.info, "james", "*james", "Pagans"); await p.players.setInfo(p.info, { ...idle, chat: true });
    await p.players.drawPlayer({ ...rect, x: 32 }, p.info, 101, p.frame);
    const scene = p.scenes[0];
    expect(scene?.refdef).toMatchObject({ x: 20, y: 0, width: 200, height: 240, fovX: 28, time: 101, renderFlags: 1 });
    const pi = Math.fround(Math.PI), angle = Math.fround(Math.fround(28 / 360) * pi);
    const xx = Math.fround(200 / Math.fround(Math.fround(Math.sin(angle)) / Math.fround(Math.cos(angle))));
    expect(scene?.refdef.fovY).toBe(Math.fround(Math.fround(Math.atan2(240, xx)) * Math.fround(360 / pi)));
    expect(scene?.entities).toHaveLength(6);
    for (const index of [0, 1, 2, 3, 4]) expect(model(scene, index).shaderRGBA).toEqual({ x: 0, y: 0, z: 0, w: 0 });
    expect(model(scene, 1).origin.z).toBeGreaterThan(model(scene, 0).origin.z);
    expect(model(scene, 2).origin.z).toBeGreaterThan(model(scene, 1).origin.z);
    expect(scene?.entities?.[5]).toMatchObject({ kind: "sprite", radius: 10, origin: { z: 44 }, shaderRGBA: { x: 0, y: 0, z: 0, w: 0 } });
    expect(scene?.dynamicLights).toHaveLength(2);
    expect(p.commands.submit().batches).toBeGreaterThan(0);
    expect(p.recording.trace()[0]?.state.viewport).toEqual({ x: 20, y: 0, width: 200, height: 240 });
    expect(p.cpu.pixels.filter((value, index) => index % 4 !== 3 && value !== 0).length).toBeGreaterThan(1000);
  } finally { await p.close(); }
}, 20000);

test("Team Arena zero-sized cache draws leave shared time, pending sound and animation untouched", async () => {
  const p = await preview();
  try {
    await p.players.setModel(p.info, "james", "*james", ""); await p.players.setInfo(p.info, idle);
    await p.players.drawPlayer(rect, p.info, 100, p.frame);
    await p.players.setInfo(p.info, { ...idle, weaponNumber: Weapon.WP_ROCKET_LAUNCHER });
    const calls: (number | null)[] = [], start = p.sound.startLocalSound.bind(p.sound);
    p.sound.startLocalSound = (sound, channel) => { calls.push(sound === null ? null : channel, channel); return start(sound, channel); };
    await p.players.drawPlayer({ ...rect, width: 0 }, p.info, 9000, p.frame);
    await p.players.drawPlayer({ ...rect, height: 0 }, p.info, 9000, p.frame);
    expect(calls).toEqual([]); expect(p.info.pendingWeapon).toBe(Weapon.WP_ROCKET_LAUNCHER); expect(p.scenes).toHaveLength(1);
    await p.players.setInfo(p.info, { ...idle, weaponNumber: Weapon.WP_ROCKET_LAUNCHER }); expect(p.info.weaponTimer).toBe(350);
    await p.players.drawPlayer(rect, p.info, 350, p.frame); expect(calls).toEqual([]);
    await p.players.drawPlayer(rect, p.info, 351, p.frame); expect(calls).toEqual([null, 1]);
    expect(p.info.torsoAnimationTimer).toBe(300); expect(p.info.currentWeapon).toBe(Weapon.WP_MACHINEGUN);
    p.frame.frameTime = 300; await p.players.drawPlayer(rect, p.info, 352, p.frame);
    expect(p.info.currentWeapon).toBe(Weapon.WP_ROCKET_LAUNCHER); expect(p.info.torsoAnim & ~128).toBe(PlayerAnimation.TORSO_RAISE);
    await p.players.drawPlayer(rect, p.info, 353, p.frame); expect(p.info.torsoAnim & ~128).toBe(PlayerAnimation.TORSO_STAND);
  } finally { await p.close(); }
}, 20000);

test("Team Arena narrow preview uses the QVM sine-over-cosine tangent wrapper", async () => {
  const p = await preview();
  try {
    await p.players.setModel(p.info, "james", "*james", "");
    await p.players.setInfo(p.info, idle);
    await p.players.drawPlayer({ ...rect, width: 30 }, p.info, 100, p.frame);
    const scene = p.scenes[0];
    const f = Math.fround, pi = f(Math.PI), xx = 859.349365234375;
    expect(scene?.refdef).toMatchObject({ width: 15, fovX: 2 });
    expect(scene?.refdef.fovY).toBe(f(f(Math.atan2(240, xx)) * f(360 / pi)));
    const angle = f(f(f(2 * pi) / 180) * .5);
    expect(model(scene, 0).origin.x).toBe(f(f(f(.7) * 56) / f(f(Math.sin(angle)) / f(Math.cos(angle)))));
  } finally { await p.close(); }
}, 20000);

test("Team Arena shared jump height and product weapons use actual UI time and random owners", async () => {
  const p = await preview(), second = new TeamArenaPlayerInfo();
  try {
    await p.players.setModel(p.info, "james", "*james", ""); await p.players.setInfo(p.info, idle);
    await p.players.setModel(second, "janet", "*janet", ""); await p.players.setInfo(second, idle);
    await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.LEGS_JUMP });
    p.frame.frameTime = 500; await p.players.drawPlayer(rect, p.info, 100, p.frame);
    p.frame.frameTime = 0; await p.players.drawPlayer(rect, second, 200, p.frame);
    expect(p.scenes[0]?.refdef.y).toBe(0); expect(p.scenes[1]?.refdef.y).toBe(-56);
    await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.LEGS_RUN });
    p.frame.frameTime = 500; await p.players.drawPlayer(rect, p.info, 201, p.frame);
    expect(p.info.legsAnim & ~128).toBe(PlayerAnimation.LEGS_LAND); expect(p.info.pendingLegsAnim).toBe(PlayerAnimation.LEGS_RUN);
    p.frame.frameTime = 130; await p.players.drawPlayer(rect, p.info, 202, p.frame);
    expect(p.info.legsAnim & ~128).toBe(PlayerAnimation.LEGS_RUN);
    await p.players.setModel(p.info, "james", "*james", "");
    await p.players.setInfo(p.info, { ...idle, weaponNumber: Weapon.WP_NAILGUN });
    expect(p.info.realWeapon).toBe(Weapon.WP_NAILGUN); expect(p.info.weaponModel.path).toBe("models/weapons/nailgun/nailgun.md3");
    expect(p.info.flashDlightColor).toEqual(vec3(1, 1, 1));
    await p.players.setInfo(p.info, { ...idle, torsoAnim: PlayerAnimation.TORSO_ATTACK });
    p.random.reset(0); await p.players.drawPlayer(rect, p.info, 220, p.frame);
    expect(p.random.seed).toBe(1); expect(p.scenes.at(-1)?.dynamicLights?.[0]?.radius).toBe(201);
    await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.BOTH_DEATH1 });
    expect(p.info.currentWeapon).toBe(Weapon.WP_NONE); expect(p.info.weaponModel).toBe(DEFAULT_MODEL);
  } finally { await p.close(); }
}, 20000);

test("Team Arena head finder uses real null-handle existence and keeps earlier head skin when no file is found", async () => {
  const p = await preview();
  try {
    await p.players.setModel(p.info, "james", "*james", "");
    const skin = p.info.headSkin;
    expect(await p.players.registerClientModelname(p.info, "james", "*james/no-such-skin", "")).toBe(true);
    expect(p.info.headSkin).toBe(skin);
    const directory = join(p.homePath, "missionpack/models/players/heads/james/empty");
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "head_default.skin"), "");
    p.registrations.length = 0;
    expect(await p.players.registerClientModelname(p.info, "james", "*james/empty", "")).toBe(true);
    // Existing empty head file reaches real RegisterSkin, fails there, then retries default body/head skins.
    expect(p.registrations).toContain("skin:models/players/heads/james/empty/head_default.skin");
    expect(p.registrations.filter(path => path === "skin:models/players/james/lower_default.skin")).toHaveLength(2);
    expect(p.info.headSkin?.path).toBe("models/players/heads/james/head_default.skin");
    const oldLegs = p.info.legsModel;
    expect(await p.players.registerClientModelname(p.info, "", "*james", null)).toBe(false);
    expect(p.info.legsModel).toBe(oldLegs); expect(p.info.torsoModel).toBe(DEFAULT_MODEL);
    p.registrations.length = 0;
    expect(await p.players.registerClientModelname(p.info, "absent", "*absent", null)).toBe(false);
    expect(p.registrations).toEqual(["model:models/players/absent/lower.md3", "model:models/players/characters/absent/lower.md3"]);
  } finally { await p.close(); }
}, 20000);

test("Team Arena animation compression precedes parsing and short-read failure; reload keeps embedded cells", async () => {
  const p = await preview();
  try {
    await p.players.setModel(p.info, "james", "*james", ""); await p.players.setInfo(p.info, idle);
    await p.players.drawPlayer(rect, p.info, 100, p.frame);
    const cached = p.info.legs.currentAnimation, directory = join(p.homePath, "missionpack/models/players/james");
    await mkdir(directory, { recursive: true }); const path = join(directory, "animation.cfg");
    await writeFile(path, "/* comment */ footsteps boot\n0/*inside*/3 4 0 20\n");
    expect(await p.players.registerClientModelname(p.info, "james", "*james", "")).toBe(true);
    expect(p.info.animations[0]).toMatchObject({ firstFrame: 3, numFrames: 4, frameLerp: 50 });
    expect(p.info.animations[30]).toMatchObject({ firstFrame: 0, numFrames: 0, frameLerp: 1000 });
    expect(p.info.legs.currentAnimation).toBe(cached);
    await writeFile(path, "sex m\n");
    await expect(p.players.registerClientModelname(p.info, "james", "*james", "")).rejects.toThrow("nonprogress cycle");
    await writeFile(path, "0 3 0 20\n".padEnd(100, " "));
    const open = p.files.openRead.bind(p.files);
    p.files.openRead = filename => { const opened = open(filename); if (filename === "models/players/james/animation.cfg") truncateSync(path, 9); return opened; };
    await expect(p.players.registerClientModelname(p.info, "james", "*james", "")).rejects.toThrow("uninitialized short-read tail");
    expect(p.info.animations.every(row => row.numFrames === 0 && row.frameLerp === 0)).toBe(true);
    p.files.openRead = open;
    await writeFile(path, "0 1 0 10\n".padEnd(19999, " "));
    expect(await p.players.registerClientModelname(p.info, "james", "*james", "")).toBe(false);
    const handle = p.files.openRead("default.cfg"); if (handle === undefined) throw new Error("Expected retail default.cfg");
    expect(handle.file.slot).toBe(2); p.files.closeFile(handle.file);
  } finally { await p.close(); }
}, 20000);

test("Team Arena empty animation reaches source frame minus one and extra storage is not a playable animation", async () => {
  const p = await preview();
  try {
    const directory = join(p.homePath, "missionpack/models/players/james");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "animation.cfg"), "0 1 0 20\n" + "0 0 0 20\n".repeat(30));
    await p.players.setModel(p.info, "james", "*james", "");
    await p.players.setInfo(p.info, idle);
    await p.players.drawPlayer(rect, p.info, 100, p.frame);
    expect(p.info.legs).toMatchObject({ oldFrame: 0, frame: -1, frameTime: 100, backLerp: 0 });
    expect(p.info.torso).toMatchObject({ oldFrame: 0, frame: -1, frameTime: 100, backLerp: 0 });
    expect(model(p.scenes[0], 0).frame).toBe(-1);
    await p.players.drawPlayer(rect, p.info, 101, p.frame);
    expect(p.info.legs).toMatchObject({ oldFrame: -1, frame: -1, frameTime: 101, backLerp: 0 });
    const retained = p.info.legs.currentAnimation;
    await p.players.setInfo(p.info, { ...idle, legsAnim: PlayerAnimation.LEGS_BACKCR });
    await expect(p.players.drawPlayer(rect, p.info, 102, p.frame)).rejects.toThrow("Bad animation number: 32");
    expect(p.info.legs.animationNumber & ~128).toBe(PlayerAnimation.LEGS_BACKCR);
    expect(p.info.legs.currentAnimation).toBe(retained);
    expect(p.scenes).toHaveLength(2);
  } finally { await p.close(); }
}, 20000);

test("retirement during model registration retains earlier stores without publishing later limbs", async () => {
  const p = await preview();
  try {
    const register = p.resources.registerModel.bind(p.resources);
    p.resources.registerModel = async path => { const result = await register(path); if (path?.endsWith("upper.md3")) p.retire(); return result; };
    await expect(p.players.setModel(p.info, "james", "*james", "")).rejects.toThrow("retired");
    expect(p.info.legsModel.kind).toBe("md3"); expect(p.info.torsoModel).toBe(DEFAULT_MODEL); expect(p.info.newModel).toBe(false);
  } finally { await p.close(); }
}, 20000);
