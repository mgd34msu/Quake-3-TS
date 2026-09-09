import { HunkArena } from "../src/core/hunk.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { vec3, vec4, type Vec3 } from "../src/core/math.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ParticleSystem, loadParticleAnimations, MAX_PARTICLES, type ParticleHost } from "../src/cgame/particles.ts";
import { ClientEntity, ClientGameState } from "../src/cgame/state.ts";
import type { RefPoly, SceneShader } from "../src/render/ref-entity.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import type { MovementTrace } from "../src/shared/movement.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { RendererResources } from "../src/render/world.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const ORIGIN = vec3(0, 0, 100), VELOCITY = vec3(8, 4, 0), SHADER: SceneShader = { name: "fixture" };
function snapshot(state: ClientGameState, origin = vec3(-1000, 0, 0)): void {
  state.refdef.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  state.predictedPlayerState.origin = origin;
  state.snap = { messageNumber: 1, serverTime: 0, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(), playerState: state.predictedPlayerState, entities: [] };
}
function hit(end: Vec3, entityNum = ENTITYNUM_WORLD): MovementTrace {
  return { fraction: 0.5, end, solidity: "clear", contact: { kind: "plane", plane: { normal: vec3(0, 0, 1), distance: 0 } }, contents: 1, surfaceFlags: 0, entityNum };
}
async function setup(hardwareType: ParticleHost["hardwareType"] = "generic") {
  const registered: string[] = [], warnings: string[] = [], traces: { start: Vec3; end: Vec3; skip: number; mask: number }[] = [];
  const resources = { registerShader: async (name: string) => { registered.push(name); return { name }; } };
  const animations = await loadParticleAnimations(resources);
  const state = new ClientGameState("baseq3", 0, 0); snapshot(state); const random = new GameRandom(1);
  let traceResult = (end: Vec3): MovementTrace => hit(end);
  const configstrings = new Map<number, string>();
  const system = new ParticleSystem(state, {
    animations, media: { tracerShader: { name: "tracer" }, smokePuffShader: { name: "smoke" }, waterBubbleShader: { name: "bubble" } }, random, hardwareType,
    prediction: { trace: (start, end, _bounds, skip, mask) => { traces.push({ start, end, skip, mask }); return traceResult(end); } },
    configString: index => configstrings.get(index) ?? "", print: message => { warnings.push(message); },
  });
  return { system, state, random, resources, registered, warnings, traces, configstrings, setTrace: (callback: typeof traceResult): void => { traceResult = callback; } };
}
async function setupStandalone() {
  const fixture = await setup(), registered: string[] = [];
  const resources = { registerShader: async (name: string) => { registered.push(name); return { name }; } };
  const animations = await loadParticleAnimations(resources, "cg_particles.c");
  const system = new ParticleSystem(fixture.state, { ...fixture.system.host, animations }, "cg_particles.c");
  return { ...fixture, system, resources, registered, animations };
}
function only(polys: readonly RefPoly[]): RefPoly { expect(polys).toHaveLength(1); const poly = polys[0]; if (poly === undefined) throw new Error("missing expected particle polygon"); return poly; }
function positions(poly: RefPoly): readonly Vec3[] { return poly.vertices.map(vertex => vertex.position); }
function positionBits(poly: RefPoly): readonly (readonly number[])[] {
  const buffer = new DataView(new ArrayBuffer(4));
  const bits = (value: number): number => { buffer.setFloat32(0, value, true); return buffer.getInt32(0, true); };
  return poly.vertices.map(vertex => [bits(vertex.position.x), bits(vertex.position.y), bits(vertex.position.z)]);
}

// /tmp/quake3-particle-reference-cJ9heF/reference.c includes untouched cg_marks.c,
// linked against untouched q_math.c/q_shared.c. GCC16.2.1 -O0
// -fsingle-precision-constant matches QVM scalar constants for these fixtures.
// fixture.c/build.sh/run.sh in the same directory additionally run untouched
// source through q3lcc/q3asm and the original interpreted QVM. Signed float bits
// below are captured from that independent VM, including rotated geometry.
describe("source particle pool and native fixtures", () => {
  test("preloads exact animation names and re-registers all animation frames at each reset", async () => {
    const { system, state, resources, registered } = await setup();
    const names = Array.from({ length: 23 }, (_, index) => `explode1${index + 1}`);
    expect(registered).toEqual(names);
    system.explosion({ animation: "explode1", origin: ORIGIN, velocity: VELOCITY, duration: -1400, sizeStart: 20, sizeEnd: 30 });
    expect(system.activeCount).toBe(1); state.time = 700; system.addParticles(); expect(registered).toHaveLength(23);
    await system.clear(resources);
    expect(system.activeCount).toBe(0); expect(system.addParticles()).toEqual([]); expect(registered).toEqual([...names, ...names]);
    await system.clear(resources); expect(registered).toEqual([...names, ...names, ...names]);
  });
  test("zero animation frames retain allocation and later registered frames resume source drawing", async () => {
    const f = await setup(), registered: string[] = [];
    const resources = { registerShader: async (name: string) => {
      registered.push(name); return name === "explode11" || name === "explode112" ? null : { name };
    } };
    const animations = await loadParticleAnimations(resources);
    expect(registered).toEqual(f.registered); expect(animations.explode1[0]).toBeNull(); expect(animations.explode1[11]).toBeNull();
    const second = animations.explode1[1], last = animations.explode1[22];
    if (second === undefined || last === undefined) throw new Error("Missing registered particle frame slots");
    const system = new ParticleSystem(f.state, { ...f.system.host, animations });
    system.explosion({ animation: "explode1", origin: ORIGIN, velocity: VELOCITY, duration: -1400, sizeStart: 20, sizeEnd: 30 });
    expect(system.addParticles()).toEqual([]); expect(system.activeCount).toBe(1);
    f.state.time = 100; expect(only(system.addParticles()).shader).toBe(second);
    f.state.time = 700; expect(system.addParticles()).toEqual([]); expect(system.activeCount).toBe(1);
    f.state.time = 1400; expect(only(system.addParticles()).shader).toBe(last);
    f.state.time = 1401; expect(system.addParticles()).toEqual([]); expect(system.activeCount).toBe(0); expect(f.random.seed).toBe(1);
    await system.clear({ registerShader: async name => { registered.push(name); return SHADER; } });
    expect(registered).toHaveLength(46);
    system.explosion({ animation: "explode1", origin: ORIGIN, velocity: VELOCITY, duration: -100, sizeStart: 20, sizeEnd: 30 });
    expect(only(system.addParticles()).shader).toBe(SHADER);
  });
  test("interrupted particle reset retains reached shader-frame writes", async () => {
    const { system, state } = await setup(), reached: string[] = [];
    await expect(system.clear({ registerShader: async name => {
      reached.push(name);
      if (name === "explode12") throw new Error("registration interrupted");
      return SHADER;
    } })).rejects.toThrow("registration interrupted");
    expect(reached).toEqual(["explode11", "explode12"]);
    system.explosion({ animation: "explode1", origin: ORIGIN, velocity: VELOCITY, duration: -100, sizeStart: 20, sizeEnd: 30 });
    expect(only(system.addParticles()).shader).toBe(SHADER);
    state.time = 5;
    expect(only(system.addParticles()).shader?.name).toBe("explode12");
  });
  test("zero particle media keep source pool ownership, random draws and weather wrap", async () => {
    const f = await setup(), reference = await setup();
    const system = new ParticleSystem(f.state, { ...f.system.host, media: { tracerShader: null, smokePuffShader: null, waterBubbleShader: null } });
    for (const pool of [system, reference.system]) {
      pool.bulletDebris(ORIGIN, VELOCITY, 1000); pool.sparks(ORIGIN, VELOCITY, 1000, 3, 4, 2);
      pool.bloodCloud(ORIGIN, vec3(65, 0, 0)); pool.dust(ORIGIN, VELOCITY);
    }
    expect(system.activeCount).toBe(reference.system.activeCount); expect(f.random.seed).toBe(reference.random.seed);
    expect(system.addParticles()).toEqual([]); expect(reference.system.addParticles()).toHaveLength(6);
    f.state.time = reference.state.time = 10000; expect(system.addParticles()).toEqual([]); reference.system.addParticles(); expect(system.activeCount).toBe(0);
    await system.clear(f.resources); await reference.system.clear(reference.resources);
    f.configstrings.set(5, "3 0 0 100 0 0 0 1 1 77"); reference.configstrings.set(5, "3 0 0 100 0 0 0 1 1 77");
    system.newParticleArea(5); reference.system.newParticleArea(5);
    f.state.time = reference.state.time = 14000;
    expect(system.addParticles()).toEqual([]); reference.system.addParticles();
    expect(system.activeCount).toBe(1); expect(f.random.seed).toBe(reference.random.seed);
    expect(f.warnings).toEqual(["CG_ParticleSnow pshader == ZERO!\n"]);
  });
  test("native explosion positions, animation frames and strict end-time expiration", async () => {
    const { system, state, random } = await setup();
    system.explosion({ animation: "ExPlOdE1", origin: ORIGIN, velocity: VELOCITY, duration: -1400, sizeStart: 20, sizeEnd: 30 });
    const first = only(system.addParticles()); expect(first.shader?.name).toBe("explode11");
    expect(positions(first)).toEqual([vec3(0, -20, 80), vec3(0, -20, 120), vec3(0, 20, 120), vec3(0, 20, 80)]);
    state.time = 700; const middle = only(system.addParticles()); expect(middle.shader?.name).toBe("explode112");
    expect(positions(middle)).toEqual([vec3(5.600000381469727, -22.200000762939453, 75), vec3(5.600000381469727, -22.200000762939453, 125), vec3(5.600000381469727, 27.799999237060547, 125), vec3(5.600000381469727, 27.799999237060547, 75)]);
    state.time = 1400; const last = only(system.addParticles()); expect(last.shader?.name).toBe("explode123");
    expect(positions(last)).toEqual([vec3(11.200000762939453, -24.39900016784668, 70.0009994506836), vec3(11.200000762939453, -24.39900016784668, 129.99899291992188), vec3(11.200000762939453, 35.5989990234375, 129.99899291992188), vec3(11.200000762939453, 35.5989990234375, 70.00099182128906)]);
    state.time = 1401; expect(system.addParticles()).toEqual([]); expect(system.activeCount).toBe(0); expect(random.seed).toBe(1);
  });
  test("native debris integrates velocity/acceleration and emissive byte fade", async () => {
    const { system, state } = await setup(); system.bulletDebris(ORIGIN, VELOCITY, 1000); state.time = 750;
    const poly = only(system.addParticles());
    expect(positions(poly)).toEqual([vec3(6.000000476837158, 2.500000238418579, 50.74999237060547), vec3(6.000000476837158, 3.500000238418579, 50.74999237060547), vec3(6.000000476837158, 3.500000238418579, 51.74999237060547), vec3(6.000000476837158, 2.500000238418579, 51.74999237060547)]);
    expect(poly.vertices[0]?.color).toEqual({ x: 63, y: 63, z: 63, w: 127 });
    state.time = 1000; expect(only(system.addParticles()).vertices[0]?.color.w).toBe(0); state.time++; expect(system.addParticles()).toEqual([]);
  });
  test("native unrotated smoke keeps initial size despite end dimensions", async () => {
    const { system, state } = await setup(), entity = new ClientEntity(); entity.currentState.origin = ORIGIN; entity.currentState.time = 1000; entity.currentState.time2 = 500;
    system.smoke(SHADER, entity); state.time = 500;
    expect(positions(only(system.addParticles()))).toEqual([vec3(0, -8, 94.5), vec3(0, 8, 94.5), vec3(0, 8, 110.5), vec3(0, -8, 110.5)]);
    state.time = 1000; expect(only(system.addParticles()).vertices[0]?.color.w).toBe(0);
  });
  test("native snow wraps stored origin but renders the pre-wrap position once", async () => {
    const { system, state, random } = await setup(); system.snow(SHADER, ORIGIN, vec3(0, 0, 0), false, 0, 7);
    const first = only(system.addParticles()); expect(first.vertices).toHaveLength(3); expect(first.vertices[0]?.position.z).toBe(86.18527221679688); expect(first.vertices[0]?.color.w).toBe(255);
    state.time = 4000; expect(only(system.addParticles()).vertices[0]?.position.z).toBe(-113.81472778320312); expect(only(system.addParticles()).vertices[0]?.position.z).toBe(86.18527221679688); expect(random.seed >>> 0).toBe(3277404108);
  });
  test("native bubble wrap precedes distance culling and uses another random draw", async () => {
    const { system, state, random } = await setup(); system.bubble(SHADER, vec3(0, 0, 0), ORIGIN, false, 0, 7);
    const first = only(system.addParticles()); expect(first.vertices[0]?.position.y).toBe(-0.6078523993492126); expect(first.vertices[0]?.position.z).toBe(90.83476257324219);
    state.time = 4000; expect(system.addParticles()).toEqual([]); expect(only(system.addParticles()).vertices[0]?.position.z).toBe(-3.3141117095947266); expect(random.seed >>> 0).toBe(3821835443);
  });
  test("native blood cloud emits at origin and uses blood byte color", async () => {
    const { system, state } = await setup(); system.bloodCloud(ORIGIN, vec3(65, 0, 0)); expect(system.activeCount).toBe(3);
    const polys = system.addParticles(); expect(polys).toHaveLength(3);
    for (const poly of polys) { expect(poly.vertices[0]?.position).toEqual(vec3(0, -32, 68)); expect(poly.vertices[0]?.color).toEqual({ x: 56, y: 0, z: 0, w: 191 }); }
    state.time = 600; expect(system.addParticles()).toEqual([]);
  });
  test("source misc ignores alpha and positive lifetime, while negative lifetime draws once", async () => {
    const { system, state } = await setup(); system.misc(SHADER, ORIGIN, 4, -1, 0.2); expect(only(system.addParticles()).vertices[0]?.color.w).toBe(255); expect(system.activeCount).toBe(0);
    system.misc(SHADER, ORIGIN, 4, 10, 0); state.time = 20000; expect(system.addParticles()).toHaveLength(1); expect(system.activeCount).toBe(1);
  });
  test("full pool drops new particles without eviction or random consumption", async () => {
    const { system, random } = await setup(); for (let index = 0; index < MAX_PARTICLES; index++) system.misc(SHADER, vec3(index, 0, 100), 1, -1, 1);
    const seed = random.seed; system.misc(SHADER, ORIGIN, 1, -1, 1); expect(system.activeCount).toBe(MAX_PARTICLES); expect(random.seed).toBe(seed);
    const polys = system.addParticles(); expect(polys).toHaveLength(MAX_PARTICLES); expect(polys[0]?.vertices[0]?.position.x).toBe(MAX_PARTICLES - 1); expect(system.activeCount).toBe(0);
  });
  test("reused misc slots retain source velocity and acceleration", async () => {
    const { system, state } = await setup(); system.bulletDebris(ORIGIN, VELOCITY, 10); state.time = 11; expect(system.addParticles()).toEqual([]);
    system.misc(SHADER, ORIGIN, 1, 100, 1); state.time = 1011;
    const poly = only(system.addParticles()); expect(poly.vertices[0]?.position.x).toBe(8);
    const center = poly.vertices.reduce((sum, vertex) => sum + vertex.position.z, 0) / 4; expect(center).toBeCloseTo(20, 5);
  });
  test("clear retains global view roll but zeroes per-particle fields", async () => {
    const a = await setup(), b = await setup(); a.state.time = 100; a.system.addParticles(); await a.system.clear(a.resources); b.state.time = 100; await b.system.clear(b.resources);
    a.system.impactSmokePuff(SHADER, ORIGIN); b.system.impactSmokePuff(SHADER, ORIGIN);
    const retained = only(a.system.addParticles());
    expect(positions(retained)).not.toEqual(positions(only(b.system.addParticles())));
    expect(positionBits(retained)).toEqual([[0, 1094835028, 1119593336], [0, -1055273154, 1119142244], [0, -1052648620, 1121213576], [0, 1092210494, 1121664668]]);
    await a.system.clear(a.resources); a.system.misc(SHADER, ORIGIN, 1, -1, 1); expect(a.system.addParticles()).toHaveLength(1);
  });
  test("original QVM rotated explosion and sprite preserve sequential vertex arithmetic", async () => {
    const { system, state } = await setup();
    system.misc(SHADER, ORIGIN, 4, -1, 0.2);
    expect(positionBits(only(system.addParticles()))).toEqual([[0, 1045047520, 1121144460], [0, -1061885768, 1120429333], [0, -1102436128, 1119662453], [0, 1085597880, 1120377580]]);
    const rotated = await setup();
    rotated.system.explosion({ animation: "explode1", origin: ORIGIN, velocity: vec3(-8, -4, 0), duration: 1400, sizeStart: 20, sizeEnd: 30 });
    rotated.state.refdef.viewAxis = [vec3(0.81379765, 0.4698463, -0.34202015), state.refdef.viewAxis[1], state.refdef.viewAxis[2]];
    rotated.state.time = 700;
    expect(positionBits(only(rotated.system.addParticles()))).toEqual([[1095681298, -1039984190, 1120782986], [-1050157638, -1053303292, 1116065402], [-1044317150, 1104766648, 1120023926], [1079159328, 1086097624, 1124407491]]);
  });
  test("original QVM flat oil rotation and impact expansion match exact float boundaries", async () => {
    const oil = await setup(), entity = new ClientEntity(); entity.currentState.origin = ORIGIN;
    oil.system.oilSlick(SHADER, entity); oil.state.time = 750;
    const flat = only(oil.system.addParticles());
    expect(positionBits(flat)).toEqual([[-1054950888, 1085753400, 1120424146], [1085753400, 1092532760, 1120424146], [1092532760, -1061730248, 1120424146], [-1061730248, -1054950888, 1120424146]]);
    expect(flat.vertices[0]?.color).toEqual(vec4(127, 127, 127, 255));
    const impact = await setup(); impact.system.impactSmokePuff(SHADER, ORIGIN); impact.system.addParticles(); impact.state.time = 500;
    expect(positionBits(only(impact.system.addParticles()))).toEqual([[0, 1104606688, 1122925628], [0, -1064844362, 1118847624], [0, -1042876960, 1121813444], [0, 1082639286, 1124982460]]);
    impact.state.time = 501; expect(impact.system.addParticles()).toEqual([]);
  });
  test("original QVM flurry, bleed, oil and sparks creation and integration", async () => {
    const entity = new ClientEntity(); entity.currentState.origin = ORIGIN; entity.currentState.time = 1000; entity.currentState.time2 = 500;
    const flurry = await setup(); flurry.system.snowFlurry(SHADER, entity); flurry.state.time = 500;
    const snow = only(flurry.system.addParticles());
    expect(positionBits(snow)).toEqual([[-1053969189, -1061823956, 1119617024], [-1053969189, -1061823956, 1119879168], [-1053969189, -1066683304, 1119879168]]);
    expect(snow.vertices[0]?.color.w).toBe(229); flurry.state.time = 1001; expect(flurry.system.addParticles()).toEqual([]);
    const bleed = await setup(); bleed.system.bleed(SHADER, ORIGIN, 0, 1000); bleed.state.time = 500;
    const blood = only(bleed.system.addParticles());
    expect(positionBits(blood)).toEqual([[0, -1065353216, 1118568448], [0, 1082130432, 1118568448], [0, 1082130432, 1119617024], [0, -1065353216, 1119617024]]);
    expect(blood.vertices[0]?.color).toEqual(vec4(56, 0, 0, 106));
    const oil = await setup(); entity.currentState.origin2 = VELOCITY; oil.system.oilParticle(SHADER, entity); oil.state.time = 500;
    expect(positionBits(only(oil.system.addParticles()))).toEqual([[1115684864, 1106771968, 1119354880], [1115684864, 1107558400, 1119354880], [1115684864, 1107558400, 1120141312], [1115684864, 1106771968, 1120141312]]);
    const sparks = await setup(); sparks.system.sparks(ORIGIN, VELOCITY, 1000, 3, 4, 2); sparks.state.time = 500;
    const spark = only(sparks.system.addParticles());
    expect(positionBits(spark)).toEqual([[1060559210, -1064793936, 1121760804], [1060559210, -1068428959, 1121760804], [1060559210, -1068428959, 1121891876], [1060559210, -1064793936, 1121891876]]);
    expect(spark.vertices[0]?.color.w).toBe(102);
  });
});

describe("dormant cg_particles.c source profile", () => {
  const sequences: readonly (readonly [string, number])[] = [
    ["explode1", 23], ["blacksmokeanim", 25], ["twiltb2", 45], ["expblue", 25], ["blacksmokeanimb", 23], ["blood", 5],
  ];
  test("registers all six sequences in source order and clears the selected pool", async () => {
    const { system, resources, registered } = await setupStandalone();
    const names = sequences.flatMap(([name, count]) => Array.from({ length: count }, (_, frame) => `${name}${frame + 1}`));
    expect(registered).toEqual(names); expect(names).toHaveLength(146);
    system.explosion({ animation: "blood", origin: ORIGIN, velocity: VELOCITY, duration: -100, sizeStart: 2, sizeEnd: 4 });
    await system.clear(resources);
    expect(system.activeCount).toBe(0); expect(system.addParticles()).toEqual([]); expect(registered).toEqual([...names, ...names]);
  });
  test("validates each required sequence at construction and keeps the active catalog closed", async () => {
    const f = await setupStandalone();
    expect(() => new ParticleSystem(f.state, { ...f.system.host, animations: { ...f.animations, blood: [SHADER] } }, "cg_particles.c"))
      .toThrow("blood requires its 5 registered source frames");
    const active = new ParticleSystem(f.state, { ...f.system.host, animations: f.animations });
    expect(() => active.explosion({ animation: "blood", origin: ORIGIN, velocity: VELOCITY, duration: -100, sizeStart: 2, sizeEnd: 4 }))
      .toThrow(new CommonError("drop", "CG_ParticleExplosion: unknown animation string: blood\n"));
  });
  test("selects every frame of every sequence, including the exact end-time frame", async () => {
    for (const [name, count] of sequences) {
      const { system, state, random } = await setupStandalone();
      system.explosion({ animation: name.toUpperCase(), origin: ORIGIN, velocity: vec3(0, 0, 0), duration: -count * 10, sizeStart: 2, sizeEnd: 4 });
      if (name !== "explode1") expect(positions(only(system.addParticles()))).toEqual([
        vec3(0, -2, 98), vec3(0, -2, 102), vec3(0, 2, 102), vec3(0, 2, 98),
      ]);
      for (let frame = 0; frame < count; frame++) {
        state.time = frame * 10 + 5;
        const poly = only(system.addParticles()); expect(poly.shader?.name).toBe(`${name}${frame + 1}`);
        // P_ANIM writes literal 255 channels even though stored alpha is 1 here and .5 in cg_marks.c.
        expect(poly.vertices.map(vertex => vertex.color)).toEqual(Array.from({ length: 4 }, () => vec4(255, 255, 255, 255)));
      }
      state.time = count * 10; expect(only(system.addParticles()).shader?.name).toBe(`${name}${count}`);
      state.time++; expect(system.addParticles()).toEqual([]); expect(system.activeCount).toBe(0); expect(random.seed).toBe(1);
    }
  });
  test("preserves binary32 explode1 aspect and asymmetric start-height/end-width assignment", async () => {
    const { system, state } = await setupStandalone();
    system.explosion({ animation: "explode1", origin: vec3(0, 0, 0), velocity: vec3(0, 0, 0), duration: -1000, sizeStart: 20, sizeEnd: 30 });
    expect(positions(only(system.addParticles()))).toEqual([
      vec3(0, -20, -28.099998474121094), vec3(0, -20, 28.099998474121094),
      vec3(0, 20, 28.099998474121094), vec3(0, 20, -28.099998474121094),
    ]);
    state.time = 500;
    expect(positions(only(system.addParticles()))).toEqual([
      vec3(0, -31.07499885559082, -29.049999237060547), vec3(0, -31.07499885559082, 29.049999237060547),
      vec3(0, 31.07499885559082, 29.049999237060547), vec3(0, 31.07499885559082, -29.049999237060547),
    ]);
  });
  test("retains 8192 slots, drops overflow without consuming randomness, and reuses released slots", async () => {
    const { system, random } = await setupStandalone();
    for (let index = 0; index < 8192; index++) system.misc(SHADER, vec3(index, 0, 0), 1, -1, 0);
    const seed = random.seed;
    system.explosion({ animation: "blood", origin: ORIGIN, velocity: VELOCITY, duration: 100, sizeStart: 2, sizeEnd: 4 });
    expect(system.activeCount).toBe(8192); expect(random.seed).toBe(seed);
    const polys = system.addParticles(); expect(polys).toHaveLength(8192);
    expect(polys[0]?.vertices[0]?.position.x).toBe(8191); expect(system.activeCount).toBe(0);
    system.explosion({ animation: "blood", origin: ORIGIN, velocity: VELOCITY, duration: -100, sizeStart: 2, sizeEnd: 4 });
    expect(only(system.addParticles()).shader?.name).toBe("blood1"); expect(system.activeCount).toBe(1);
  });
  test("reset publishes earlier sequence writes before a later registration failure", async () => {
    const { system, state } = await setupStandalone(), reached: string[] = [];
    await expect(system.clear({ registerShader: async name => {
      reached.push(name); if (name === "blacksmokeanim2") throw new Error("registration interrupted");
      return name === "blacksmokeanim1" ? null : SHADER;
    } })).rejects.toThrow("registration interrupted");
    expect(reached).toHaveLength(25);
    system.explosion({ animation: "blacksmokeanim", origin: ORIGIN, velocity: VELOCITY, duration: -250, sizeStart: 2, sizeEnd: 4 });
    expect(system.addParticles()).toEqual([]); expect(system.activeCount).toBe(1);
    state.time = 15; expect(only(system.addParticles()).shader?.name).toBe("blacksmokeanim2");
    system.explosion({ animation: "explode1", origin: ORIGIN, velocity: VELOCITY, duration: -100, sizeStart: 2, sizeEnd: 4 });
    expect(system.addParticles()[0]?.shader).toBe(SHADER);
  });
  test("shared smoke fade and misc sprite output retain source colors in both profiles", async () => {
    for (const f of [await setup(), await setupStandalone()]) {
      f.system.misc(SHADER, ORIGIN, 4, -1, 0.2);
      expect(only(f.system.addParticles()).vertices.map(vertex => vertex.color)).toEqual(Array.from({ length: 4 }, () => vec4(255, 255, 255, 255)));
      f.system.bulletDebris(ORIGIN, VELOCITY, 1000); f.state.time = 750;
      expect(only(f.system.addParticles()).vertices[0]?.color).toEqual(vec4(63, 63, 63, 127));
    }
  });
});

describe("particle source integration boundaries", () => {
  test("weather configstrings preserve type/range/link ownership", async () => {
    const { system, configstrings } = await setup(); expect(system.newParticleArea(5)).toBe(false);
    configstrings.set(5, "3 0 0 100 0 0 0 2 1 77"); expect(system.newParticleArea(5)).toBe(true); expect(system.activeCount).toBe(2);
    const entity = new ClientEntity(); entity.currentState.frame = 77; system.snowLink(entity, false); expect(system.addParticles()).toEqual([]); system.snowLink(entity, true); expect(system.addParticles()).toHaveLength(2);
    expect(() => system.snow(SHADER, ORIGIN, ORIGIN, false, 1, 0)).toThrow("snow start");
  });
  test("blood pool requires four world impacts and rejects entities or start-solid", async () => {
    const { system, traces, setTrace } = await setup(); expect(system.validBloodPool(vec3(0, 0, 0))).toBe(true); expect(traces).toHaveLength(4);
    expect(traces.every(trace => trace.skip === -1 && trace.mask === 1)).toBe(true);
    setTrace(end => hit(end, 0)); expect(system.validBloodPool(vec3(0, 0, 0))).toBe(false); system.bloodPool(SHADER, { end: ORIGIN }); expect(system.activeCount).toBe(0);
    setTrace(end => ({ ...hit(end), solidity: "start-solid" })); expect(system.validBloodPool(ORIGIN)).toBe(false);
    setTrace(end => hit(end)); system.bloodPool(SHADER, { end: ORIGIN }); expect(only(system.addParticles()).vertices[0]?.color).toEqual({ x: 255, y: 255, z: 255, w: 255 });
  });
  test("oil removal rejects the source uninitialized polygon instead of inventing fade geometry", async () => {
    const { system, state } = await setup(); const entity = new ClientEntity(); entity.currentState.origin = ORIGIN; system.oilSlick(SHADER, entity); system.oilSlickRemove();
    expect(() => system.addParticles()).toThrow("no initialized polygon"); state.time = 101; expect(system.addParticles()).toEqual([]);
    system.oilSlick(null, entity); system.oilSlickRemove(); expect(system.addParticles()).toEqual([]);
  });
  test("RagePro forces smoke alpha opaque and missing shaders remain observable", async () => {
    const { system, state, warnings } = await setup("rage-pro"); system.bulletDebris(ORIGIN, VELOCITY, 1000); state.time = 750; expect(only(system.addParticles()).vertices[0]?.color.w).toBe(255);
    system.impactSmokePuff(null, ORIGIN); expect(warnings).toHaveLength(1); expect(system.addParticles()).toHaveLength(1);
  });
  test("dust returns negated direction and retains source random calls before clearing acceleration", async () => {
    const { system, random } = await setup(); expect(system.dust(ORIGIN, VELOCITY)).toEqual(vec3(-8, -4, -0)); expect(random.seed >>> 0).toBe(1662200408);
    const poly = only(system.addParticles());
    expect(positionBits(poly)).toEqual([[-1041958609, -1036435894, 1116209152], [-1041958609, 1099793260, 1116209152], [-1041958609, 1099793260, 1124335616], [-1041958609, -1036435894, 1124335616]]);
    expect(poly.vertices[0]?.color.w).toBe(191);
  });
  test("snapshot-dependent culling and unknown animation are explicit failures", async () => {
    const { system, state } = await setup();
    expect(() => system.explosion({ animation: "missing", origin: ORIGIN, velocity: VELOCITY, duration: 100, sizeStart: 1, sizeEnd: 2 }))
      .toThrow(new CommonError("drop", "CG_ParticleExplosion: unknown animation string: missing\n"));
    system.explosion({ animation: "explode1", origin: ORIGIN, velocity: VELOCITY, duration: -100, sizeStart: 1, sizeEnd: 2 }); state.snap = null; expect(() => system.addParticles()).toThrow("snapshot");
  });
});

const DATA = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const PRODUCTS: readonly Product[] = ["baseq3", "missionpack"];
for (const product of PRODUCTS) test.skipIf(!existsSync(DATA))(`${product} retail explosion shaders render real particle polygons`, async () => {
  const assets = await VirtualFileSystem.openInspection({ dataPath: DATA, homePath: DATA, cdPath: null, product });
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Source particles", width: 96, height: 96, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const renderer = new SoftwareRenderer(96, 96, images, gl?.subpixelBits), recording = new BatchRecordingBackend(renderer);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 700 };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  let commands: RenderCommandBuffer | null = null;
  try {
    const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
    const animations = await loadParticleAnimations(resources);
    const state = new ClientGameState(product, 0, 0); snapshot(state, vec3(0, 0, 0));
    const system = new ParticleSystem(state, { animations, media: { tracerShader: await resources.registerShader("gfx/misc/tracer"), smokePuffShader: await resources.registerShader("smokePuff"), waterBubbleShader: await resources.registerShader("waterBubble") },
      random: new GameRandom(1), hardwareType: "generic", configString: () => "", print: message => { throw new Error(message); }, prediction: { trace: (_start, end) => hit(end) } });
    const missingShader = await resources.registerShader("fixtures/particles/absent-shader-zero");
    expect(missingShader).toBeNull();
    const missingMediaSystem = new ParticleSystem(state, { ...system.host, media: { tracerShader: missingShader, smokePuffShader: missingShader, waterBubbleShader: missingShader } });
    missingMediaSystem.bulletDebris(vec3(100, 0, 0), vec3(0, 0, 0), 1000);
    expect(missingMediaSystem.addParticles()).toEqual([]); expect(missingMediaSystem.activeCount).toBe(1);
    system.explosion({ animation: "explode1", origin: vec3(100, 0, 0), velocity: vec3(0, 0, 0), duration: -1400, sizeStart: 20, sizeEnd: 30 });
    state.time = 700; const polys = system.addParticles(); expect(polys).toHaveLength(1);
    commands.addView({ viewport: { x: 0, y: 0, width: 96, height: 96 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
    commands.addPreparedViews(resources.prepareFrame({ refdef: { ...state.refdef, width: 96, height: 96, fovX: 90, fovY: 90, time: 700, renderFlags: 1 }, polys }));
    commands.submit();
    const batches = recording.trace().flatMap(view => view.batches);
    expect(batches.length).toBeGreaterThan(0); expect(renderer.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
    if (gl !== null) {
      const pixels = gl.readPixels(); let error = 0;
      for (const [index, value] of pixels.entries()) { const expected = renderer.pixels[index]; if (expected === undefined) throw new Error("Missing particle CPU pixel"); error += Math.abs(value - expected); }
      expect(error / pixels.length).toBeLessThan(1);
    }
  } finally { commands?.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
}, 30000);
