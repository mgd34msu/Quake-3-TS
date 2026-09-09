import { expect, test } from "bun:test";
import { ImpactMarkSystem, type ImpactMarkRequest } from "../src/cgame/marks.ts";
import { vec3, type Vec3 } from "../src/core/math.ts";
import { BspMarkProjector, type MarkFragments, type MarkProjection } from "../src/render/marks.ts";
import type { RefPoly, SceneShader } from "../src/render/ref-entity.ts";
import { markGeometry } from "./marks-fixture.ts";

const oracle = process.env["Q3_CGAME_MARKS_ORACLE"];
function vector(point: Vec3): number[] { return [point.x, point.y, point.z]; }
function bits(value: number): number { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); }
const shaders: readonly [SceneShader, SceneShader] = [{ name: "normal" }, { name: "energy" }];
function polyLine(poly: RefPoly): string {
  const shader = shaders.findIndex(candidate => candidate === poly.shader) + 1;
  return ["P", shader, poly.vertices.length, ...poly.vertices.flatMap(vertex => [...vector(vertex.position).map(bits), bits(vertex.texCoord.x), bits(vertex.texCoord.y), vertex.color.x, vertex.color.y, vertex.color.z, vertex.color.w])].join(" ");
}
// Native and TS receive the same engine import fixture: return the requested
// polygon unchanged. Real BSP clipping has a separate native and retail gate.
class CaptureProjector extends BspMarkProjector {
  readonly lines: string[] = [];
  override markFragments(query: MarkProjection): MarkFragments {
    this.lines.push(["Q", query.points.length, ...query.points.flatMap(vector).map(bits), ...vector(query.projection).map(bits)].join(" "));
    return { points: query.points, fragments: [{ firstPoint: 0, pointCount: query.points.length }] };
  }
}
test.skipIf(oracle === undefined)("native CG_ImpactMark axes, byte colors, persistent ordering and energy/alpha/RGB fade", async () => {
  if (oracle === undefined) throw new Error("Q3_CGAME_MARKS_ORACLE required");
  const projector = new CaptureProjector(markGeometry()), clock = { time: 100, enabled: true };
  const marks = new ImpactMarkSystem(projector, { clock: () => clock.time, enabled: () => clock.enabled, energyShader: () => shaders[1] });
  const commands: string[] = [], expected = projector.lines;
  const impact = (request: ImpactMarkRequest): void => {
    commands.push([1, clock.time, shaders.findIndex(shader => shader === request.shader) + 1, ...vector(request.origin), ...vector(request.direction), request.orientation, request.color.x, request.color.y, request.color.z, request.color.w, Number(request.alphaFade), request.radius, Number(request.temporary)].join(" "));
    expected.push(...marks.impactMark(request).map(polyLine));
  };
  const add = (): void => { commands.push(`2 ${clock.time} ${Number(clock.enabled)}`); expected.push(...marks.addMarks().map(polyLine), "E"); };
  for (const direction of [vec3(0, 0, 1), vec3(0.3, -0.7, 1.25), vec3(-1, 0, 0)]) for (const orientation of [0, 17, 90, 203.125]) {
    impact({ shader: shaders[0], origin: vec3(10.25, -83.125, 40), direction, orientation, radius: 17.125, color: { x: 1, y: 0.3333, z: 0.05, w: 0.123 }, alphaFade: true, temporary: true });
  }
  for (let index = 0; index < 4; index++) impact({ shader: index % 2 === 0 ? shaders[0] : shaders[1], origin: vec3(index, 0, 1), direction: vec3(0, 0, 1), orientation: 0, radius: 8, color: { x: index === 3 ? 0 : 1, y: 0.5, z: 0.25, w: 0.5 }, alphaFade: index < 2, temporary: false });
  for (const age of [0, 1300, 1301, 2000, 3000, 8999, 9000, 9001, 9500, 10000, 10001]) { clock.time = 100 + age; add(); }
  const child = Bun.spawn([oracle], { stdin: new Blob([commands.join("\n")]), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
  const lines = output.trim().split("\n"); expect(lines).toHaveLength(expected.length);
  for (const [index, line] of lines.entries()) {
    const expectedLine = expected[index];
    if (expectedLine === undefined) throw new Error("native output has an extra line");
    expect(line, `line ${index}`).toBe(expectedLine);
  }
});
