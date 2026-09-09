import { describe, expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { Vec4 } from "../src/core/math.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { sourceStateBits } from "../src/render/source-state.ts";
import type { SourceStateInput } from "../src/render/source-state.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, RenderState, SourceDebugTris, SourceStageCell, SourceStageData } from "../src/render/types.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const viewport = { x: 0, y: 0, width: 32, height: 32 };
const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 }, black: Vec4 = { x: 0, y: 0, z: 0, w: 1 };
const opaque: RenderState & SourceStateInput = { ...OPAQUE_STATE, cull: "none", depthTest: "less-equal", blend: { source: "one", destination: "zero" } };
const palettePixels = new Uint8Array([32, 96, 160, 255, 208, 176, 144, 255]);
function point(x: number, y: number, z = 0): Vec4 { return { x: x / 16 - 1, y: 1 - y / 16, z, w: 1 }; }
function cell(u = 0.75, u2 = 0.25, color: Vec4 = white): SourceStageCell {
  return { color, texCoord: { x: u, y: 0.5 }, texCoord2: { x: u2, y: 0.5 },
    rawTexCoord: { x: 0.75, y: 0.5 }, rawTexCoord2: { x: 0.25, y: 0.5 } };
}
function triangle(image: RendererImage): SourceDebugTris {
  return { allocation: { kind: "standalone" }, whiteImage: image, positions: [point(4, 4, 0.75), point(28, 4, 0.75), point(16, 28, 0.75)],
    indices: [0, 1, 2], scratch: [cell(), cell(), cell()] };
}
function source(image: RendererImage, indices: readonly number[] = [0, 1, 2], state: RenderState & SourceStateInput = opaque): Extract<SourceStageData, { batch: { texturing: "single" } }> {
  const input = triangle(image);
  return { kind: "generic-single", stateBits: sourceStateBits({ ...state,
    blend: state.blend.source === "one" && state.blend.destination === "zero" ? null : state.blend }),
    batch: { primitive: "triangles", texturing: "single", texture: { kind: "bind-image", image }, indices, state,
    vertices: input.positions.map(position => ({ position, color: white, texCoord: { x: 0.75, y: 0.5 } })) }, scratch: input.scratch };
}
function paired(first: RendererImage, second: RendererImage): Extract<SourceStageData, { batch: { texturing: "pair" } }> {
  const single = source(first, []);
  return { kind: "generic-pair", stateBits: single.stateBits, batch: { ...single.batch, texturing: "pair", vertices: single.batch.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.75, y: 0.5 } })),
    secondTexture: { binding: { kind: "bind-image", image: second }, environment: "modulate" } },
    scratch: single.scratch.map(value => ({ ...value, rawTexCoord2: { x: 0.75, y: 0.5 } })) };
}
function executeSource(cpu: SoftwareRenderer, stage: SourceStageData, mode = 1): void {
  const first = stage.batch.texture, second = stage.batch.texturing === "pair" ? stage.batch.secondTexture.binding : null;
  if (first.kind === "shader-cinematic" || second?.kind === "shader-cinematic") throw new Error("Debug fixture requires static images");
  if (stage.kind === "generic-single" || stage.kind === "generic-pair")
    cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: stage.kind === "generic-single", scratch: stage.scratch });
  const prepared = cpu.prepareSourceGeometry(stage);
  prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, first);
  if (second !== null) { prepared.prepareTexture(1); prepared.applyTexture(1, second); }
  prepared.finishTextures(); prepared.draw(mode); prepared.cleanup();
}
function drawTris(cpu: SoftwareRenderer, input: SourceDebugTris, mode: number): void {
  const prepared = cpu.prepareDebugTris(input); prepared.begin(); prepared.draw(mode); prepared.cleanup();
}
function normal(cpu: SoftwareRenderer, image: RendererImage, y = 16): void {
  cpu.drawDebugNormals({ whiteImage: image, segments: [[point(4, y, 0.75), point(28, y, 0.75)]] });
}
function pixel(cpu: SoftwareRenderer, x: number, y: number): number[] {
  return [...cpu.pixels.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
}
function reset(cpu: SoftwareRenderer, depth = 0.1, clipPlane?: Vec4): void {
  cpu.beginView({ viewport, clear: { color: black, depth, stencil: true }, ...(clipPlane === undefined ? {} : { clipPlane }) });
}
interface Fixture { readonly cpu: SoftwareRenderer; readonly images: RendererImageCatalog; readonly cvars: CvarRegistry; readonly image: RendererImage; readonly palette: RendererImage }
function fixture(action: (value: Fixture) => void, stencilBits = 0): void {
  const images = new RendererImageCatalog(), cvars = new CvarRegistry();
  images.setBindingSettings(new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true }));
  const cpu = new SoftwareRenderer(32, 32, images, 8, stencilBits), target = new RenderTarget(images, [cpu]);
  try {
    const texture = (name: string, pixels: Uint8Array): RendererImage => publishTexture(images, { name, width: pixels.length / 4, height: 1,
      pixels, internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const image = texture("debug white", new Uint8Array([255, 255, 255, 255])), palette = texture("debug palette", palettePixels);
    texture("debug registration sentinel", new Uint8Array([255, 255, 255, 255]));
    reset(cpu); action({ cpu, images, cvars, image, palette });
  } finally { target.close(); }
}

describe("CPU source DrawTris and DrawNormals", () => {
  test("all source modes retain the debug state sequence, outlines write zero depth, and normals bypass selection", () => {
    for (const mode of [0, 1, 2, 3, -1, 7]) fixture(({ cpu, image }) => {
      drawTris(cpu, triangle(image), mode);
      expect(pixel(cpu, 16, 4)).toEqual(mode === -1 || mode === 7 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
      expect(pixel(cpu, 16, 12)).toEqual([0, 0, 0, 255]);
      normal(cpu, image);
      expect(pixel(cpu, 16, 16)).toEqual([255, 255, 255, 255]);
      const fill = source(image, [0, 1, 2], { ...opaque, depthTest: "equal", depthRange: [0, 0] }).batch;
      executeStaticBatch(cpu, { ...fill, vertices: fill.vertices.map(vertex => ({ ...vertex, color: { x: 1, y: 0, z: 0, w: 1 } })) });
      expect(pixel(cpu, 16, 16)).toEqual([255, 0, 0, 255]);
      expect(pixel(cpu, 16, 12)).toEqual([0, 0, 0, 255]);
    });
  });

  test("retained face culling suppresses outlines but never normal segments", () => {
    for (const cull of ["back", "front"] satisfies readonly RenderState["cull"][]) fixture(({ cpu, image }) => {
      cpu.drawImmediate({ kind: "cull", cull }); drawTris(cpu, triangle(image), 1);
      expect(pixel(cpu, 16, 4)).toEqual(cull === "back" ? [0, 0, 0, 255] : [255, 255, 255, 255]);
      normal(cpu, image); expect(pixel(cpu, 16, 16)).toEqual([255, 255, 255, 255]);
    });
  });

  test("near and portal clipping draw the analytically clipped perimeter without fan spokes", () => fixture(({ cpu, image }) => {
    for (const portal of [false, true]) {
      reset(cpu, 0.1, portal ? { x: 1, y: 0, z: 0, w: 0.25 } : undefined);
      const input = { ...triangle(image), positions: [point(4, 4, -2), point(28, 4), point(16, 28)] };
      drawTris(cpu, input, 1); const actual = cpu.pixels.slice();
      expect(pixel(cpu, 19, 10)).toEqual([0, 0, 0, 255]);
      reset(cpu, 0.1, portal ? { x: 1, y: 0, z: 0, w: 0.25 } : undefined);
      const perimeter = portal ? [point(12, 20), point(12, 12), point(16, 4), point(28, 4), point(16, 28)]
        : [point(10, 16), point(16, 4), point(28, 4), point(16, 28)];
      const lines: DrawBatch = { primitive: "lines", lineWidth: 1, texturing: "single", texture: { kind: "bind-image", image },
        vertices: perimeter.map(position => ({ position, color: white, texCoord: { x: 0.5, y: 0.5 } })),
        indices: perimeter.flatMap((_position, index) => [index, (index + 1) % perimeter.length]), state: { ...opaque, depthRange: [0, 0] } };
      executeStaticBatch(cpu, lines); expect(cpu.pixels).toEqual(actual);
    }
  }));

  test("a portal-created outline survives rounding outside its already-applied clip plane", () => fixture(({ cpu, image }) => {
    reset(cpu, 0.1, { x: 1, y: 0, z: 0, w: 0.1 });
    const positions = [point(0, 28), point(32, 28), point(32, 4)];
    drawTris(cpu, { allocation: { kind: "standalone" }, whiteImage: image, positions, indices: [0, 1, 2], scratch: positions.map(() => cell()) }, 1);
    const actual = pixel(cpu, 14, 24);
    reset(cpu);
    const perimeter: readonly Vec4[] = [
      { x: -0.1, y: -0.075, z: 0, w: 1 }, { x: -0.1, y: -0.75, z: 0, w: 1 },
      { x: 1, y: -0.75, z: 0, w: 1 }, { x: 1, y: 0.75, z: 0, w: 1 },
    ];
    executeStaticBatch(cpu, { primitive: "lines", texturing: "single", lineWidth: 1,
      texture: { kind: "bind-image", image }, state: { ...opaque, depthRange: [0, 0] },
      vertices: perimeter.map(position => ({ position, color: white, texCoord: { x: 0, y: 0 } })),
      indices: [0, 1, 1, 2, 2, 3, 3, 0] });
    expect(pixel(cpu, 14, 24)).toEqual([255, 255, 255, 255]);
    expect(actual).toEqual([255, 255, 255, 255]);
  }));

  test("normal segments retain the current line width and ordinary line cleanup restores one", () => fixture(({ cpu, image }) => {
    const retained = cpu.prepareGeometry({ primitive: "lines", lineWidth: 5, texturing: "single", vertices: [], indices: [], texture: { kind: "bind-image", image }, state: opaque });
    retained.begin(); retained.applyTexture(0, { kind: "bind-image", image }); normal(cpu, image, 12);
    for (const y of [10, 11, 12, 13, 14]) expect(pixel(cpu, 16, y)).toEqual([255, 255, 255, 255]);
    expect(pixel(cpu, 16, 9)).toEqual([0, 0, 0, 255]);
    drawTris(cpu, triangle(image), 1);
    for (const y of [2, 3, 4, 5, 6]) expect(pixel(cpu, 16, y)).toEqual([255, 255, 255, 255]);
    retained.draw(); retained.cleanup(); reset(cpu); normal(cpu, image, 22);
    expect(pixel(cpu, 16, 22)).toEqual([255, 255, 255, 255]);
    for (const y of [21, 23]) expect(pixel(cpu, 16, y)).toEqual([0, 0, 0, 255]);
  }));

  test("array debug keeps disabled primary UV and color while discrete debug emits svars values", () => {
    for (const mode of [1, 2, 3]) fixture(({ cpu, image, palette, images, cvars }) => {
      executeSource(cpu, source(image, [0, 0, 0]), 1);
      images.setDlightImage(palette); cvars.set("r_nobind", "1");
      const input = triangle(image), scratch = input.scratch.map(() => cell(0.25, 0.75, { x: 128 / 255, y: 64 / 255, z: 1, w: 1 }));
      drawTris(cpu, { ...input, scratch }, mode);
      expect(pixel(cpu, 16, 4)).toEqual(mode === 3 ? [16, 24, 160, 255] : [208, 176, 144, 255]);
      normal(cpu, image);
      expect(pixel(cpu, 16, 16)).toEqual(mode === 3 ? [32, 96, 160, 255] : [208, 176, 144, 255]);
    });
  });

  test("retained generic-pair UV1 reads the matching sparse debug scratch slots", () => {
    for (const mode of [0, 1, 2, 3]) fixture(({ cpu, image, palette }) => {
      executeSource(cpu, { ...paired(image, palette), batch: { ...paired(image, palette).batch, indices: [0, 0, 0] } });
      const input = triangle(image), unused = point(Number.NaN, 0);
      const positions = [unused, input.positions[0], unused, input.positions[1], unused, input.positions[2]];
      if (positions.some(position => position === undefined)) throw new Error("Triangle fixture is incomplete");
      const complete: Vec4[] = [];
      for (const position of positions) { if (position === undefined) throw new Error("Missing fixture position"); complete.push(position); }
      const scratch = complete.map(() => cell(0.75, 0.25));
      drawTris(cpu, { allocation: { kind: "standalone" }, whiteImage: image, positions: complete, indices: [1, 3, 5], scratch }, mode);
      const probe = cpu.prepareSourceGeometry(paired(image, palette));
      probe.begin(); probe.prepareTexture(0); probe.applyTexture(0, { kind: "bind-image", image });
      probe.prepareTexture(1); probe.applyTexture(1, { kind: "bind-image", image: palette }); probe.finishTextures();
      if (mode === 2) expect(() => normal(cpu, palette)).toThrow("unit 1 has source-indeterminate coordinates");
      else { normal(cpu, palette); expect(pixel(cpu, 16, 16)).toEqual(mode === 3 ? [208, 176, 144, 255] : [32, 96, 160, 255]); }
      probe.draw(-1); probe.cleanup();
    });
  });

  test("debug binds on retained unit one, leaves its environment, and disables only that unit's client array", () => {
    for (const mode of [1, 2]) fixture(({ cpu, image, palette }) => {
      const stage = paired(palette, image);
      cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: stage.scratch });
      const pending = cpu.prepareSourceGeometry(stage);
      pending.begin(); pending.prepareTexture(0); pending.applyTexture(0, { kind: "bind-image", image: palette });
      pending.prepareTexture(1); pending.applyTexture(1, { kind: "bind-image", image }); pending.finishTextures();
      drawTris(cpu, triangle(image), mode);
      expect(pixel(cpu, 16, 4)).toEqual([208, 176, 144, 255]);
      pending.draw(-1); pending.cleanup();
    });
  });

  test("retained nonzero unit rejects discrete targets only at the reached nonempty draw", () => fixture(({ cpu, image }) => {
    const stage = paired(image, image);
    cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: stage.scratch });
    const pending = cpu.prepareSourceGeometry(stage);
    pending.begin(); pending.prepareTexture(0); pending.applyTexture(0, { kind: "bind-image", image });
    pending.prepareTexture(1); pending.applyTexture(1, { kind: "bind-image", image }); pending.finishTextures();
    drawTris(cpu, { ...triangle(image), indices: [] }, 3);
    const debug = cpu.prepareDebugTris(triangle(image)); debug.begin();
    expect(() => debug.draw(3)).toThrow("Unsupported source R_ArrayElementDiscrete multitexture targets 0 and 1");
    expect(() => debug.cleanup()).toThrow("have not completed");
    pending.draw(-1); pending.cleanup();
  }));

  test("coordinate-dependent r_nobind retains source-indeterminate rejection while empty calls still complete", () => fixture(({ cpu, image, palette, images, cvars }) => {
    executeSource(cpu, source(image, [0, 0, 0]), 2);
    drawTris(cpu, triangle(image), 2); normal(cpu, image);
    images.setDlightImage(palette); cvars.set("r_nobind", "1");
    drawTris(cpu, { ...triangle(image), indices: [] }, 2);
    cpu.drawDebugNormals({ whiteImage: image, segments: [] });
    expect(() => drawTris(cpu, triangle(image), 2)).toThrow("unit 0 has source-indeterminate coordinates");
    expect(() => normal(cpu, image)).toThrow("unit 0 has source-indeterminate coordinates");
  }));

  test("source stages inherit the executing depth range after debug and direct batches keep their explicit range", () => fixture(({ cpu, image }) => {
    const stage = source(image, [0, 1, 2], { ...opaque, depthRange: [0, 0.3] });
    const nearStage = { ...stage, batch: { ...stage.batch, vertices: stage.batch.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z: 0 } })) } };
    reset(cpu, 0.2); cpu.drawImmediate({ kind: "depth-range", range: [0, 0.3] }); executeSource(cpu, nearStage);
    expect(pixel(cpu, 16, 12)).toEqual([255, 255, 255, 255]);
    reset(cpu, 0.2);
    cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: true, scratch: nearStage.scratch });
    const pending = cpu.prepareSourceGeometry(nearStage);
    drawTris(cpu, { ...triangle(image), indices: [] }, 1);
    pending.begin(); pending.prepareTexture(0); pending.applyTexture(0, { kind: "bind-image", image });
    pending.finishTextures(); pending.draw(1); pending.cleanup();
    expect(pixel(cpu, 16, 12)).toEqual([0, 0, 0, 255]);
    executeStaticBatch(cpu, nearStage.batch); expect(pixel(cpu, 16, 12)).toEqual([255, 255, 255, 255]);
  }));

  test("source shadow volumes consume the retained depth range and their ordinary state restores fill", () => fixture(({ cpu, image }) => {
    for (const afterDebug of [false, true]) {
      reset(cpu, 0.2);
      executeStaticBatch(cpu, { ...source(image).batch, state: { ...opaque, depthTest: "always", depthWrite: false } });
      if (!afterDebug) drawTris(cpu, { ...triangle(image), indices: [] }, 1);
      cpu.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
      if (afterDebug) drawTris(cpu, { ...triangle(image), indices: [] }, 1);
      cpu.drawImmediate({ kind: "shadow-volume", whiteImage: image, positions: [point(4, 4), point(28, 4), point(16, 28)], indices: [0, 2, 1], mirror: false });
      cpu.drawImmediate({ kind: "shadow-finish", whiteImage: image, positions: [point(0, 0, -1), point(32, 0, -1), point(32, 32, -1), point(0, 32, -1)] });
      expect(pixel(cpu, 16, 12)).toEqual(afterDebug ? [255, 255, 255, 255] : [153, 153, 153, 255]);
    }
  }, 8));

  test("state-only cull, depth and offset preserve line mode until an ordinary state call restores fill", () => fixture(({ cpu, image }) => {
    const pending = cpu.prepareGeometry(source(image, [0, 1, 2], { ...opaque, depthRange: [0, 0] }).batch);
    pending.begin(); pending.applyTexture(0, { kind: "bind-image", image });
    drawTris(cpu, { ...triangle(image), indices: [] }, 1);
    cpu.drawImmediate({ kind: "cull", cull: "none" }); cpu.drawImmediate({ kind: "depth-range", range: [0, 0] });
    cpu.drawImmediate({ kind: "polygon-offset", value: { factor: 1, units: 1 } });
    // This already-begun draw issues no later GL_State; its polygons stay lines.
    pending.draw(); pending.cleanup();
    expect(pixel(cpu, 16, 4)).toEqual([255, 255, 255, 255]);
    expect(pixel(cpu, 16, 12)).toEqual([0, 0, 0, 255]);
    const next = source(image, [0, 1, 2], { ...opaque, depthRange: [0, 0] });
    executeStaticBatch(cpu, next.batch); expect(pixel(cpu, 16, 12)).toEqual([255, 255, 255, 255]);
  }));

  test("unreached debug input is not validated, but reached discrete data and normal endpoints are", () => fixture(({ cpu, image }) => {
    const invalid = { ...triangle(image), positions: [point(Number.NaN, 0)], indices: [999], scratch: [cell(Number.NaN, Number.NaN, { x: Number.NaN, y: 0, z: 0, w: 1 })] };
    for (const mode of [-1, 7]) drawTris(cpu, invalid, mode);
    for (const mode of [0, 1, 2, 3]) drawTris(cpu, { ...invalid, indices: [] }, mode);
    for (const mode of [0, 1, 2]) drawTris(cpu, { ...triangle(image), scratch: invalid.scratch }, mode);
    expect(() => drawTris(cpu, { ...triangle(image), scratch: invalid.scratch }, 3)).toThrow("color must be finite");
    expect(() => cpu.drawDebugNormals({ whiteImage: image, segments: [[point(4, 20), point(Number.NaN, 20)]] })).toThrow("normal positions must be finite");
  }));

  test("prepared debug data is detached and phase misuse cannot repeat its side effects", () => fixture(({ cpu, image }) => {
    const input = triangle(image), positions = input.positions.map(position => ({ ...position })), indices = [...input.indices];
    const scratch = input.scratch.map(value => ({ color: { ...value.color }, texCoord: { ...value.texCoord }, texCoord2: { ...value.texCoord2 },
      rawTexCoord: { ...value.rawTexCoord }, rawTexCoord2: { ...value.rawTexCoord2 } }));
    const pending = cpu.prepareDebugTris({ ...input, positions, indices, scratch });
    for (const position of positions) position.x = Number.NaN;
    for (const value of scratch) value.color.x = 0;
    indices.fill(999);
    expect(() => pending.draw(3)).toThrow("not ready"); expect(() => pending.cleanup()).toThrow("not completed");
    pending.begin(); expect(() => pending.begin()).toThrow("already begun"); pending.draw(3);
    expect(pixel(cpu, 16, 4)).toEqual([255, 255, 255, 255]);
    expect(() => pending.draw(1)).toThrow("not ready"); pending.cleanup(); expect(() => pending.cleanup()).toThrow("not completed");
    const retired = cpu.prepareDebugTris(input); cpu.close(); expect(() => retired.begin()).toThrow("closed");
  }));

  test("a later rejected debug triangle keeps prior fragments and the reached zero depth state", () => fixture(({ cpu, image }) => {
    const input = triangle(image), pending = cpu.prepareDebugTris({ ...input, positions: [...input.positions, point(Number.NaN, 20)], indices: [0, 1, 2, 0, 1, 3] });
    pending.begin(); expect(() => pending.draw(1)).toThrow("positions must be finite");
    expect(pixel(cpu, 16, 4)).toEqual([255, 255, 255, 255]); expect(() => pending.cleanup()).toThrow("not completed");
    executeSource(cpu, source(image)); expect(pixel(cpu, 16, 12)).toEqual([255, 255, 255, 255]);
  }));
});

describe("CPU source R_DebugPolygon and R_DebugGraphics", () => {
  const positions = [point(4, 4, 0.75), point(28, 4, 0.75), point(28, 28, 0.75), point(4, 28, 0.75)];

  test("RGB bits add over the framebuffer, the perimeter has no fan spokes, and both passes write their source depth", () => {
    for (const color of [0, 1, 2, 4, 7, -1]) fixture(({ cpu, image, palette }) => {
      cpu.beginView({ viewport, clear: { color: { x: 32 / 255, y: 48 / 255, z: 64 / 255, w: 1 }, depth: 0.3, stencil: false } });
      executeSource(cpu, source(palette, [], { ...opaque, blend: { source: "zero", destination: "zero" },
        depthTest: "equal", depthWrite: false, alphaTest: "lt128" }));
      cpu.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
      cpu.drawImmediate({ kind: "begin-debug-surface", whiteImage: image, cull: "none" });
      cpu.drawImmediate({ kind: "debug-polygon", color, positions });
      const shade = [color & 1 ? 255 : 32, color & 2 ? 255 : 48, color & 4 ? 255 : 64, 255];
      expect(pixel(cpu, 16, 16)).toEqual(shade);
      expect(pixel(cpu, 16, 4)).toEqual([255, 255, 255, 255]);
      const stage = source(image);
      executeSource(cpu, { ...stage, batch: { ...stage.batch, vertices: stage.batch.vertices.map(vertex => ({ ...vertex,
        position: { ...vertex.position, z: -0.44 }, color: { x: 0, y: 0, z: 1, w: 1 } })) } });
      // The later depth is 0.28. Fill wrote 0.2625; outline wrote zero.
      expect(pixel(cpu, 16, 16)).toEqual(shade);
      expect(pixel(cpu, 16, 4)).toEqual([255, 255, 255, 255]);
    });
  });

  test("physical culling and near or portal clipping preserve only the convex polygon perimeter", () => {
    for (const portal of [false, true]) for (const cull of ["front", "back"] satisfies readonly RenderState["cull"][]) fixture(({ cpu, image }) => {
      reset(cpu, 1, portal ? { x: 1, y: 0, z: 0, w: -0.25 } : undefined);
      cpu.drawImmediate({ kind: "begin-debug-surface", whiteImage: image, cull });
      cpu.drawImmediate({ kind: "debug-polygon", color: 0, positions: [point(4, 4, -2), point(28, 4), point(28, 28), point(4, 28, -2)] });
      const actual = cpu.pixels.slice();
      reset(cpu);
      if (cull === "front") {
        const left = portal ? 20 : 16, perimeter = [point(left, 4), point(28, 4), point(28, 28), point(left, 28)];
        executeStaticBatch(cpu, { primitive: "lines", texturing: "single", lineWidth: 1, texture: { kind: "bind-image", image },
          vertices: perimeter.map(position => ({ position, color: white, texCoord: { x: 0, y: 0 } })),
          indices: [0, 1, 1, 2, 2, 3, 3, 0], state: { ...opaque, depthRange: [0, 0] } });
      }
      expect(cpu.pixels).toEqual(actual);
    });
  });

  test("the initial white bind uses the retained unit and texture environment, and r_nobind samples the retained UV", () => fixture(({ cpu, image, palette, images, cvars }) => {
    reset(cpu, 1);
    executeSource(cpu, source(palette, [0, 0, 0]));
    const stage = paired(palette, palette);
    cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: stage.scratch });
    const pending = cpu.prepareSourceGeometry({ ...stage,
      batch: { ...stage.batch, secondTexture: { ...stage.batch.secondTexture, environment: "replace" } } });
    pending.begin(); pending.prepareTexture(0); pending.applyTexture(0, { kind: "bind-image", image: palette });
    pending.prepareTexture(1); pending.applyTexture(1, { kind: "bind-image", image: palette }); pending.finishTextures();
    cpu.drawImmediate({ kind: "begin-debug-surface", whiteImage: image, cull: "none" });
    cpu.drawImmediate({ kind: "debug-polygon", color: 2, positions });
    expect(pixel(cpu, 16, 16)).toEqual([255, 255, 255, 255]);
    pending.draw(-1); pending.cleanup();
    reset(cpu, 1); images.setDlightImage(palette); cvars.set("r_nobind", "1");
    cpu.drawImmediate({ kind: "begin-debug-surface", whiteImage: image, cull: "none" });
    cpu.drawImmediate({ kind: "debug-polygon", color: 1, positions });
    expect(pixel(cpu, 16, 16)).toEqual([208, 0, 0, 255]);
    expect(pixel(cpu, 16, 4)).toEqual([255, 176, 144, 255]);
  }));

  test("indeterminate UVs permit uniform white but reject coordinate-dependent polygons only when they have enough vertices", () => fixture(({ cpu, image, palette, images, cvars }) => {
    reset(cpu, 1); executeSource(cpu, source(image, [0, 0, 0]), 2);
    cpu.drawImmediate({ kind: "begin-debug-surface", whiteImage: image, cull: "none" });
    cpu.drawImmediate({ kind: "debug-polygon", color: 4, positions });
    expect(pixel(cpu, 16, 16)).toEqual([0, 0, 255, 255]);
    images.setDlightImage(palette); cvars.set("r_nobind", "1");
    cpu.drawImmediate({ kind: "begin-debug-surface", whiteImage: image, cull: "none" });
    for (const count of [0, 1, 2]) cpu.drawImmediate({ kind: "debug-polygon", color: 5, positions: positions.slice(0, count) });
    expect(() => cpu.drawImmediate({ kind: "debug-polygon", color: 5, positions })).toThrow("unit 0 has source-indeterminate coordinates");
  }));
});
