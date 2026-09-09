import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { EditField } from "../src/core/edit-field.ts";
import { encodePng } from "../src/core/png.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { screenAdjustFrom640, screenColor, screenDrawChar, screenDrawField, screenDrawNamedPic, screenDrawPic, screenDrawSmallChar, screenDrawVariableField, screenFillRect, screenStringLength } from "../src/engine/screen-draw.ts";
import type { Product } from "../src/shared/definitions.ts";
import { floatBits, screenFixture, whiteAssets } from "./engine-screen-fixture.ts";

test.skipIf(process.env["Q3_CONSOLE_ORACLE"] === undefined)("native float signed zero and integer parameter conversion remain distinct", async () => {
  const oracle = process.env["Q3_CONSOLE_ORACLE"]; if (oracle === undefined) throw new Error("Missing native console oracle");
  const native = Bun.spawnSync([oracle, "numeric"]); expect(native.exitCode).toBe(0);
  const f = await screenFixture();
  try {
    screenDrawPic(f.drawing, { x: -0, y: -0, width: 3, height: 4 }, f.drawing.pictures.console);
    screenDrawSmallChar(f.drawing, -0.5, -0.5, 65);
    const field = new EditField(); field.setText("ab"); field.cursor = 1; field.widthInChars = 4;
    screenDrawVariableField(f.drawing, field, -0.5, -0.5, 8.5, true); f.submit();
    expect(f.queue.trace).toEqual(native.stdout.toString().trimEnd().split("\n"));
  } finally { f.close(); }
});

test("engine picture helpers use actual shared registration and stretch coordinates without aspect bias", async () => {
  const f = await screenFixture(1280, 720);
  try {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(screenAdjustFrom640(f.drawing, rect)).toEqual({ x: 20, y: 30, width: 60, height: 60 });
    screenFillRect(f.drawing, rect, screenColor(1)); screenDrawPic(f.drawing, rect, f.drawing.pictures.console);
    await screenDrawNamedPic(f.drawing, rect, "later-registration");
    const output = f.queue.trace;
    const geometry = [20, 30, 60, 60].map(floatBits).join(" ");
    expect(output).toEqual([`C ${[1, 0, 0, 1].map(floatBits).join(" ")}`, `P ${geometry} 0 0 0 0 2`, "C null",
      `P ${geometry} 0 0 1065353216 1065353216 3`, `P ${geometry} 0 0 1065353216 1065353216 4`]);
    const oracle = process.env["Q3_CONSOLE_ORACLE"];
    if (oracle !== undefined) {
      const native = Bun.spawnSync([oracle, "helpers"]); expect(native.exitCode).toBe(0);
      const rows = native.stdout.toString().trimEnd().split("\n");
      expect(rows.filter(line => line.startsWith("R "))).toEqual(["R later-registration"]);
      expect(output).toEqual(rows.filter(line => !line.startsWith("R ")));
    }
    expect(f.queue.pictures.size).toBe(4); expect(f.submit().batches).toBeGreaterThan(0);
    expect(f.cpu.pixels[(31 * 1280 + 21) * 4]).toBe(255);
    await expect(screenDrawNamedPic(f.drawing, { ...rect, width: 0 }, "never")).rejects.toThrow("nonzero width");
    await expect(screenDrawNamedPic(f.drawing, { ...rect, width: 1e-48 }, "never")).rejects.toThrow("nonzero width");
  } finally { f.close(); }
});

test("named-picture await stays at actual registration and genuine zero handle uses renderer fallback", async () => {
  const source = whiteAssets(), calls: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const assets: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    list: source.list, has: path => path.startsWith("missing") ? false : source.has(path), read: source.read,
    readFileLength: path => path.startsWith("missing") ? -1 : source.readFileLength(path), readFileOptional: async path => {
    if (path.startsWith("missing")) return undefined;
    calls.push(path); if (path === "delayed.tga") await gate; return source.readFileOptional(path);
  } });
  const f = await screenFixture(32, 32, assets);
  try {
    const rect = { x: 0, y: 0, width: 640, height: 480 };
    const pending = screenDrawNamedPic(f.drawing, rect, "delayed");
    await Promise.resolve(); expect(f.queue.trace).toEqual([]); expect(calls).toContain("delayed.tga");
    if (release === undefined) throw new Error("Missing actual asset-read gate"); release(); await pending;
    expect(f.queue.trace).toHaveLength(1); f.submit();
    await screenDrawNamedPic(f.drawing, rect, "missing");
    expect(f.queue.pictures.has(f.resources.picture(null))).toBe(true); expect(f.submit().batches).toBeGreaterThan(0);
  } finally { f.close(); }
});

test("named-picture captures all four source float arguments before delayed registration", async () => {
  const source = whiteAssets(), calls: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const assets: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    list: source.list, has: source.has, read: source.read, readFileLength: source.readFileLength, readFileOptional: async path => {
    calls.push(path); if (path === "delayed.tga") await gate; return source.readFileOptional(path);
  } });
  const f = await screenFixture(640, 480, assets);
  try {
    f.drawing.pixels.setColor(null);
    const rect = { x: 10.1, y: 20.2, width: 30.3, height: 40.4 };
    const pending = screenDrawNamedPic(f.drawing, rect, "delayed");
    await Promise.resolve(); expect(calls).toContain("delayed.tga"); expect(f.queue.trace).toEqual(["C null"]);
    rect.x = 99; rect.y = 88; rect.width = 300; rect.height = 400;
    if (release === undefined) throw new Error("Missing actual asset-read gate"); release(); await pending;
    expect(f.submit().batches).toBeGreaterThan(0);
    expect(f.queue.trace).toEqual(["C null", `P ${[10.1, 20.2, 30.3, 40.4].map(floatBits).join(" ")} 0 0 1065353216 1065353216 4`]);
    expect(f.cpu.pixels[(25 * 640 + 15) * 4]).toBe(255);
    expect(f.cpu.pixels[(100 * 640 + 100) * 4]).toBe(0);
  } finally { f.close(); }
});

test("field drawing borrows its mutable scroll and rejects reached invalid native copy ranges", async () => {
  const f = await screenFixture();
  try {
    const field = new EditField(); field.setText("abcdef"); field.widthInChars = 3; field.scroll = 99; field.cursor = 6;
    screenDrawField(f.drawing, field, 1, 2, false); expect(field.scroll).toBe(4); f.submit();
    field.widthInChars = 20; field.scroll = 99; screenDrawField(f.drawing, field, 1, 2, false); expect(field.scroll).toBe(99); f.submit();
    field.widthInChars = -1; expect(() => screenDrawField(f.drawing, field, 1, 2, true)).toThrow("copy range");
    expect(() => screenStringLength("\u0100")).toThrow();
    const before = f.queue.trace.length; screenDrawChar(f.drawing, 0, -17, 16, 65); screenDrawChar(f.drawing, 0, 0, 16, 32); expect(f.queue.trace).toHaveLength(before);
  } finally { f.close(); }
});

test.skipIf(process.env["Q3_DATA"] === undefined)("retail engine console and actual keyboard edits consume one shared CPU/GL queue for both products", async () => {
  const dataPath = process.env["Q3_DATA"]; if (dataPath === undefined) throw new Error("Missing retail data path");
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const f = await screenFixture(640, 480, assets, process.env["QUAKE_GL_TEST"] === "1");
    try {
      f.state.phase = "disconnected"; f.console.rendererInitialized(640); f.console.print("Quake III Arena console\n^1red ^2green ^4blue\n");
      f.keys.setCatcher(KeyCatcher.Console); for (const character of "echo human") await f.keys.charEvent(character.charCodeAt(0));
      await f.keys.keyEvent(KeyCode.Left, true, 100); await f.keys.charEvent(33);
      expect(f.keys.consoleField.text).toBe("echo huma!n"); f.console.draw(f.drawing); expect(f.submit().batches).toBeGreaterThan(0);
      expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
      const capture = process.env["Q3_CONSOLE_CAPTURE"];
      if (capture !== undefined) await Bun.write(`${capture}.${product}.cpu.png`, encodePng(640, 480, f.cpu.pixels));
      if (f.gl !== null) {
        const pixels = f.gl.readPixels(); let max = 0, sum = 0;
        for (const [index, value] of f.cpu.pixels.entries()) { const other = pixels[index]; if (other === undefined) throw new Error("GL viewport differs"); const difference = Math.abs(value - other); max = Math.max(max, difference); sum += difference; }
        expect(max).toBeLessThanOrEqual(2); expect(sum / pixels.length).toBeLessThan(0.1);
        if (capture !== undefined) await Bun.write(`${capture}.${product}.gl.png`, encodePng(640, 480, pixels));
      }
    } finally { f.close(); }
  }
});
