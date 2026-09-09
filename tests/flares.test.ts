// Source expectations: renderer/tr_flares.c and tr_main.c clip-to-window conversion.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { identityMat4 } from "../src/core/math.ts";
import type { Mat4 } from "../src/core/math.ts";
import { SourceFlare, SourceFlares } from "../src/render/flares.ts";
import type { SourceFlareDraw, SourceFlareView } from "../src/render/flares.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { RendererBackEndCounters } from "../src/render/performance.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { sourceTransformClipToWindow, sourceTransformModelToClip } from "../src/render/view.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";
import { publishTexture } from "./render-target-fixture.ts";

const model = identityMat4();
const projection: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.25, -1, 0, 0, -9, 0];
const settings = { enabled: true, fade: 7, size: 40 };
const white = { x: 1, y: 1, z: 1 };
const point = { x: 0, y: 0, z: -10 };
const view: SourceFlareView = { frameCount: 1, frameSceneNum: 1, inPortal: false, time: 1000,
  origin: { x: 0, y: 0, z: 0 }, viewport: { x: 8, y: 12, width: 640, height: 480 }, projection };
function head(flares: SourceFlares): SourceFlare {
  const cell = flares.activeHead;
  if (cell === null) throw new Error("Fixture flare missing");
  return cell;
}
function count(flares: SourceFlares): number {
  let count = 0;
  for (let cell = flares.activeHead; cell !== null; cell = cell.next) count++;
  return count;
}
async function drawing(): Promise<SourceFlareDraw> {
  const image = publishTexture(new RendererImageCatalog(), { name: "flare", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const registry = new MaterialRegistry(async name => ({ definition: null, image, whiteImage: image, defaulted: false, sky: null,
    finished: finishImplicitShader({ kind: "dynamic", name, profile: createRendererSettings().registrationProfile(),
      baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } }) }),
  text => { throw new Error(text); });
  const tess = new SourceTessState();
  return { tess, shader: await registry.register("flareShader", { kind: "none" }), identityLight: 1,
    *endSurface() { tess.endSurface(); }, *disablePortalClip() {} };
}

test("source model/clip/window transforms retain float32 sums and round local viewport pixels", () => {
  const result = sourceTransformModelToClip(point, model, projection);
  expect(result).toEqual({ eye: { ...point, w: 1 }, clip: { x: 0, y: 0, z: 3.5, w: 10 } });
  expect(sourceTransformClipToWindow(result.clip, view.viewport)).toEqual({
    normalized: { x: 0, y: 0, z: Math.fround(0.675) }, window: { x: 320, y: 240, z: Math.fround(0.675) } });
  const cancellation: Mat4 = [1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1];
  expect(sourceTransformModelToClip({ x: 16777216, y: 1, z: -16777216 }, cancellation, model).eye.x).toBe(0);
  expect(() => sourceTransformClipToWindow({ x: 0, y: 0, z: 0, w: 0 }, view.viewport)).toThrow("undefined source float-to-int");
});

test("flare scene snapshots use supplied source image frames and live cvar integer/float domains", () => {
  const flares = new SourceFlares(new RendererBackEndCounters());
  const first = flares.beginScene(5), second = flares.beginScene(5);
  flares.beginFrame(); const next = flares.beginScene(6);
  expect([first, second, next]).toEqual([{ frameCount: 5, frameSceneNum: 1 }, { frameCount: 5, frameSceneNum: 2 }, { frameCount: 6, frameSceneNum: 1 }]);
  flares.clear(); expect(flares.scenesRendered).toBe(3); expect(flares.beginScene(6).frameSceneNum).toBe(2);
  const cvars = new CvarRegistry(), live = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true }).flares;
  expect([live.enabled, live.size, live.fade]).toEqual([false, 40, 7]);
  cvars.set("r_flares", "0.5", true); cvars.set("r_flareSize", "0.5", true); cvars.set("r_flareFade", "0.25", true);
  expect([live.enabled, live.size, live.fade]).toEqual([false, 0.5, 0.25]);
  cvars.set("r_flares", "1", true); expect(live.enabled).toBe(true);
});

test("flare identity includes surface, scene and portal with128 retained cells and source clear", () => {
  const counters = new RendererBackEndCounters(), flares = new SourceFlares(counters), surface = {};
  flares.addFlare(surface, 3, point, white, null, view, model);
  const original = head(flares);
  expect(original).toMatchObject({ fogNum: 3, addedFrame: 1, fadeTime: -1000, windowX: 328, windowY: 252, eyeZ: -10 });
  original.visible = true;
  flares.addFlare(surface, 4, point, white, null, { ...view, frameCount: 2 }, model);
  expect(head(flares)).toBe(original); expect(original.visible).toBe(true);
  flares.addFlare(surface, 4, point, white, null, { ...view, frameCount: 2 }, model);
  expect(original.visible).toBe(false);
  flares.addFlare(surface, 0, point, white, null, { ...view, inPortal: true }, model);
  flares.addFlare(surface, 0, point, white, null, { ...view, frameSceneNum: 2 }, model);
  expect(count(flares)).toBe(3);
  for (let index = 0; index < 126; index++) flares.addFlare({}, 0, point, white, null, view, model);
  expect(count(flares)).toBe(128); expect(counters.c_flareAdds).toBe(131);
  flares.clear(); expect(flares.activeHead).toBeNull(); expect(original.surface).toBeNull();
  expect(original.windowX).toBe(0); expect(counters.c_flareAdds).toBe(131);
});

test("flare additions count rejected clip boundaries and use unclamped source normal fading", () => {
  const counters = new RendererBackEndCounters(), flares = new SourceFlares(counters);
  for (const x of [-10, 10]) flares.addFlare({}, 0, { ...point, x }, white, null, view, model);
  flares.addFlare({}, 0, { ...point, x: 9.9999 }, white, null, view, model);
  expect(count(flares)).toBe(0); expect(counters.c_flareAdds).toBe(3);
  flares.addFlare({}, 0, point, white, { x: 0, y: 0, z: -1 }, view, model);
  expect(head(flares).color.x).toBeLessThan(-0.99);
});

test("standalone dynamic light flares use first inclusive fog and stable light object identity", () => {
  const counters = new RendererBackEndCounters(), flares = new SourceFlares(counters);
  const light = { origin: point, color: white, radius: 20 };
  const fog = { min: point, max: { x: 10, y: 10, z: 0 } };
  flares.addDlightFlares([light], [fog, fog], { ...settings, enabled: false }, view, model);
  expect(counters.c_flareAdds).toBe(0);
  flares.addDlightFlares([light], [fog, fog], settings, view, model);
  expect(head(flares).fogNum).toBe(1); expect(head(flares).surface).toBe(light);
  flares.addDlightFlares([light], [], settings, view, model);
  expect(head(flares).fogNum).toBe(0); expect(count(flares)).toBe(1);
});

test("depth testing resets finish before readback and preserves visible/invisible fade transitions", () => {
  const counters = new RendererBackEndCounters(), flares = new SourceFlares(counters), cell = new SourceFlare();
  cell.eyeZ = -10; cell.windowX = 3; cell.windowY = 7;
  const calls: string[] = [];
  const depth = { resetFinishCalled() { calls.push("finish=false"); }, readDepthPixel(x: number, y: number) { calls.push(`${x},${y}`); return 0.675; } };
  flares.testFlare(cell, view, settings, depth);
  expect(calls).toEqual(["finish=false", "3,7"]);
  expect(cell.visible).toBe(true); expect(cell.fadeTime).toBe(999); expect(cell.drawIntensity).toBe(Math.fround(0.007));
  flares.testFlare(cell, { ...view, time: 1200 }, settings, depth); expect(cell.drawIntensity).toBe(1);
  cell.eyeZ = -100;
  flares.testFlare(cell, { ...view, time: 1300 }, settings, depth);
  expect(cell.visible).toBe(false); expect(cell.fadeTime).toBe(1299); expect(cell.drawIntensity).toBe(Math.fround(0.993));
  flares.testFlare(cell, { ...view, time: 1500 }, settings, depth); expect(cell.drawIntensity).toBe(0);
  expect(() => flares.testFlare(cell, view, settings, { ...depth, readDepthPixel() { throw new Error("read failed"); } })).toThrow("read failed");
  expect(counters.c_flareTests).toBe(5); expect(calls.at(-1)).toBe("finish=false");
});

test("flare depth tolerance is a strict signed24 eye-space difference", () => {
  const flares = new SourceFlares(new RendererBackEndCounters()), cell = new SourceFlare();
  const exactProjection: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -8, 0];
  const depth = { resetFinishCalled() {}, readDepthPixel() { return 0; } };
  cell.eyeZ = -28; cell.visible = true;
  flares.testFlare(cell, { ...view, projection: exactProjection }, settings, depth);
  expect(cell.visible).toBe(false);
  cell.eyeZ = Math.fround(-27.999998);
  flares.testFlare(cell, { ...view, projection: exactProjection }, settings, depth);
  expect(cell.visible).toBe(true);
  cell.eyeZ = -1;
  flares.testFlare(cell, { ...view, projection: exactProjection }, settings, depth);
  expect(cell.visible).toBe(true);
});

test("flare drawing retains tess Z/normals/lightmap and wraps source byte colors", async () => {
  const counters = new RendererBackEndCounters(), flares = new SourceFlares(counters), draw = await drawing();
  const vertices = [0, 1, 2, 3].map(index => ({ position: { x: 0, y: 0, z: index + 1 }, normal: { x: 3, y: 4, z: 5 },
    texCoord: { x: 8, y: 9 }, lightmapCoord: { x: 6, y: 7 }, color: { x: 0, y: 0, z: 0, w: 0 } }));
  draw.tess.appendGeometry({ vertices, indices: [0, 1, 2] }, "bsp-normal");
  const cell = new SourceFlare();
  cell.windowX = 320; cell.windowY = 240; cell.eyeZ = -128; cell.drawIntensity = 1;
  cell.color = { x: 2, y: -1, z: 0.5 }; cell.fogNum = 2;
  expect([...flares.renderFlare(cell, view, settings, draw)]).toEqual([]);
  const quad = draw.tess.textQuad();
  expect(quad.map(vertex => vertex.position)).toEqual([{ x: 240, y: 160, z: 1 }, { x: 240, y: 320, z: 2 },
    { x: 400, y: 320, z: 3 }, { x: 400, y: 160, z: 4 }]);
  expect(quad.map(vertex => vertex.texCoord)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }]);
  expect(quad.every(vertex => vertex.normal.x === 3 && vertex.lightmapCoord.x === 6)).toBe(true);
  expect(quad[0].color).toEqual({ x: 254, y: 1, z: 127, w: 255 });
  expect([draw.tess.numVertexes, draw.tess.numIndexes, draw.tess.fog]).toEqual([4, 0, 2]);
  expect(counters.c_flareRenders).toBe(1);
});

test("renderFlares prunes stale/faded cells, zeros other scenes, and scopes projection after portal disable", async () => {
  const counters = new RendererBackEndCounters(), flares = new SourceFlares(counters), draw = await drawing();
  flares.addFlare({}, 0, point, white, null, { ...view, frameCount: -1 }, model);
  flares.addFlare({}, 0, point, white, null, { ...view, frameSceneNum: 2 }, model);
  const otherScene = head(flares); otherScene.drawIntensity = 0.5;
  flares.addFlare({}, 0, point, white, null, { ...view, inPortal: true }, model);
  const oldProjector = draw.tess.projector, calls: string[] = [];
  const depth = { resetFinishCalled() { calls.push("finish"); }, readDepthPixel() { calls.push("depth"); return 0.675; } };
  const execution: SourceFlareDraw = { ...draw,
    *disablePortalClip() { calls.push("disable-clip"); expect(draw.tess.projector).toBe(oldProjector); },
    *endSurface() { calls.push("draw"); expect(draw.tess.projector).not.toBe(oldProjector); draw.tess.endSurface(); } };
  expect([...flares.renderFlares({ ...view, inPortal: true }, settings, depth, execution)]).toEqual([]);
  expect(calls).toEqual(["finish", "depth", "disable-clip", "draw"]);
  expect(count(flares)).toBe(2); expect(otherScene.drawIntensity).toBe(0); expect(draw.tess.projector).toBe(oldProjector);
  expect([...flares.renderFlares({ ...view, frameCount: 4 }, { ...settings, enabled: false }, depth, execution)]).toEqual([]);
  expect(count(flares)).toBe(2);
  expect([...flares.renderFlares({ ...view, frameCount: 4 }, settings, depth, execution)]).toEqual([]);
  expect(count(flares)).toBe(0);
});

test("flare source failures retain reached counters, tess and projection instead of rollback", async () => {
  const counters = new RendererBackEndCounters(), flares = new SourceFlares(counters), draw = await drawing();
  const cell = new SourceFlare(); cell.color = { x: NaN, y: 0, z: 0 }; cell.drawIntensity = 1;
  expect(() => [...flares.renderFlare(cell, view, settings, draw)]).toThrow("undefined source float-to-int");
  expect(counters.c_flareRenders).toBe(1); expect(draw.tess.material).toBeNull();
  flares.addFlare({}, 0, point, white, null, view, model);
  const projector = draw.tess.projector;
  expect(() => [...flares.renderFlares(view, settings, { resetFinishCalled() {}, readDepthPixel() { return 0.675; } },
    { ...draw, *endSurface() { throw new Error("iterator failed"); } })]).toThrow("iterator failed");
  expect(draw.tess.projector).not.toBe(projector);
  expect([draw.tess.numVertexes, draw.tess.numIndexes]).toEqual([4, 6]);
});
