import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quake3-meminfo-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, "baseq3"));
  writeFileSync(join(root, "baseq3/default.cfg"), "set fixture 1\n");
  writeFileSync(join(root, "baseq3/productid.txt"), SOURCE_PRODUCT_ID);
  const printed: string[] = [];
  const common = await CommonConsole.open({ roots: { homePath: root, dataPath: root, cdPath: null, product: "baseq3" },
    startup: new StartupCommands("+set com_hunkMegs 1"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: text => { printed.push(text); }, resolveCommand: () => undefined,
    assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined }, value => { cleanup.push(() => { value.close(); }); });
  return { root, common, printed };
}

test("meminfo registers with the hunk and reports actual source-tagged blocks and bank counters", async () => {
  const { common, printed } = await fixture();
  expect(common.commands.registeredNames()).not.toContain("meminfo");
  common.registerRuntimeCvars("fixture", async () => undefined);
  expect(common.commands.registeredNames()).toContain("meminfo");
  for (const command of ["zonelog", "hunklog", "hunksmalllog"]) expect(common.commands.registeredNames()).not.toContain(command);
  const before = common.mainZone.memoryInfo(() => {});
  common.mainZone.allocate(4, ZoneTag.General);
  common.mainZone.allocate(5, ZoneTag.Botlib);
  common.mainZone.allocate(9, ZoneTag.Renderer);
  common.hunk.accounting.reserve("fixture", "permanent", 4, "low");
  common.hunk.accounting.allocateTemp("fixture", "temp", 8);
  common.hunk.setMark();
  printed.length = 0;
  common.commands.append("meminfo\n"); await common.commands.executeAsync();
  const text = printed.join("");
  expect(text).toContain(" 1048576 bytes total hunk\n16777216 bytes total zone\n");
  expect(text).toContain("      32 low mark\n      32 low permanent\n      48 low temp\n      48 low tempHighwater\n");
  expect(text).toContain("      32 total hunk in use\n      16 unused highwater\n");
  expect(text).toContain(`${String(before.usedBytes + 96).padStart(8)} bytes in ${before.blockCount + 3} zone blocks\n`);
  expect(text).toContain("              32 bytes in dynamic botlib\n              36 bytes in dynamic renderer\n");
  expect(text).toMatch(/\d+ bytes in small Zone memory\n$/);
  expect(text).not.toContain("block:");
  printed.length = 0;
  common.commands.append("meminfo verbose\n"); await common.commands.executeAsync();
  expect(printed.some(line => /^block:zone\+0x[0-9a-f]+    size: *\d+    tag: *\d+\n$/.test(line))).toBe(true);
});

test("zone diagnostics inspect live headers, source categories and all three link warnings", () => {
  const zone = new ZoneArena(256), lines: string[] = [];
  const first = zone.allocate(4, ZoneTag.General), second = zone.allocate(4, ZoneTag.Renderer);
  expect(zone.memoryInfo(() => {})).toEqual({ usedBytes: 56, blockCount: 2, botlibBytes: 0, rendererBytes: 28 });
  const headers = new DataView(first.bytes.buffer), firstOffset = first.bytes.byteOffset - 20, secondOffset = second.bytes.byteOffset - 20;
  headers.setInt32(firstOffset, 32, true);
  headers.setUint32(secondOffset + 12, 0, true);
  headers.setInt32(firstOffset + 4, 0, true); headers.setInt32(secondOffset + 4, 0, true);
  zone.memoryInfo(text => { lines.push(text); });
  expect(lines).toEqual(["ERROR: block size does not touch the next block\n", "ERROR: next block doesn't have proper back link\n",
    "ERROR: two consecutive free blocks\n", "ERROR: two consecutive free blocks\n"]);
  zone.dispose();
});

test("verbose zone counting sees mutations made during the current block print", () => {
  const zone = new ZoneArena(256), first = zone.allocate(4, ZoneTag.General);
  zone.allocate(4, ZoneTag.Botlib);
  let released = false;
  const info = zone.memoryInfo(() => { if (!released) { released = true; zone.free(first); } }, true);
  expect(info).toEqual({ usedBytes: 28, blockCount: 1, botlibBytes: 28, rendererBytes: 0 });
  zone.dispose();
});

test("release zone logs preserve final-block exclusion and release hunk logs have no debug records", () => {
  const zone = new ZoneArena(128), lines: string[] = [];
  zone.allocate(1, ZoneTag.General);
  zone.allocate(1, ZoneTag.Botlib);
  zone.logHeap("MAIN", text => { lines.push(text); });
  expect(lines).toEqual(["\r\n================\r\nMAIN log\r\n================\r\n", "28 MAIN memory in 1 blocks\r\n", "8 MAIN memory overhead\r\n"]);
  const hunk = new HunkArena(64, () => {}); hunk.allocate(64, "low");
  lines.length = 0; hunk.log(text => { lines.push(text); }); hunk.log(text => { lines.push(text); }, true);
  expect(lines).toEqual(["\r\n================\r\nHunk log\r\n================\r\n", "0 Hunk memory\r\n", "0 hunk blocks\r\n",
    "\r\n================\r\nHunk Small log\r\n================\r\n", "0 Hunk memory\r\n", "0 hunk blocks\r\n"]);
  zone.dispose();
});

test("whole-heap helpers write to the real common logfile, not the console", async () => {
  const { root, common, printed } = await fixture();
  common.registerRuntimeCvars("fixture", async () => undefined);
  common.logHeap(); common.logHunk();
  common.cvars.set("logfile", "1", true); common.output.print("open fixture log\n");
  common.mainZone.allocate(4, ZoneTag.Botlib);
  printed.length = 0;
  common.logHeap(); common.logHunk(); common.logHunk(true);
  expect(printed).toEqual([]);
  const log = readFileSync(join(root, "baseq3/qconsole.log"), "latin1");
  expect(log).toContain("MAIN log\r\n"); expect(log).toContain("SMALL log\r\n");
  expect(log).toContain("Hunk log\r\n"); expect(log).toContain("Hunk Small log\r\n");
});
