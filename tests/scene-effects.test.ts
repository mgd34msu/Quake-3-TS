import { describe, expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import { add3, anglesToAxis, cross3, dot3, scale3, sub3 } from "../src/core/math.ts";
import type { Axis } from "../src/core/math.ts";
import { deformGeometry, RendererNoise } from "../src/render/deform.ts";
import type { DeformGeometry } from "../src/render/deform.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { copyRefdef, createRefdef } from "../src/render/refdef.ts";
import type { RenderText } from "../src/render/refdef.ts";
import { cloudTexCoord, SkyBuilder, SKY_FACE_SUFFIXES, skyVector } from "../src/render/sky.ts";

function vertex(x: number, y: number, z: number): BspVertex {
  return { position: { x, y, z }, normal: { x: -1, y: 0, z: 0 }, texCoord: { x: 0.25, y: 0.75 },
    lightmapCoord: { x: 0.125, y: 0.875 }, color: { x: 40, y: 80, z: 120, w: 200 } };
}
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`missing fixture entry ${index}`);
  return value;
}
const zero = { x: 0, y: 0, z: 0 };
function tessGeometry(mesh: DeformGeometry): SourceTessState {
    const tess = new SourceTessState(); tess.replaceGeometry(mesh); return tess;
}

describe("source DeformText", () => {
  const view = { axis: anglesToAxis(zero), mirror: false, entityAxis: null, nonNormalizedAxis: null };
  const mesh: DeformGeometry = { vertices: [vertex(10, -4, -2), vertex(10, 4, -2), vertex(10, 4, 2), vertex(10, -4, 2)], indices: [0, 1, 3, 3, 1, 2] };
  function textTess(text: RenderText): SourceTessState {
    const tess = tessGeometry(mesh); tess.enterView({ origin: zero, axis: view.axis, mirror: false }, 0, { text, time: 0 }); return tess;
  }
  test("all eight retained rows select unsigned atlas bytes, both UV sets, white colors and global view normals", () => {
    const rows: RenderText = ["A", "B", "C", "D", "E", "F", "\x80", "\xff"];
    for (const [index, row] of rows.entries()) {
      const tess = textTess(rows), globalView = { ...view, axis: anglesToAxis({ x: 0, y: 90, z: 0 }), mirror: true,
        entityAxis: anglesToAxis({ x: 0, y: 45, z: 0 }), nonNormalizedAxis: anglesToAxis({ x: 0, y: 45, z: 0 })[0] };
      const result = deformGeometry(tess, [{ kind: "text", index }], globalView, 0, new RendererNoise());
      expect(result.vertices.map(value => value.position)).toEqual([{ x: 10, y: 1.5, z: 2 }, { x: 10, y: -1.5, z: 2 }, { x: 10, y: -1.5, z: -2 }, { x: 10, y: 1.5, z: -2 }]);
      const code = row.charCodeAt(0), s = (code & 15) / 16, t = (code >> 4) / 16;
      expect(result.vertices.map(value => value.texCoord)).toEqual([{ x: s, y: t }, { x: s + 1 / 16, y: t }, { x: s + 1 / 16, y: t + 1 / 16 }, { x: s, y: t + 1 / 16 }]);
      expect(result.vertices.map(value => value.lightmapCoord)).toEqual(result.vertices.map(value => value.texCoord));
      expect(result.vertices.map(value => value.normal)).toEqual(Array.from({ length: 4 }, () => sub3(zero, globalView.axis[0])));
      expect(result.vertices.every(value => value.color.x === 255 && value.color.y === 255 && value.color.z === 255 && value.color.w === 255)).toBe(true);
      expect(result.indices).toEqual([0, 1, 3, 3, 1, 2]);
      expect(tess.snapshotGeometry()).toEqual(result);
    }
  });
  test("spaces advance without emitting, NUL terminates, and other whitespace is an ordinary glyph", () => {
    const tess = textTess([" A B \0unused", "\t", "", "", "", "", "", ""]);
    const result = deformGeometry(tess, [{ kind: "text", index: 0 }], view, 0, new RendererNoise());
    expect(result.vertices.map(value => value.position.y)).toEqual([4.5, 1.5, 1.5, 4.5, -1.5, -4.5, -4.5, -1.5]);
    expect(result.indices).toEqual([0, 1, 3, 3, 1, 2, 4, 5, 7, 7, 5, 6]);
    const tab = deformGeometry(tess, [{ kind: "text", index: 1 }], view, 0, new RendererNoise());
    expect(tab.vertices).toHaveLength(4); expect(at(tab.vertices, 0).texCoord).toEqual({ x: 9 / 16, y: 0 });
  });
  test("empty deformations retain allocation slots and earlier active writes reach a later text deformation", () => {
    const tess = textTess(["", "A", "", "", "", "", "", ""]);
    tess.replaceGeometry({ vertices: mesh.vertices.slice(0, 3), indices: [0, 1, 2] });
    const noise = new RendererNoise();
    const result = deformGeometry(tess, [{ kind: "move", direction: { x: 4, y: 0, z: 0 }, wave: { kind: "sin", base: 1, amplitude: 0, phase: 0, frequency: 0 } },
      { kind: "text", index: 0 }, { kind: "text", index: 1 }], view, 0, noise);
    // Only the first three source XYZ slots move; the fourth inactive slot is still x=10.
    expect(result.vertices.map(value => value.position.x)).toEqual([13, 13, 13, 13]);
    const retained = tess.textQuad();
    expect(deformGeometry(tess, [{ kind: "text", index: 0 }], view, 0, noise)).toEqual({ vertices: [], indices: [] });
    expect(tess.numVertexes).toBe(0); expect(tess.numIndexes).toBe(0); expect(tess.textQuad()).toEqual(retained);
    expect(deformGeometry(tess, [{ kind: "text", index: 1 }], view, 0, noise)).toEqual(result);
  });
  test("maximum terminated row resets full input counts, preserves inactive tails and never needs an overflow flush", () => {
    const tess = textTess(["A".repeat(31) + "\0", "", "", "", "", "", "", ""]);
    tess.replaceGeometry({ vertices: [...mesh.vertices, ...Array.from({ length: 995 }, () => vertex(99, 98, 97))], indices: [0, 1, 2] });
    tess.writeStageColor(0, { x: 1, y: 0, z: 0, w: 1 });
    const result = deformGeometry(tess, [{ kind: "text", index: 0 }], view, 0, new RendererNoise());
    expect(result.vertices).toHaveLength(124); expect(result.indices).toHaveLength(186);
    expect(at(result.vertices, 0).position.y).toBe(46.5); expect(at(result.vertices, 123).position.y).toBe(-43.5);
    expect(tess.wouldOverflow(4, 6)).toBe(false); expect(tess.stageColor(0)).toEqual({ x: 1, y: 0, z: 0, w: 1 });
    tess.appendGeometry({ vertices: [vertex(1, 2, 3)], indices: [] }, "poly");
    expect(at(tess.snapshotGeometry().vertices, 124).lightmapCoord).toEqual({ x: 0.125, y: 0.875 });
  });
  test("midpoint accumulation stores float32 after each source VectorAdd", () => {
    const tess = textTess(["A", "", "", "", "", "", "", ""]);
    tess.replaceGeometry({ vertices: [vertex(16777216, 0, -2), vertex(1, 0, -2), vertex(-16777216, 0, 2), vertex(1, 0, 2)], indices: [0, 1, 2] });
    expect(deformGeometry(tess, [{ kind: "text", index: 0 }], view, 0, new RendererNoise()).vertices.map(value => value.position.x)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
  test("publication requires byte strings terminated within each fixed source row", () => {
    const input = createRefdef(); input.text = ["A".repeat(31), "\xff\0tail", "", "", "", "", "", ""];
    const published = copyRefdef(input); expect(published.text).toEqual(input.text); expect(published.text).not.toBe(input.text);
    input.text = ["A".repeat(32), "", "", "", "", "", "", ""];
    expect(() => copyRefdef(input)).toThrow("NUL within 32 bytes");
    input.text = ["\u0100", "", "", "", "", "", "", ""];
    expect(() => copyRefdef(input)).toThrow("byte characters");
    input.text = ["\0".repeat(33), "", "", "", "", "", "", ""];
    expect(() => copyRefdef(input)).toThrow("32 bytes");
  });
});

describe("source sky geometry", () => {
  test("cube faces preserve Quake sky image orientation", () => {
    expect(SKY_FACE_SUFFIXES).toEqual(["rt", "lf", "bk", "ft", "up", "dn"]);
    expect(skyVector(0, 0.25, -0.5, 100)).toEqual({ x: 100, y: -25, z: -50 });
    expect(skyVector(4, 0.25, -0.5, 100)).toEqual({ x: 50, y: -25, z: 100 });
    expect(skyVector(5, 0.25, -0.5, 100)).toEqual({ x: -50, y: -25, z: -100 });
  });
  test("visible portal clips and quantizes the face to quarter-unit subdivisions", () => {
    const portal: DeformGeometry = { vertices: [vertex(100, -25, -25), vertex(100, 25, -25), vertex(100, 25, 25), vertex(100, -25, 25)], indices: [0, 1, 2, 0, 2, 3] };
    const builder = new SkyBuilder(); builder.initializeCloudCoordinates(512);
    builder.clip([portal], zero);
    const geometry = builder.build(zero, 1750);
    expect(geometry.box.map(face => face.face)).toEqual([0]);
    const mesh = at(geometry.box, 0).geometry;
    expect(mesh.vertices).toHaveLength(9);
    expect(mesh.indices).toHaveLength(24);
    expect(at(mesh.vertices, 0).position).toEqual({ x: 1000, y: 250, z: -250 });
    expect(at(mesh.vertices, 0).texCoord).toEqual({ x: 0.375, y: 0.625 });
    const a = at(mesh.vertices, at(mesh.indices, 0)).position;
    const b = at(mesh.vertices, at(mesh.indices, 1)).position;
    const c = at(mesh.vertices, at(mesh.indices, 2)).position;
    expect(dot3(cross3(sub3(b, a), sub3(c, a)), { x: 1, y: 0, z: 0 })).toBeGreaterThan(0);
    const translation = { x: 23, y: -47, z: 100 };
    const movedPortal = { ...portal, vertices: portal.vertices.map(point => ({ ...point, position: add3(point.position, translation) })) };
    builder.clip([movedPortal], translation);
    const moved = builder.build(translation, 1750);
    expect(moved.clouds.vertices.map(point => point.texCoord)).toEqual(geometry.clouds.vertices.map(point => point.texCoord));
    expect(moved.clouds.vertices.map(point => sub3(point.position, translation))).toEqual(geometry.clouds.vertices.map(point => point.position));
  });
  test("a triangle across cube corners draws all affected faces and excludes bottom clouds", () => {
    const corner = { vertices: [vertex(10, 0, 0), vertex(0, 10, 0), vertex(0, 0, 10)], indices: [0, 1, 2] };
    const builder = new SkyBuilder(); builder.initializeCloudCoordinates(512);
    builder.clip([corner], zero);
    expect(builder.build(zero, 1024).box.map(face => face.face)).toEqual([0, 2, 4]);
    const bottom = { vertices: [vertex(-10, -10, -100), vertex(10, -10, -100), vertex(10, 10, -100)], indices: [0, 1, 2] };
    builder.clip([bottom], zero);
    const geometry = builder.build(zero, 1024);
    expect(geometry.box.map(face => face.face)).toEqual([5]);
    expect(geometry.clouds.vertices).toHaveLength(0);
  });
  test("cloud coordinates follow the spherical layer intersection", () => {
    const top = cloudTexCoord(4, 0, 0, 512);
    expect(top.x).toBeCloseTo(Math.PI / 2, 6);
    expect(top.y).toBeCloseTo(Math.PI / 2, 6);
    const horizon = cloudTexCoord(0, 0, 0, 512);
    const expectedX = Math.acos(Math.sqrt(4608 * 4608 - 4096 * 4096) / 4608);
    expect(horizon.x).toBeCloseTo(expectedX, 6);
    expect(horizon.y).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("world geometry deformations", () => {
  test("wave deformation stores the source position sum before selecting its table entry", () => {
    const point = { ...vertex(16777216, 1, -16777216), normal: { x: 0, y: 1, z: 0 } };
    const tess = tessGeometry({ vertices: [point], indices: [] });
    const result = deformGeometry(tess, [{ kind: "wave", spread: 1 / 1024,
      wave: { kind: "sawtooth", base: 0, amplitude: 1, phase: 0, frequency: 1 } }],
    { axis: anglesToAxis(zero), mirror: false, entityAxis: null, nonNormalizedAxis: null }, 0, new RendererNoise());
    // Binary32 loses the unit at 2^24 before the opposite Z component cancels X.
    expect(at(result.vertices, 0).position).toEqual(point.position);
  });

  test("bulge uses raw view milliseconds through shader offsets and 2D entry", () => {
    const tess = tessGeometry({ vertices: [vertex(0, 0, 0)], indices: [] });
    const view = { axis: anglesToAxis(zero), mirror: false, entityAxis: null, nonNormalizedAxis: null };
    tess.enterView({ origin: zero, axis: view.axis, mirror: false }, 7, { ...createRefdef(), time: 1000 });
    const noise = new RendererNoise();
    // RB_CalcBulgeVertexes truncates 1024 / (2*pi) to table index 162 at one second.
    const expected = -Math.fround(Math.sin(Math.fround(162 * 360 / 1023) * Math.PI / 180));
    for (const shaderTime of [0, 0.25, 7, -9]) {
      tess.replaceGeometry({ vertices: [vertex(0, 0, 0)], indices: [] });
      tess.setFloatTime(-40); tess.setShaderTime(shaderTime);
      const result = deformGeometry(tess, [{ kind: "bulge", width: 0, height: 1, speed: 1 }], view, shaderTime, noise);
      expect(at(result.vertices, 0).position.x).toBe(expected);
      expect(tess.refdefTime).toBe(1000);
    }
    tess.setGL2D(0xfffffc18);
    tess.replaceGeometry({ vertices: [vertex(0, 0, 0)], indices: [] });
    const result = deformGeometry(tess, [{ kind: "bulge", width: 0, height: 1, speed: 1 }], view, 0, noise);
    expect(tess.refdefTime).toBe(-1000);
    expect(at(result.vertices, 0).position.x).toBe(-Math.fround(Math.sin(Math.fround(862 * 360 / 1023) * Math.PI / 180)));
  });

  test("active deformations preserve retained allocation cells from an earlier source writer", () => {
    const tess = new SourceTessState();
    const prior = { vertices: [vertex(10, -1, -1), vertex(10, 1, -1), vertex(10, 1, 1), vertex(10, -1, 1)], indices: [0, 1, 3, 3, 1, 2] };
    tess.appendGeometry(prior, "stamp"); tess.resetGeometry();
    tess.appendGeometry({ vertices: prior.vertices.slice(0, 3), indices: [0, 1, 2] }, "md3");
    const result = deformGeometry(tess, [{ kind: "move", direction: { x: 4, y: 0, z: 0 },
      wave: { kind: "sin", base: 1, amplitude: 0, phase: 0, frequency: 0 } }],
    { axis: anglesToAxis(zero), mirror: false, entityAxis: null, nonNormalizedAxis: null }, 0, new RendererNoise());
    expect(result.vertices.map(point => point.position.x)).toEqual([14, 14, 14]);
    expect(tess.numVertexes).toBe(3); expect(tess.allocatedVertex(3)).toEqual(at(prior.vertices, 3));
  });

  test("projectionshadow uses the ground plane, clamps shallow light and preserves other attributes", () => {
    const axis = anglesToAxis(zero), view = { axis, mirror: false, entityAxis: axis, nonNormalizedAxis: null };
    const mesh = { vertices: [vertex(3, 4, 5), vertex(-2, 7, -12)], indices: [0, 1, 0] };
    const context = { axis, origin: { x: 100, y: -20, z: 20 }, shadowPlane: 10, lightDir: { x: 0.5, y: 0.25, z: 1 } };
    const noise = new RendererNoise();
    const projected = deformGeometry(tessGeometry(mesh), [{ kind: "projectionshadow" }], view, 0, noise, context);
    expect(projected.vertices.map(value => value.position)).toEqual([{ x: -4.5, y: 0.25, z: -10 }, { x: -1, y: 7.5, z: -10 }]);
    for (const lightDir of [{ x: 0.5, y: 0.25, z: 0 }, { x: 0.5, y: 0.25, z: -1 }, { x: 0.5, y: 0.25, z: 0.5 }]) {
      const result = deformGeometry(tessGeometry(mesh), [{ kind: "projectionshadow" }], view, 0, noise, { ...context, lightDir });
      expect(at(result.vertices, 0)).toEqual({ ...at(mesh.vertices, 0), position: { x: -12, y: -3.5, z: -10 } });
      expect(result.indices).toEqual(mesh.indices);
    }
    expect(at(mesh.vertices, 0).position).toEqual({ x: 3, y: 4, z: 5 });
    expect(() => deformGeometry(tessGeometry(mesh), [{ kind: "projectionshadow" }], view, 0, noise)).toThrow("retained entity");
  });
  test("projectionshadow retains rotated and scaled entity axes and source deformation order", () => {
    const axis: Axis = [{ x: 0, y: 0, z: 2 }, { x: 0, y: 2, z: 0 }, { x: -2, y: 0, z: 0 }];
    const view = { axis, mirror: false, entityAxis: axis, nonNormalizedAxis: axis[0] };
    const mesh = { vertices: [vertex(3, 4, 5)], indices: [] };
    const context = { axis, origin: { x: 100, y: 200, z: 30 }, shadowPlane: 10, lightDir: { x: 0, y: 1, z: 0 } };
    const projected = deformGeometry(tessGeometry(mesh), [{ kind: "projectionshadow" }, { kind: "move", direction: { x: 0, y: 0, z: 1 },
      wave: { kind: "sin", base: 2, amplitude: 0, phase: 0, frequency: 0 } }], view, 0, new RendererNoise(), context);
    expect(at(projected.vertices, 0).position).toEqual({ x: -10, y: -9, z: 7 });
  });
  test("autosprite rebuilds camera-facing quads and both UV sets without mutating input", () => {
    const mesh = { vertices: [vertex(0, 1, 1), vertex(0, -1, 1), vertex(0, -1, -1), vertex(0, 1, -1)], indices: [0, 1, 3, 3, 1, 2] };
    const original = structuredClone(mesh), noise = new RendererNoise();
    const front = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite" }], { axis: anglesToAxis(zero), mirror: false, entityAxis: null, nonNormalizedAxis: null }, 0, noise);
    const side = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite" }], { axis: anglesToAxis({ x: 0, y: 90, z: 0 }), mirror: false, entityAxis: null, nonNormalizedAxis: null }, 0, noise);
    const radius = Math.sqrt(2) * 0.707;
    expect(at(front.vertices, 0).position.y).toBeCloseTo(radius, 6);
    expect(at(front.vertices, 0).normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(at(side.vertices, 0).position.x).toBeCloseTo(-radius, 6);
    expect(at(side.vertices, 0).normal.y).toBeCloseTo(-1);
    expect(front.vertices.map(point => point.texCoord)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    expect(front.vertices.map(point => point.lightmapCoord)).toEqual(front.vertices.map(point => point.texCoord));
    expect(mesh).toEqual(original);
  });
  test("autosprite2 keeps the long axis and pivots the short edges using source index direction", () => {
    const mesh = { vertices: [vertex(0, -1, -4), vertex(0, 1, -4), vertex(0, 1, 4), vertex(0, -1, 4)], indices: [0, 1, 3, 3, 1, 2] };
    const result = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite2" }], { axis: anglesToAxis({ x: 0, y: 90, z: 0 }), mirror: false, entityAxis: null, nonNormalizedAxis: null }, 0, new RendererNoise());
    for (const point of result.vertices) {
      expect(Math.abs(point.position.x)).toBeCloseTo(1);
      expect(point.position.y).toBeCloseTo(0);
      expect(Math.abs(point.position.z)).toBe(4);
      expect(point.texCoord).toEqual({ x: 0.25, y: 0.75 });
    }
    expect(at(result.vertices, 0).position.x).toBeCloseTo(1);
    expect(result.indices).toEqual(mesh.indices);
  });
  test("Linux seed noise matches independently captured libc lattice fixtures", () => {
    const noise = new RendererNoise();
    // Captured from host libc.so.6 srand(1001)/512 rand calls, then source INDEX lookup.
    expect(noise.sample(0, 0, 0, 0)).toBe(0.16365182399749756);
    expect(noise.sample(1, 2, 3, 4)).toBe(-0.013080060482025146);
    expect(noise.sample(256, 256, 256, 256)).toBe(noise.sample(0, 0, 0, 0));
    const average = Math.fround(Math.fround(noise.sample(0, 0, 0, 0) * 0.5) + Math.fround(noise.sample(1, 0, 0, 0) * 0.5));
    expect(noise.sample(0.5, 0, 0, 0)).toBe(average);
  });
  test("normal noise changes normals before subsequent wave displacement", () => {
    const mesh = { vertices: [vertex(0, 0, 0)], indices: [] };
    const noise = new RendererNoise();
    const result = deformGeometry(tessGeometry(mesh), [{ kind: "normal", amplitude: 0.5, frequency: 1 },
      { kind: "wave", spread: 0, wave: { kind: "sin", base: 2, amplitude: 0, phase: 0, frequency: 0 } }],
      { axis: anglesToAxis(zero), mirror: false, entityAxis: null, nonNormalizedAxis: null }, 0, noise);
    const point = at(result.vertices, 0);
    expect(point.normal).not.toEqual(at(mesh.vertices, 0).normal);
    expect(point.position).toEqual({ x: Math.fround(point.normal.x * 2), y: Math.fround(point.normal.y * 2), z: Math.fround(point.normal.z * 2) });
    expect(Math.sqrt(dot3(point.normal, point.normal))).toBeCloseTo(1, 2);
    expect(at(mesh.vertices, 0).position).toEqual(zero);
  });
  test("entity-local autosprite preserves rotated axes, explicit scale flag, and mirror winding", () => {
    const mesh = { vertices: [vertex(0, 1, 1), vertex(0, -1, 1), vertex(0, -1, -1), vertex(0, 1, -1)], indices: [0, 1, 3, 3, 1, 2] };
    const rotation = anglesToAxis({ x: 0, y: 90, z: 0 });
    const entityAxis: Axis = [scale3(rotation[0], 2), scale3(rotation[1], 2), scale3(rotation[2], 2)];
    const view = { axis: anglesToAxis(zero), mirror: false, entityAxis, nonNormalizedAxis: entityAxis[0] };
    const noise = new RendererNoise(), scaled = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite" }], view, 0, noise);
    const radius = Math.sqrt(2) * 0.707;
    expect(at(scaled.vertices, 0).position.x).toBeCloseTo(radius, 6);
    expect(at(scaled.vertices, 0).position.y).toBeCloseTo(0, 6);
    expect(at(scaled.vertices, 0).position.z).toBeCloseTo(radius, 6);
    const unflagged = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite" }], { ...view, nonNormalizedAxis: null }, 0, noise);
    expect(at(unflagged.vertices, 0).position.x).toBeCloseTo(radius * 2, 6);
    const mirror = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite" }], { ...view, mirror: true }, 0, noise);
    expect(at(mirror.vertices, 0).position.x).toBeCloseTo(-radius, 6);
    expect(at(mirror.vertices, 0).position.z).toBeCloseTo(radius, 6);
  });
  test("autosprite scale reads the submitted axis independently of retained orientation", () => {
    const mesh = { vertices: [vertex(0, 1, 1), vertex(0, -1, 1), vertex(0, -1, -1), vertex(0, 1, -1)], indices: [0, 1, 3, 3, 1, 2] };
    const view = { axis: anglesToAxis(zero), mirror: false, entityAxis: anglesToAxis(zero), nonNormalizedAxis: { x: 0, y: 4, z: 0 } };
    const noise = new RendererNoise(), scaled = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite" }], view, 0, noise);
    const radius = Math.sqrt(2) * 0.707 / 4;
    expect(at(scaled.vertices, 0).position.x).toBe(0);
    expect(at(scaled.vertices, 0).position.y).toBeCloseTo(radius, 6);
    expect(at(scaled.vertices, 0).position.z).toBeCloseTo(radius, 6);
    const collapsed = deformGeometry(tessGeometry(mesh), [{ kind: "autosprite" }], { ...view, nonNormalizedAxis: zero }, 0, noise);
    expect(collapsed.vertices.map(vertex => vertex.position)).toEqual([zero, zero, zero, zero]);
  });
});
