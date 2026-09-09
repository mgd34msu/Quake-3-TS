import { describe, expect, test } from "bun:test";
import { vec4 } from "../src/core/math.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { sourceStateBits } from "../src/render/source-state.ts";
import type { SourceStateInput } from "../src/render/source-state.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { ImmediateViewOperation, RenderState, SourceGeometryAllocation, SourceStageData } from "../src/render/types.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const viewport = { x: 0, y: 0, width: 32, height: 32 };
const black = vec4(0, 0, 0, 1);
const strip = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5];
const texels = new Uint8Array([32, 96, 160, 255, 208, 176, 144, 255]);
const opaque: RenderState & SourceStateInput = { ...OPAQUE_STATE, cull: "none", depthTest: "less-equal", blend: { source: "one", destination: "zero" } };
type SingleStageKind = Extract<SourceStageData, { batch: { texturing: "single" } }>["kind"];
type PairStageKind = Extract<SourceStageData, { batch: { texturing: "pair" } }>["kind"];

function single(image: RendererImage, indices: readonly number[] = strip, kind: SingleStageKind = "generic-single", state: RenderState & SourceStateInput = opaque, depthTestEnabled = true): Extract<SourceStageData, { batch: { texturing: "single" } }> {
  const positions = [vec4(-1.2, -1, 0.1, 1), vec4(-1.2, 1, 0.2, 1), vec4(0, -1, 0, 1),
    vec4(0, 1, -0.1, 1), vec4(1.5, -1.5, 0.3, 1.5), vec4(1.5, 1.5, 0.2, 1.5)];
  const vertices = positions.map((position, index) => ({ position,
    color: vec4((index + 1) / 7, (6 - index) / 7, 0.5, 1), texCoord: { x: index % 2 === 0 ? 0.25 : 0.75, y: 0.5 } }));
  return { kind, stateBits: sourceStateBits({ ...state,
    blend: state.blend.source === "one" && state.blend.destination === "zero" ? null : state.blend }, "fill", depthTestEnabled),
    batch: { primitive: "triangles", texturing: "single", vertices, indices,
    texture: { kind: "bind-image", image }, state },
    scratch: vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: { x: 0.25, y: 0.5 },
      rawTexCoord: vertex.texCoord, rawTexCoord2: { x: 0.25, y: 0.5 } })) };
}

function pair(primary: RendererImage, secondary: RendererImage, kind: PairStageKind, indices: readonly number[] = [0, 0, 0], u = 0.75): Extract<SourceStageData, { batch: { texturing: "pair" } }> {
  const stage = single(primary, indices);
  return { kind, stateBits: stage.stateBits, batch: { ...stage.batch, texturing: "pair", vertices: stage.batch.vertices.map(vertex => ({ ...vertex, texCoord2: { x: u, y: 0.5 } })),
    secondTexture: { binding: { kind: "bind-image", image: secondary }, environment: "replace" } },
    scratch: stage.scratch.map(cell => ({ ...cell, texCoord2: { x: u, y: 0.5 }, rawTexCoord2: { x: u, y: 0.5 } })) };
}

function beginIterator(cpu: SoftwareRenderer, stage: SourceStageData): void {
  if (stage.kind === "generic-single" || stage.kind === "generic-pair") cpu.drawImmediate({ kind: "begin-generic-iterator",
    setArraysOnce: stage.kind === "generic-single", scratch: stage.scratch });
}

function execute(cpu: SoftwareRenderer, stage: SourceStageData, mode: number,
  allocation: SourceGeometryAllocation = { kind: "standalone" }): void {
  const first = stage.batch.texture, second = stage.batch.texturing === "pair" ? stage.batch.secondTexture.binding : null;
  if (first.kind === "shader-cinematic" || second?.kind === "shader-cinematic") throw new Error("Static source fixture requires static bindings");
  cpu.drawImmediate({ kind: "cull", cull: stage.batch.state.cull });
  beginIterator(cpu, stage);
  const prepared = cpu.prepareSourceGeometry(stage, allocation);
  prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, first);
  if (second !== null) { prepared.prepareTexture(1); prepared.applyTexture(1, second); }
  prepared.finishTextures(); prepared.draw(mode); prepared.cleanup();
}

function reset(cpu: SoftwareRenderer): void { cpu.beginView({ viewport, clear: { color: black, depth: 1, stencil: false } }); }
function pixel(cpu: SoftwareRenderer): number[] { return [...cpu.pixels.subarray((8 * 32 + 16) * 4, (8 * 32 + 16) * 4 + 4)]; }
function axis(image: RendererImage): Extract<ImmediateViewOperation, { kind: "entity-axis" }> {
  return { kind: "entity-axis", whiteImage: image, positions: [vec4(-0.75, 0.5, -0.5, 1), vec4(0.75, 0.5, -0.5, 1),
    vec4(-0.75, 0, -0.5, 1), vec4(0.75, 0, -0.5, 1), vec4(-0.75, -0.5, -0.5, 1), vec4(0.75, -0.5, -0.5, 1)] };
}

interface Fixture { readonly cpu: SoftwareRenderer; readonly whiteImage: RendererImage; readonly palette: RendererImage }
function fixture(action: (value: Fixture) => void): void {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(32, 32, images), target = new RenderTarget(images, [cpu]);
  try {
    const texture = (name: string, pixels: Uint8Array): RendererImage => publishTexture(images, { name, width: pixels.length / 4, height: 1,
      pixels, internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const whiteImage = texture("white", new Uint8Array([255, 255, 255, 255])), palette = texture("nonuniform", texels);
    texture("registration sentinel", new Uint8Array([255, 255, 255, 255]));
    reset(cpu); action({ cpu, whiteImage, palette });
  } finally { target.close(); }
}

function secondaryRead({ cpu, whiteImage, palette }: Fixture): void {
  reset(cpu);
  const stage = pair(whiteImage, palette, "generic-pair", []);
  beginIterator(cpu, stage);
  const probe = cpu.prepareSourceGeometry(stage);
  probe.begin(); probe.prepareTexture(0); probe.applyTexture(0, { kind: "bind-image", image: whiteImage });
  probe.prepareTexture(1); probe.applyTexture(1, { kind: "bind-image", image: palette }); probe.finishTextures();
  try { cpu.drawImmediate(axis(palette)); }
  finally { probe.draw(-1); probe.cleanup(); }
}

describe("CPU source primitive geometry", () => {
  test("tess allocation and compiled-array markers preserve CPU stage pixels", () => fixture(({ cpu, whiteImage, palette }) => {
    const stages: readonly SourceStageData[] = [
      single(palette), single(palette, strip, "vertex-lit"), single(palette, strip, "dlight"), single(palette, strip, "fog"),
      pair(whiteImage, palette, "generic-pair", strip), pair(whiteImage, palette, "lightmapped-pair", strip),
    ];
    const allocation: SourceGeometryAllocation = { kind: "tess", slots: [0, 3, 4, 9, 10, 15], vertexCount: 16 };
    for (const stage of stages) for (const mode of stage.batch.texturing === "pair" ? [0, 1, 2] : [0, 1, 2, 3]) {
      reset(cpu); execute(cpu, stage, mode); const expected = cpu.pixels.slice();
      reset(cpu);
      cpu.drawImmediate({ kind: "begin-source-arrays", positions: stage.batch.vertices.map(vertex => vertex.position),
        slots: allocation.slots, vertexCount: allocation.vertexCount });
      execute(cpu, stage, mode, allocation);
      cpu.drawImmediate({ kind: "end-source-arrays" });
      expect(cpu.pixels).toEqual(expected);
    }
  }));

  test("default and array strips preserve oriented triangles, breaks, clipping and repeated-index coverage", () => fixture(({ cpu, palette }) => {
    for (const indices of [strip, [0, 1, 2], [0, 1, 2, 0, 2, 3], [0, 1, 2, 0, 3, 4, 4, 3, 5],
      [0, 1, 2, 2, 1, 3, 0, 3, 4, 4, 3, 5], [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1]]) {
      for (const cull of ["none", "front", "back"] satisfies readonly RenderState["cull"][]) {
        // Source depth bypass disables testing; the nonwriting diagnostic draw uses GL_ALWAYS.
        const stage = single(palette, indices, "generic-single", { ...opaque, cull, depthWrite: false,
          blend: { source: "one", destination: "one" } }, false);
        reset(cpu); executeStaticBatch(cpu, { ...stage.batch, state: { ...stage.batch.state, depthTest: "always" } }); const expected = cpu.pixels.slice();
        for (const mode of [0, 1, 2]) { reset(cpu); execute(cpu, stage, mode); expect(cpu.pixels).toEqual(expected); }
      }
    }
  }));

  test("discrete vertex-lit and dlight strips consume scratch color and UV instead of fast-path arrays", () => fixture(({ cpu, palette }) => {
    for (const kind of ["vertex-lit", "dlight"] satisfies readonly SingleStageKind[]) {
      const original = single(palette, strip, kind);
      const scratch = original.scratch.map(cell => ({ ...cell, color: vec4(128 / 255, 64 / 255, 1, 1), texCoord: { x: 0.75, y: 0.5 }, texCoord2: { x: 0.25, y: 0.5 } }));
      const stage = { ...original, scratch };
      const expectedBatch = { ...original.batch, vertices: original.batch.vertices.map((vertex, index) => {
        const cell = scratch[index]; if (cell === undefined) throw new Error("Expected scratch cell");
        return { ...vertex, color: cell.color, texCoord: cell.texCoord };
      }) };
      reset(cpu); executeStaticBatch(cpu, expectedBatch); const expected = cpu.pixels.slice();
      reset(cpu); execute(cpu, stage, 1); expect(cpu.pixels).not.toEqual(expected);
      reset(cpu); execute(cpu, stage, 3); expect(cpu.pixels).toEqual(expected);
      reset(cpu); cpu.drawImmediate(axis(palette)); expect(pixel(cpu)).toEqual([208, 0, 0, 255]);
    }
  }));

  test("paired array strips and indexed modes rasterize the actual secondary array identically", () => fixture(({ cpu, whiteImage, palette }) => {
    for (const kind of ["generic-pair", "lightmapped-pair"] satisfies readonly PairStageKind[]) {
      const original = pair(whiteImage, palette, kind, strip);
      const stage = { ...original, batch: { ...original.batch, vertices: original.batch.vertices.map((vertex, index) => ({
        ...vertex, texCoord2: { x: index % 2 === 0 ? 0.25 : 0.75, y: 0.5 },
      })) }, scratch: original.scratch.map((cell, index) => ({ ...cell, rawTexCoord2: { x: index % 2 === 0 ? 0.25 : 0.75, y: 0.5 } })) };
      executeStaticBatch(cpu, stage.batch); const expected = cpu.pixels.slice();
      expect(expected.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
      for (const mode of [0, 1, 2]) { reset(cpu); execute(cpu, stage, mode); expect(cpu.pixels).toEqual(expected); }
    }
  }));

  test("culled, collinear and repeated submissions still leave the final emitted UV known", () => {
    for (const mode of [0, 1, 3]) for (const shape of ["culled", "collinear", "repeated"]) fixture(({ cpu, palette }) => {
      const original = single(palette, shape === "repeated" ? [1, 1, 1] : [0, 2, 1], "generic-single", { ...opaque, cull: "front" });
      const stage = shape === "collinear" ? { ...original, batch: { ...original.batch,
        vertices: original.batch.vertices.map(vertex => ({ ...vertex, position: vec4(vertex.position.x, 0, 0, 1) })) } } : original;
      execute(cpu, stage, mode);
      expect(cpu.pixels).toEqual(new Uint8Array(Array.from({ length: 32 * 32 }, () => [0, 0, 0, 255]).flat()));
      reset(cpu); cpu.drawImmediate(axis(palette)); expect(pixel(cpu)).toEqual([208, 0, 0, 255]);
    });
  });

  test("indexed mode and direct indexed draws leave enabled primary UV indeterminate", () => {
    for (const direct of [false, true]) fixture(({ cpu, palette }) => {
      const stage = single(palette, [1, 1, 1]);
      if (direct) executeStaticBatch(cpu, stage.batch); else execute(cpu, stage, 2);
      expect(() => cpu.drawImmediate(axis(palette))).toThrow("unit 0 has source-indeterminate coordinates");
    });
  });

  test("none modes execute preparation and binding but preserve pixels and retained coordinates", () => {
    for (const mode of [-1, 4, -2147483648]) fixture(({ cpu, palette, whiteImage }) => {
      execute(cpu, single(whiteImage, [1, 1, 1]), 1);
      const before = cpu.pixels.slice(); execute(cpu, single(palette, [0, 0, 0]), mode);
      expect(cpu.pixels).toEqual(before);
      cpu.drawImmediate(axis(palette)); expect(pixel(cpu)).toEqual([208, 0, 0, 255]);
    });
  });

  test("empty modes preserve known UVs, including the qualified zero-count indexed and paired discrete paths", () => {
    for (const mode of [0, 1, 2, 3, -1]) fixture(value => {
      const { cpu, whiteImage, palette } = value;
      execute(cpu, single(palette, [1, 1, 1]), 1);
      const empty = single(palette, []);
      execute(cpu, { ...empty, batch: { ...empty.batch, vertices: [] }, scratch: [] }, mode);
      const emptyPair = pair(whiteImage, palette, "generic-pair", []);
      execute(cpu, { ...emptyPair, batch: { ...emptyPair.batch, vertices: [] }, scratch: [] }, mode);
      reset(cpu); cpu.drawImmediate(axis(palette)); expect(pixel(cpu)).toEqual([208, 0, 0, 255]);
    });
  });

  test("nonempty paired discrete mode reaches its source-undefined error only at draw after binding", () => fixture(({ cpu, whiteImage, palette }) => {
    for (const kind of ["generic-pair", "lightmapped-pair"] satisfies readonly PairStageKind[]) {
      const stage = pair(whiteImage, palette, kind);
      beginIterator(cpu, stage);
      const prepared = cpu.prepareSourceGeometry(stage);
      expect(() => prepared.draw(3)).toThrow("unapplied texture slots");
      prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: whiteImage });
      expect(() => prepared.draw(3)).toThrow("unapplied texture slots");
      prepared.prepareTexture(1); prepared.applyTexture(1, { kind: "bind-image", image: palette }); prepared.finishTextures();
      expect(() => prepared.draw(3)).toThrow("Unsupported source R_ArrayElementDiscrete multitexture targets 0 and 1");
    }
  }));

  test("discrete elements read the retained texture unit after color and keep secondary coordinates when unit zero is selected", () => fixture(value => {
    const { cpu, whiteImage, palette } = value;
    expect(() => execute(cpu, pair(whiteImage, palette, "generic-pair"), 3)).toThrow("Unsupported source R_ArrayElementDiscrete multitexture targets 0 and 1");
    expect(() => execute(cpu, single(whiteImage, [1, 1, 1]), 3)).toThrow("Unsupported source R_ArrayElementDiscrete multitexture targets 0 and 1");
    execute(cpu, pair(whiteImage, palette, "generic-pair", []), -1);
    cpu.drawShowImage(whiteImage, { x: 0, y: 0, width: 32, height: 32 }, false);
    expect(pixel(cpu)).toEqual([73, 182, 128, 255]);

    for (const kind of ["generic-pair", "lightmapped-pair"] satisfies readonly PairStageKind[]) {
      const original = pair(whiteImage, palette, kind, strip);
      const stage = { ...original, scratch: original.scratch.map(cell => ({ ...cell, color: vec4(1, 1, 1, 1) })) };
      reset(cpu); executeStaticBatch(cpu, { ...stage.batch, vertices: stage.batch.vertices.map(vertex => ({
        ...vertex, color: vec4(1, 1, 1, 1), texCoord2: { x: 0.25, y: 0.5 },
      })) });
      const expected = cpu.pixels.slice();
      reset(cpu); execute(cpu, pair(whiteImage, palette, kind, [0, 0, 0], 0.25), 1);
      beginIterator(cpu, stage);
      const prepared = cpu.prepareSourceGeometry(stage);
      prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: whiteImage });
      prepared.prepareTexture(1); prepared.applyTexture(1, { kind: "bind-image", image: palette });
      const nested = cpu.prepareGeometry(single(whiteImage, []).batch);
      nested.begin(); nested.applyTexture(0, { kind: "bind-image", image: whiteImage }); nested.draw(); nested.cleanup();
      prepared.finishTextures(); prepared.draw(3); prepared.cleanup();
      expect(cpu.pixels).toEqual(expected);
      reset(cpu); cpu.drawImmediate(axis(palette)); expect(pixel(cpu)).toEqual([32, 96, 160, 255]);
      const following = single(whiteImage);
      reset(cpu); execute(cpu, { ...following, scratch: following.scratch.map(cell => ({ ...cell, texCoord2: { x: 0.75, y: 0.5 } })) }, 1);
      const retained = kind === "generic-pair" ? [208, 176, 144, 255] : [32, 96, 160, 255];
      expect(pixel(cpu)).toEqual(retained);
      secondaryRead(value); expect(pixel(cpu)).toEqual(retained);
    }
  }));

  test("lightmapped reached pointers distinguish raw UV1 on unit zero from retained svars UV1 on unit one", () => {
    for (const mode of [1, 2, 3]) for (const coloredSecondary of [false, true]) fixture(({ cpu, whiteImage, palette }) => {
      const secondary = coloredSecondary ? palette : whiteImage;
      execute(cpu, pair(whiteImage, secondary, "generic-pair", [0, 0, 0], 0.25), 1);
      const original = pair(palette, secondary, "lightmapped-pair", strip, 0.25);
      const stage = { ...original, batch: { ...original.batch,
        vertices: original.batch.vertices.map(vertex => ({ ...vertex, color: vec4(1, 1, 1, 1) })),
        secondTexture: { ...original.batch.secondTexture, environment: "modulate" } satisfies typeof original.batch.secondTexture },
        scratch: original.scratch.map(cell => ({ ...cell, color: vec4(1, 1, 1, 1), texCoord: { x: 0.75, y: 0.5 },
          texCoord2: { x: 0.75, y: 0.5 }, rawTexCoord: { x: 0.75, y: 0.5 }, rawTexCoord2: { x: 0.25, y: 0.5 } })) };
      const prepared = cpu.prepareSourceGeometry(stage);
      prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: palette });
      prepared.prepareTexture(1); prepared.applyTexture(1, { kind: "bind-image", image: secondary });
      const nested = cpu.prepareGeometry(single(palette, []).batch);
      nested.begin(); nested.applyTexture(0, { kind: "bind-image", image: palette }); nested.draw(); nested.cleanup();
      prepared.finishTextures(); prepared.draw(mode); prepared.cleanup();
      expect(pixel(cpu)).toEqual(coloredSecondary ? [26, 66, 90, 255] : mode === 3 ? [208, 176, 144, 255] : [32, 96, 160, 255]);
    });
  });

  test("generic iterator array setup runs once and a reached debug callback retains disabled color and coordinates", () => {
    for (const setArraysOnce of [false, true]) for (const mode of [1, 2]) fixture(({ cpu, whiteImage, palette }) => {
      execute(cpu, single(whiteImage, [1, 1, 1]), 1);
      const original = single(whiteImage), red = vec4(1, 0, 0, 1);
      const stage = { ...original, batch: { ...original.batch, vertices: original.batch.vertices.map(vertex => ({
        ...vertex, color: red, texCoord: { x: 0.25, y: 0.5 },
      })) }, scratch: original.scratch.map(cell => ({ ...cell, color: red, texCoord: { x: 0.25, y: 0.5 } })) };
      cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce, scratch: stage.scratch });
      const prepare = (image: RendererImage) => {
        const prepared = cpu.prepareSourceGeometry({ ...stage, batch: { ...stage.batch, texture: { kind: "bind-image", image } } });
        prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image });
        return prepared;
      };
      const first = prepare(whiteImage);
      const debug = cpu.prepareDebugTris({ allocation: { kind: "standalone" }, whiteImage, positions: [], indices: [], scratch: [] });
      debug.begin(); debug.draw(-1); debug.cleanup();
      first.finishTextures(); first.draw(mode); first.cleanup();
      expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
      reset(cpu);
      const second = prepare(palette);
      second.finishTextures(); second.draw(mode); second.cleanup();
      expect(pixel(cpu)).toEqual(setArraysOnce ? [208, 176, 144, 255] : [208, 0, 0, 255]);
      reset(cpu);
      const discrete = prepare(palette);
      discrete.finishTextures(); discrete.draw(3); discrete.cleanup();
      expect(pixel(cpu)).toEqual([32, 0, 0, 255]);
    });
  });
});

describe("CPU retained secondary source client array", () => {
  test("generic-pair retains enabled UV1 and a later single array strip transfers its current scratch", () => fixture(value => {
    const { cpu, whiteImage, palette } = value;
    execute(cpu, pair(whiteImage, palette, "generic-pair"), 1);
    execute(cpu, single(whiteImage, [1, 1, 1]), 1);
    secondaryRead(value); expect(pixel(cpu)).toEqual([32, 96, 160, 255]);
  }));

  test("lightmapped-pair and direct-pair cleanup disable secondary client transfer", () => {
    for (const direct of [false, true]) fixture(value => {
      const { cpu, whiteImage, palette } = value;
      execute(cpu, pair(whiteImage, palette, "generic-pair"), 1);
      if (direct) {
        // Empty direct preparation still performs its normal cleanup without retiring UV1.
        const prepared = cpu.prepareGeometry(pair(whiteImage, palette, "generic-pair", []).batch);
        prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: whiteImage });
        prepared.applyTexture(1, { kind: "bind-image", image: palette }); prepared.draw(); prepared.cleanup();
      } else execute(cpu, pair(whiteImage, palette, "lightmapped-pair"), 1);
      execute(cpu, single(whiteImage, [1, 1, 1]), 1);
      secondaryRead(value); expect(pixel(cpu)).toEqual([208, 176, 144, 255]);
    });
  });

  test("single indexed mode retires enabled UV1 but leaves disabled UV1 alone", () => {
    for (const kind of ["generic-pair", "lightmapped-pair"] satisfies readonly PairStageKind[]) fixture(value => {
      const { cpu, whiteImage, palette } = value;
      execute(cpu, pair(whiteImage, palette, kind), 1); execute(cpu, single(whiteImage, [0, 0, 0]), 2);
      if (kind === "generic-pair") expect(() => secondaryRead(value)).toThrow("unit 1 has source-indeterminate coordinates");
      else { secondaryRead(value); expect(pixel(cpu)).toEqual([208, 176, 144, 255]); }
    });
  });

  test("single discrete and direct indexed profiles leave UV1 and its enabled flag untouched", () => {
    for (const direct of [false, true]) fixture(value => {
      const { cpu, whiteImage, palette } = value;
      execute(cpu, pair(whiteImage, palette, "generic-pair"), 1);
      const stage = single(whiteImage, [0, 0, 0]);
      if (direct) executeStaticBatch(cpu, stage.batch); else execute(cpu, stage, 3);
      secondaryRead(value); expect(pixel(cpu)).toEqual([208, 176, 144, 255]);
      execute(cpu, stage, 1); secondaryRead(value); expect(pixel(cpu)).toEqual([32, 96, 160, 255]);
    });
  });

  test("prepared source scratch is detached before later caller mutations", () => fixture(value => {
    const { cpu, whiteImage, palette } = value;
    execute(cpu, pair(whiteImage, palette, "generic-pair"), 1);
    const stage = single(whiteImage, [0, 0, 0]);
    const scratch = stage.scratch.map(cell => ({ ...cell, color: { ...cell.color }, texCoord: { x: 0.75, y: 0.5 }, texCoord2: { x: 0.25, y: 0.5 },
      rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } }));
    beginIterator(cpu, { ...stage, scratch });
    const prepared = cpu.prepareSourceGeometry({ ...stage, scratch });
    for (const cell of scratch) { cell.texCoord.x = 0.25; cell.texCoord2.x = 0.75; cell.color.x = 0; }
    prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: whiteImage });
    prepared.finishTextures(); prepared.draw(1); prepared.cleanup();
    secondaryRead(value); expect(pixel(cpu)).toEqual([32, 96, 160, 255]);
  }));

  test("empty generic-pair enables the secondary client array without retiring its known value", () => fixture(value => {
    const { cpu, whiteImage, palette } = value;
    execute(cpu, pair(whiteImage, palette, "lightmapped-pair"), 1);
    const empty = pair(whiteImage, palette, "generic-pair", []);
    execute(cpu, { ...empty, batch: { ...empty.batch, vertices: [] }, scratch: [] }, 3);
    execute(cpu, single(whiteImage, [0, 0, 0]), 1);
    secondaryRead(value); expect(pixel(cpu)).toEqual([32, 96, 160, 255]);
  }));
});
