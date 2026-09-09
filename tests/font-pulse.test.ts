import { expect, test } from "bun:test";
import type { Vec4 } from "../src/core/math.ts";
import { drawUiString, drawCgString, drawProportionalString, drawCgProportionalString, UI_PULSE, UI_INVERSE, UI_DROPSHADOW, UI_BLINK } from "../src/render/font.ts";
import type { LegacyFonts } from "../src/render/font.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { baseFixture } from "./base-ui-fixture.ts";

const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
function word(value: number): number {
  const data = new DataView(new ArrayBuffer(4)); data.setFloat32(0, value, true); return data.getUint32(0, true);
}
async function fixture() {
  const f = await baseFixture();
  try { await cacheMenu(f.state); } catch (error) { f.close(); throw error; }
  const fonts: LegacyFonts = { charset: f.resources.picture(f.state.media.charset), proportional: f.resources.picture(f.state.media.proportional), glow: f.resources.picture(f.state.media.glow), banner: f.resources.picture(f.state.media.banner) };
  const colors: Vec4[] = [], setColor = f.commands.setColor.bind(f.commands);
  f.commands.setColor = color => { if (color !== null) colors.push({ ...color }); return setColor(color); };
  function vertices() {
    return f.recorder.trace().flatMap(view => view.batches).flatMap(batch => [...new Set(batch.indices)].sort((a, b) => a - b).map(index => {
      const vertex = batch.vertices[index]; if (vertex === undefined) throw new Error("Font draw index has no retained vertex"); return vertex;
    }));
  }
  function lastColor(): Vec4 { const color = colors.at(-1); if (color === undefined) throw new Error("Font issued no real SetColor call"); return color; }
  return { ...f, fonts, colors, vertices, lastColor };
}

// Literal words follow inspected shipped QVM DIVI75/CVIF/SIN/MULF/ADDF,
// and UI_LerpColor with the literal binary32 .8 coefficient. Not native-C outputs.
const cases: readonly (readonly [number, number, number, number, number])[] = [
  [3566925,1065353216,255,1061997773,204],[3566999,1065353216,255,1061997773,204],
  [3566924,1061494264,196,1062769563,215],[3567000,1061499719,196,1062768472,215],
  [0,1056964608,127,1063675494,229],[74,1056964608,127,1063675494,229],
  [75,1064023378,234,1062263740,208],[76,1064023378,234,1062263740,208],
  [-74,1056964608,127,1063675494,229],[-75,1034048880,20,1065087248,250],[-76,1034048880,20,1065087248,250],
  [-3566925,855638016,0,1065353216,255],[1258291275,1038203408,28,1064983385,249],
  [-1258291275,1063504062,226,1062367604,209],[2147483647,1051532533,86,1064218702,237],[-2147483648,1059680646,168,1063132287,221],
];
for (const kind of ["ui-fixed", "ui-proportional", "cgame-proportional"]) {
  test(`${kind} pulse preserves shipped QVM words and actual indexed queue bytes`, async () => {
    const f = await fixture();
    try {
      for (const [time, pulseWord, pulseByte, fixedWord, fixedByte] of cases) {
        const start = f.vertices().length, options = { x: 19, y: 27, text: "A", color: white, style: UI_PULSE, time };
        if (kind === "ui-fixed") drawUiString(f.state.draw, f.fonts.charset, options);
        else if (kind === "ui-proportional") drawProportionalString(f.state.draw, f.fonts, options);
        else drawCgProportionalString(f.state.draw, f.fonts, options);
        f.commands.submit();
        const expectedWord = kind === "ui-fixed" ? fixedWord : pulseWord, expectedByte = kind === "ui-fixed" ? fixedByte : pulseByte;
        const vertices = f.vertices().slice(start);
        expect(vertices).toHaveLength(kind === "ui-fixed" ? 4 : 8);
        expect(vertices.slice(-4).map(vertex => vertex.color.w)).toEqual([expectedByte/255,expectedByte/255,expectedByte/255,expectedByte/255]);
        expect(word(f.lastColor().w)).toBe(expectedWord);
      }
    } finally { f.close(); }
  });
}

test("UI fixed lowlight uses float32 .8 before LerpColor and keeps shadow alpha", async () => {
  const f = await fixture();
  try {
    const color = { x: .07407407462596893, y: .14814814925193787, z: .2832244038581848, w: .29629629850387573 };
    drawUiString(f.state.draw, f.fonts.charset, { x: 19, y: 27, text: "A", color, style: UI_PULSE | UI_DROPSHADOW, time: 0 });
    f.commands.submit();
    const final = f.lastColor();
    expect(f.vertices().slice(4).map(vertex => vertex.color)).toEqual(Array.from({ length: 4 }, () => ({ x: 17/255, y: 34/255, z: 65/255, w: 68/255 })));
    expect([final.x, final.y, final.z, final.w].map(word)).toEqual([1032358025,1040746633,1048740483,1049135241]);
    expect(f.vertices().slice(0,4).map(vertex => vertex.color)).toEqual(Array.from({ length: 4 }, () => ({ x: 0, y: 0, z: 0, w: 68/255 })));
    expect(color.x).toBe(.07407407462596893);
  } finally { f.close(); }
});

test("pulse time rejects outside the source int32 domain only when consumed", async () => {
  const f = await fixture();
  try {
    for (const time of [NaN, Infinity, -Infinity, 2147483648, -2147483649, .5]) {
      const options = { x: 19, y: 27, text: "A", color: white, style: UI_PULSE, time };
      expect(() => drawUiString(f.state.draw, f.fonts.charset, options)).toThrow("signed int32");
      expect(() => drawProportionalString(f.state.draw, f.fonts, options)).toThrow("signed int32");
      expect(() => drawCgProportionalString(f.state.draw, f.fonts, options)).toThrow("signed int32");
      expect(() => drawUiString(f.state.draw, f.fonts.charset, { ...options, style: 0 })).not.toThrow();
      expect(() => drawProportionalString(f.state.draw, f.fonts, { ...options, style: UI_INVERSE | UI_PULSE })).not.toThrow();
      expect(() => drawCgProportionalString(f.state.draw, f.fonts, { ...options, style: UI_INVERSE | UI_PULSE })).not.toThrow();
    }
    f.commands.submit();
  } finally { f.close(); }
});

test("font pulse keeps escape alpha, clamps lowlight, and leaves nonpulse and CG fixed paths unchanged", async () => {
  const f = await fixture();
  try {
    drawUiString(f.state.draw, f.fonts.charset, { x: 19, y: 27, text: "A^1B", color: { x: -1, y: 2, z: .5, w: 1 }, style: UI_PULSE, time: 0 });
    f.commands.submit();
    expect(f.vertices().slice(0,4).map(vertex => vertex.color)).toEqual(Array.from({ length: 4 }, () => ({ x: 0, y: 1, z: 114/255, w: 229/255 })));
    expect(f.vertices().slice(4,8).map(vertex => vertex.color)).toEqual(Array.from({ length: 4 }, () => ({ x: 1, y: 0, z: 0, w: 229/255 })));
    const start = f.vertices().length;
    drawUiString(f.state.draw, f.fonts.charset, { x: 19, y: 27, text: "\xff", color: white, style: 0, time: 2147483648 });
    drawCgString(f.state.draw, f.fonts.charset, { x: 19, y: 27, text: "\xff", color: white, charWidth: 16, charHeight: 16, maxChars: 0, forceColor: false, shadow: false });
    drawUiString(f.state.draw, f.fonts.charset, { x: 19, y: 27, text: "A", color: white, style: UI_PULSE | UI_BLINK, time: 200 });
    f.commands.submit();
    const vertices = f.vertices().slice(start);
    expect(vertices).toHaveLength(8);
    expect(vertices[0]?.texCoord).toEqual({ x: 15/16, y: -1/16 });
    expect(vertices[4]?.texCoord).toEqual({ x: 15/16, y: 15/16 });
    expect(vertices.map(vertex => vertex.color)).toEqual(Array.from({ length: 8 }, () => white));
  } finally { f.close(); }
});
