// CPU implementation of OpenGL 2.1 sections 3.4.1 and 3.4.2.
// https://registry.khronos.org/OpenGL/specs/gl/glspec21.pdf
import type { Vec2, Vec4 } from "../../core/math.ts";
import type { MultitextureVertex } from "../types.ts";

export interface LineFragment {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly color: Vec4;
  readonly texCoord: Vec2;
  readonly texCoord2: Vec2;
  readonly texCoordDerivative: LineTextureDerivative;
  readonly texCoord2Derivative: LineTextureDerivative;
}
export interface LineTextureDerivative {
  readonly dsPerPixel: number;
  readonly dtPerPixel: number;
}
export interface LineScissor {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function interpolate(a: MultitextureVertex, b: MultitextureVertex, t: number): MultitextureVertex {
  const mix = (x: number, y: number): number => x * (1 - t) + y * t;
  const coordinate = (left: number, right: number): number => left + (right - left) * t;
  return { position: { x: mix(a.position.x, b.position.x), y: mix(a.position.y, b.position.y), z: mix(a.position.z, b.position.z), w: mix(a.position.w, b.position.w) },
    color: { x: mix(a.color.x, b.color.x), y: mix(a.color.y, b.color.y), z: mix(a.color.z, b.color.z), w: mix(a.color.w, b.color.w) },
    texCoord: { x: coordinate(a.texCoord.x, b.texCoord.x), y: coordinate(a.texCoord.y, b.texCoord.y) },
    texCoord2: { x: coordinate(a.texCoord2.x, b.texCoord2.x), y: coordinate(a.texCoord2.y, b.texCoord2.y) } };
}

function clip(a: MultitextureVertex, b: MultitextureVertex): readonly [MultitextureVertex, MultitextureVertex] | null {
  const magnitude = Math.max(Math.abs(a.position.x), Math.abs(a.position.y), Math.abs(a.position.z), Math.abs(a.position.w),
    Math.abs(b.position.x), Math.abs(b.position.y), Math.abs(b.position.z), Math.abs(b.position.w));
  if (magnitude > Number.MAX_VALUE / 4) {
    const rescale = (vertex: MultitextureVertex): MultitextureVertex => ({ ...vertex, position: { x: vertex.position.x / magnitude,
      y: vertex.position.y / magnitude, z: vertex.position.z / magnitude, w: vertex.position.w / magnitude } });
    a = rescale(a); b = rescale(b);
  }
  let begin = 0, end = 1;
  const distance = (p: Vec4): readonly number[] => [p.w + p.x, p.w - p.x, p.w + p.y, p.w - p.y, p.w + p.z, p.w - p.z];
  const da = distance(a.position), db = distance(b.position);
  for (let plane = 0; plane < 6; plane++) {
    const x = da[plane], y = db[plane];
    if (x === undefined || y === undefined) throw new Error("line clip plane missing");
    if (x < 0 && y < 0) return null;
    if ((x < 0) !== (y < 0)) {
      const scale = Math.max(Math.abs(x), Math.abs(y)), crossing = (x / scale) / (x / scale - y / scale);
      if (x < 0) begin = Math.max(begin, crossing);
      else end = Math.min(end, crossing);
    }
  }
  if (begin >= end) return null;
  const start = interpolate(a, b, begin), finish = interpolate(a, b, end);
  return start.position.w <= 0 || finish.position.w <= 0 ? null : [start, finish];
}

function exitsDiamond(ax: number, ay: number, bx: number, by: number, x: number, y: number): boolean {
  let enter = 0, exit = 1;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const a = 0.5 - sx * (ax - x) - sy * (ay - y);
    const b = 0.5 - sx * (bx - x) - sy * (by - y);
    if (a <= 0 && b <= 0) return false;
    if ((a <= 0) !== (b <= 0)) {
      const t = a / (a - b);
      if (a <= 0) enter = Math.max(enter, t);
      else exit = Math.min(exit, t);
    }
  }
  return enter < exit && exit < 1;
}

/** Diamond-exit coverage, half-open endpoints and minor-axis width replication. */
export function rasterizeAliasedLine(first: MultitextureVertex, second: MultitextureVertex, width: number, height: number,
  lineWidth: number, scissor: LineScissor, emit: (fragment: LineFragment) => void): void {
  if (scissor.minX > scissor.maxX || scissor.minY > scissor.maxY) return;
  const clipped = clip(first, second);
  if (clipped === null) return;
  const [a, b] = clipped;
  const ax = (a.position.x / a.position.w + 1) * width / 2, ay = (a.position.y / a.position.w + 1) * height / 2;
  const bx = (b.position.x / b.position.w + 1) * width / 2, by = (b.position.y / b.position.w + 1) * height / 2;
  const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return;
  const length = Math.sqrt(lengthSquared), inverseWA = 1 / a.position.w, inverseWB = 1 / b.position.w;
  const delta = { x: b.texCoord.x - a.texCoord.x, y: b.texCoord.y - a.texCoord.y };
  const delta2 = { x: b.texCoord2.x - a.texCoord2.x, y: b.texCoord2.y - a.texCoord2.y };
  const xMajor = Math.abs(dx) >= Math.abs(dy), thickness = Math.max(1, Math.floor(lineWidth + 0.5));
  const shift = (thickness - 1) / 2;
  // The spec's endpoint perturbation chooses boundary ownership consistently.
  const paX = ax - (xMajor ? 0 : shift) - 1e-5, paY = ay - (xMajor ? shift : 0) - 1e-10;
  const pbX = bx - (xMajor ? 0 : shift) - 1e-5, pbY = by - (xMajor ? shift : 0) - 1e-10;
  const majorA = xMajor ? paX : paY, majorB = xMajor ? pbX : pbY;
  const minorA = xMajor ? paY : paX, minorB = xMajor ? pbY : pbX;
  const bottom = height - 1 - scissor.maxY, top = height - 1 - scissor.minY;
  const majorMin = xMajor ? scissor.minX : bottom, majorMax = xMajor ? scissor.maxX : top;
  const minorMin = xMajor ? bottom : scissor.minX, minorMax = xMajor ? top : scissor.maxX;
  for (let major = Math.max(majorMin, Math.floor(Math.min(majorA, majorB))); major <= Math.min(majorMax, Math.floor(Math.max(majorA, majorB))); major++) {
    const fraction = (major + 0.5 - majorA) / (majorB - majorA);
    const minorCenter = Math.floor(minorA + (minorB - minorA) * fraction);
    for (let minor = minorCenter - 1; minor <= minorCenter + 1; minor++) {
      const x = xMajor ? major : minor, y = xMajor ? minor : major;
      if (!exitsDiamond(paX, paY, pbX, pbY, x + 0.5, y + 0.5)) continue;
      // Wide-line fragments replicate one base fragment, including its attributes.
      const baseX = x + (xMajor ? 0 : shift), baseY = y + (xMajor ? shift : 0);
      const t = Math.max(0, Math.min(1, ((baseX + 0.5 - ax) * dx + (baseY + 0.5 - ay) * dy) / lengthSquared));
      const inverseW = (1 - t) / a.position.w + t / b.position.w;
      const value = (left: number, right: number): number => (left * (1 - t) / a.position.w + right * t / b.position.w) / inverseW;
      const residual = { x: delta.x * t / b.position.w / inverseW, y: delta.y * t / b.position.w / inverseW };
      const residual2 = { x: delta2.x * t / b.position.w / inverseW, y: delta2.y * t / b.position.w / inverseW };
      const texCoord = { x: a.texCoord.x + residual.x, y: a.texCoord.y + residual.y };
      const texCoord2 = { x: a.texCoord2.x + residual2.x, y: a.texCoord2.y + residual2.y };
      // OpenGL 2.1 equation 3.22: differentiate the perspective quotient along
      // this clipped segment, then normalize by its window-space length.
      // Keep the first endpoint's common offset out of the quotient derivative.
      const derivative = (difference: number, quotient: number): number =>
        (difference * inverseWB - quotient * (inverseWB - inverseWA)) / inverseW / length;
      const texCoordDerivative = { dsPerPixel: derivative(delta.x, residual.x), dtPerPixel: derivative(delta.y, residual.y) };
      const texCoord2Derivative = { dsPerPixel: derivative(delta2.x, residual2.x), dtPerPixel: derivative(delta2.y, residual2.y) };
      for (let actualMinor = Math.max(minorMin, minor); actualMinor <= Math.min(minorMax, minor + thickness - 1); actualMinor++) {
        const actualX = xMajor ? major : actualMinor, actualY = xMajor ? actualMinor : major;
        emit({ x: actualX, y: height - 1 - actualY,
          depth: ((1 - t) * a.position.z / a.position.w + t * b.position.z / b.position.w) * 0.5 + 0.5,
          color: { x: value(a.color.x, b.color.x), y: value(a.color.y, b.color.y), z: value(a.color.z, b.color.z), w: value(a.color.w, b.color.w) },
          texCoord, texCoord2, texCoordDerivative, texCoord2Derivative });
      }
    }
  }
}
