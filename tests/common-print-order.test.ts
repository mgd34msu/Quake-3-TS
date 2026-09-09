import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonError } from "../src/core/common-error.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quake3-print-order-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, "baseq3")); writeFileSync(join(root, "baseq3/default.cfg"), "set fixture 1\n");
  writeFileSync(join(root, "baseq3/productid.txt"), SOURCE_PRODUCT_ID);
  const printed: string[] = [];
  let observer: (text: string) => void = () => {};
  const common = await CommonConsole.open({ roots: { homePath: root, dataPath: root, cdPath: null, product: "baseq3" },
    startup: new StartupCommands("+set com_hunkMegs 1+set developer 1"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: text => { printed.push(text); observer(text); }, resolveCommand: () => undefined,
    assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined }, value => { cleanup.push(() => { value.close(); }); });
  common.registerRuntimeCvars("fixture", async () => undefined);
  common.cvars.set("developer", "0", true);
  printed.length = 0;
  return { common, printed, path: join(root, "baseq3/qconsole.log"), observe(callback: (text: string) => void): void { observer = callback; } };
}

function caughtCommonError(operation: () => void): CommonError {
  try { operation(); }
  catch (error) { if (error instanceof CommonError) return error; throw error; }
  throw new Error("Expected source common error");
}

test("failed log open checks live logfile after the opening-message callback", async () => {
  const f = await fixture(); mkdirSync(f.path);
  f.common.cvars.set("logfile", "1", true);
  f.observe(text => { if (text.startsWith("logfile opened")) f.common.cvars.set("logfile", "2", true); });
  const error = caughtCommonError(() => { f.common.output.print("trigger\n"); });
  expect(error.code).toBe("drop"); expect(error.message).toBe("FS_FileForHandle: NULL");
  expect(f.printed[0]).toBe("trigger\n"); expect(f.printed[1]?.startsWith("logfile opened")).toBe(true);
  // The failed FS_ForceFlush abort never clears opening_qconsole.
  f.observe(() => {}); rmdirSync(f.path); f.common.cvars.set("logfile", "1", true);
  f.common.output.print("after drop\n"); expect(existsSync(f.path)).toBe(false);
});

test("lowering logfile inside the opening message avoids the failed ForceFlush path", async () => {
  const f = await fixture(); mkdirSync(f.path);
  f.common.cvars.set("logfile", "2", true);
  f.observe(text => { if (text.startsWith("logfile opened")) f.common.cvars.set("logfile", "1", true); });
  expect(() => f.common.output.print("trigger\n")).not.toThrow();
  f.observe(() => {}); rmdirSync(f.path);
  f.common.output.print("retry\n"); expect(readFileSync(f.path, "latin1")).toEndWith("retry\n");
});

test("a reached source abort inside log-open diagnostics leaves the opening guard set", async () => {
  const f = await fixture(), failure = new CommonError("drop", "fixture diagnostic abort");
  f.common.cvars.set("fs_debug", "1", true); f.common.cvars.set("logfile", "1", true);
  f.observe(text => { if (text.startsWith("FS_FOpenFileWrite:")) throw failure; });
  expect(() => f.common.output.print("trigger\n")).toThrow(failure);
  expect(existsSync(f.path)).toBe(false);
  f.observe(() => {}); f.common.cvars.set("fs_debug", "0", true);
  f.common.output.print("after abort\n"); expect(existsSync(f.path)).toBe(false);
});

test("log writes recheck filesystem initialization after the nested opening print", async () => {
  const f = await fixture(); f.common.cvars.set("logfile", "1", true);
  f.observe(text => { if (text.startsWith("logfile opened")) f.common.files.close(); });
  expect(() => f.common.output.print("trigger\n")).not.toThrow();
  expect(readFileSync(f.path, "latin1")).toBe("");
});

test("the already-entered outer log print still writes when its nested message disables logging", async () => {
  const f = await fixture(); f.common.cvars.set("logfile", "1", true);
  f.observe(text => { if (text.startsWith("logfile opened")) f.common.cvars.set("logfile", "0", true); });
  f.common.output.print("outer\n");
  expect(readFileSync(f.path, "latin1")).toBe("outer\n");
});

test("a real error command does not run the redirect end continuation on abort", async () => {
  const f = await fixture(), flushed: string[] = [];
  await expect(f.common.output.redirect(256, text => { flushed.push(text); }, async () => {
    f.common.output.print("before error\n");
    await f.common.commands.executeNowAsync("error drop");
  })).rejects.toThrow("Testing drop error");
  expect(flushed).toEqual([]); expect(f.common.output.redirecting).toBe(true);
  // This managed buffer remains inspectable; native stack storage after longjmp is not reproduced.
  f.common.output.endRedirect(); expect(flushed).toEqual(["before error\n"]);
});
