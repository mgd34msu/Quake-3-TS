import { HunkArena } from "../src/core/hunk.ts";
// RB_DrawSun and its dormant caller, id Software renderer/tr_sky.c and tr_backend.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3, vec4 } from "../src/core/math.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { drawSun } from "../src/render/sun.ts";
import type { SunView } from "../src/render/sun.ts";
import { RendererResources } from "../src/render/world.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const data = new Map([
    ["scripts/sun.shader", new TextEncoder().encode("test/sky { q3map_sun 1 1 1 100 0 0 skyparms - 128 - cull none { map $whiteimage rgbGen const ( 0 0 0 ) } } sun { cull none { map $whiteimage rgbGen exactvertex alphaGen vertex } }")],
    ["maps/sun.bsp", renderBspFixture([{ shader: "test/sky", lightmap: -1 }, { shader: "test/sky", lightmap: -1 }], [])],
  ]);
  const files = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    has: path => data.has(path), list: () => [...data.keys()], read: async path => {
      const bytes = data.get(path); if (bytes === undefined) throw new Error(`Missing ${path}`); return bytes;
    },
  });
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(64, 48, images), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const mixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined,
    files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => mixer },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" },
    print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins,
    drawDebugSurface: () => undefined, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: () => undefined, clock: { milliseconds: () => 0 },
    identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  const shader = resources.picture(await resources.registerShader("sun")).material;
  return { resources, shader, settings, cvars, commands, target, recording, cpu };
}

const sunView: SunView = { skyRendered: true, far: 1750, direction: vec3(1, 0, 0),
  project: position => vec4(position.x, position.y, position.z, 1) };

test("sun gates retain all state and do not read r_drawSun when no sky was rendered", async () => {
  const { resources, shader } = await fixture(), tess = resources.tess;
  tess.beginSurface(shader, 7, 12); tess.setDepthRange([0, 0.3]);
  const project = tess.projector;
  const unreachable = () => { throw new Error("unexpected evaluation"); };
  expect([...drawSun(tess, shader, { ...sunView, skyRendered: false },
    { get drawSun(): number { throw new Error("unexpected cvar read"); } }, unreachable)]).toEqual([]);
  expect([...drawSun(tess, shader, sunView, { drawSun: 0 }, unreachable)]).toEqual([]);
  expect(tess.projector).toBe(project); expect(tess.fog).toBe(7);
  expect(tess.shaderTime).toBe(12); expect(tess.actualDepthRange).toEqual([0, 0.3]);
});

test("sun writes source corners, UVs, RGB and indexes while retaining alpha, normals, lightmap and fog", async () => {
  const { resources, shader } = await fixture(), tess = resources.tess;
  tess.beginSurface(shader, 7, 12);
  tess.appendGeometry({ vertices: Array.from({ length: 4 }, (_, index) => ({ position: vec3(0, 0, 0),
    normal: vec3(index, 2, 3), texCoord: { x: 8, y: 9 }, lightmapCoord: { x: 10, y: index },
    color: { x: 4, y: 5, z: 6, w: 31 + index } })), indices: [0, 1, 2] }, "bsp-normal");
  const iterator = drawSun(tess, shader, sunView, { drawSun: -2 }, () => { throw new Error("source EndSurface failure"); });
  expect(iterator.next().value).toEqual({ kind: "depth-range", range: [1, 1] });
  expect(tess.numVertexes).toBe(4); expect(tess.numIndexes).toBe(3);
  expect(tess.projector).toBe(sunView.project);
  expect(() => iterator.next()).toThrow("source EndSurface failure");
  const geometry = tess.snapshotGeometry();
  expect(geometry.vertices.map(vertex => vertex.position)).toEqual([
    vec3(1000, -400, -400), vec3(1000, 400, -400), vec3(1000, 400, 400), vec3(1000, -400, 400),
  ]);
  expect(geometry.vertices.map(vertex => vertex.texCoord)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }]);
  expect(geometry.vertices.map(vertex => vertex.color)).toEqual(Array.from({ length: 4 }, (_, index) => ({ x: 255, y: 255, z: 255, w: 31 + index })));
  expect(geometry.vertices.map(vertex => vertex.normal)).toEqual(Array.from({ length: 4 }, (_, index) => vec3(index, 2, 3)));
  expect(geometry.vertices.map(vertex => vertex.lightmapCoord)).toEqual(Array.from({ length: 4 }, (_, index) => ({ x: 10, y: index })));
  expect(geometry.indices).toEqual([0, 1, 2, 0, 2, 3]); expect(tess.fog).toBe(7);
  expect(tess.actualDepthRange).toEqual([1, 1]);
  const oblique = drawSun(tess, shader, { ...sunView, direction: vec3(0.6, 0.8, 0) }, { drawSun: 1 },
    () => { throw new Error("oblique EndSurface"); });
  oblique.next(); expect(() => oblique.next()).toThrow("oblique EndSurface");
  expect(tess.snapshotGeometry().vertices.map(vertex => vertex.position)).toEqual([
    vec3(280, 1040, -400), vec3(280, 1040, 400), vec3(920, 560, 400), vec3(920, 560, -400),
  ]);
});

test("registered dormant sun executes the real CPU material path only when explicitly called after sky", async () => {
  const { resources, cvars, commands, recording, cpu } = await fixture();
  const world = await resources.loadWorld("sun"), refdef = cameraRefdef({ origin: vec3(0, 8, 2), angles: vec3(0, 0, 0) }, 64, 48);
  cvars.set("r_drawSun", "1");
  resources.drawSun(); expect(resources.tess.numIndexes).toBe(0);
  commands.addPreparedViews(world.prepareFrame({ refdef })); commands.submit();
  expect(resources.tess.material?.name).toBe("test/sky");
  expect(cpu.pixels.every((value, index) => index % 4 === 3 || value === 0)).toBe(true);
  const previous = recording.trace().flatMap(view => view.batches).length;
  cvars.set("r_drawSun", "0"); resources.drawSun();
  expect(resources.tess.material?.name).toBe("test/sky");
  expect(recording.trace().flatMap(view => view.batches)).toHaveLength(previous);
  cvars.set("r_drawSun", "-2");
  resources.drawSun();
  expect(resources.tess.material?.name).toBe("sun");
  expect(resources.tess.numVertexes).toBe(4); expect(resources.tess.numIndexes).toBe(0);
  expect(resources.tess.actualDepthRange).toEqual([0, 1]);
  expect(recording.trace().flatMap(view => view.batches)).toHaveLength(previous + 1);
  const corners = recording.trace().flatMap(view => view.batches).at(-1)?.vertices;
  const first = corners?.[0], opposite = corners?.[2];
  if (first === undefined || opposite === undefined) throw new Error("Missing executed sun vertices");
  expect(first.position.x).toBe(-opposite.position.x);
  expect(first.position.y).toBe(-opposite.position.y);
  expect(cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
  cvars.set("r_fastsky", "1");
  commands.addPreparedViews(world.prepareFrame({ refdef })); commands.submit();
  const afterFastSky = recording.trace().flatMap(view => view.batches).length;
  resources.drawSun(); expect(resources.tess.material?.name).toBe("test/sky");
  expect(recording.trace().flatMap(view => view.batches)).toHaveLength(afterFastSky);
});
