import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRoot } from "../src/assets/native-root.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "quake3-native-roots-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  return root;
}

function nativePath(root: NativeRoot, path: string): Buffer {
  return Buffer.concat([root.resolvedBytes(), Buffer.from(`/${path}`, "latin1")]);
}

function seed(root: NativeRoot, marker: string): void {
  mkdirSync(nativePath(root, "baseq3"), { recursive: true });
  writeFileSync(nativePath(root, "baseq3/default.cfg"), "set root_fixture 1\n");
  writeFileSync(nativePath(root, "baseq3/productid.txt"), SOURCE_PRODUCT_ID);
  writeFileSync(nativePath(root, "baseq3/loose.cfg"), marker);
  writeFileSync(nativePath(root, "server.cfg"), marker);
  writeFileSync(nativePath(root, "baseq3/pak0.pk3"), sourceZip([
    { name: Buffer.from("packed.cfg"), data: Buffer.from(marker), method: 8, utf8: false },
  ]));
}

test("native roots own exact bytes and reject malformed host and source input", () => {
  const root = NativeRoot.fromHost("/tmp/rootUnicode中文/é");
  expect(root.sourceText).toBe(Buffer.from("/tmp/rootUnicode中文/é", "utf8").toString("latin1"));
  const borrowed = root.resolvedBytes();
  borrowed.fill(0);
  expect(root.resolvedBytes()).toEqual(Buffer.from("/tmp/rootUnicode中文/é"));
  expect(NativeRoot.fromSource("/tmp/\xe9").resolvedBytes()).toEqual(Buffer.from([47, 116, 109, 112, 47, 233]));
  expect(NativeRoot.fromSource("/tmp/\xc3\xa9").resolvedBytes()).toEqual(NativeRoot.fromHost("/tmp/é").resolvedBytes());
  for (const text of ["\ud800", "\udc00", "\ud800x", "x\0y"]) expect(() => NativeRoot.fromHost(text)).toThrow();
  for (const text of ["中文", "\ud800", "x\0y"]) expect(() => NativeRoot.fromSource(text)).toThrow();
  expect(NativeRoot.fromHost("😀").sourceText).toBe("\xf0\x9f\x98\x80");
  const previous = process.cwd(), cwd = join(temporary(), "中文");
  mkdirSync(cwd);
  try {
    process.chdir(cwd);
    expect(NativeRoot.fromSource("child/../\xe9").resolvedBytes()).toEqual(Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from([233])]));
    expect(NativeRoot.fromSource("").resolvedBytes()).toEqual(Buffer.from("/"));
  } finally { process.chdir(previous); }
});

test("standalone live byte roots select distinct raw and UTF-8 files across native operations and restart", async () => {
  const directory = temporary();
  const host = NativeRoot.fromHost(join(directory, "rootUnicode中文", "é"));
  const raw = NativeRoot.fromSource(`${Buffer.from(join(directory, "rootUnicode中文")).toString("latin1")}/\xe9`);
  seed(host, "host-utf8"); seed(raw, "source-raw");
  const sound = new SoundOutput(), cvars = new CvarRegistry();
  const files = new CommonFileState({ dataPath: join(directory, "rootUnicode中文", "é"), homePath: join(directory, "rootUnicode中文", "é"),
    cdPath: null, product: "baseq3" }, () => {}, sound, cvars);
  cleanup.push(() => { files.close(); sound.close(); });
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  expect(cvars.get("fs_basepath")?.value).toBe(host.sourceText);
  expect(Buffer.from(files.current.readSync("packed.cfg")).toString()).toBe("host-utf8");
  cvars.set("fs_basepath", raw.sourceText, true); cvars.set("fs_homepath", raw.sourceText, true);
  const writer = files.writable.openWrite("written.cfg", false);
  if (writer === null) throw new Error("Expected raw root writer");
  writer.write("raw-write"); writer.close();
  files.server.renameGame("written.cfg", "renamed.cfg");
  expect(readFileSync(nativePath(raw, "baseq3/renamed.cfg"), "utf8")).toBe("raw-write");
  const server = files.server.openWrite("server-write.tmp");
  if (server === null) throw new Error("Expected server writer");
  server.writeBytes(Buffer.from("server-write")); server.close();
  files.server.rename("server-write.tmp", "server-write.cfg");
  expect(files.server.exists("server-write.cfg")).toBe(true);
  const download = files.server.openDownload("server.cfg");
  if (download === null) throw new Error("Expected raw root download");
  const downloaded = Buffer.alloc(download.size);
  expect(download.read(downloaded)).toBe(downloaded.length); download.close();
  expect(downloaded.toString()).toBe("source-raw");
  const log = files.writable.openGlLog(raw);
  if (log === null) throw new Error("Expected raw root GL log");
  log.write("GL bytes\n"); log.close();
  expect(readFileSync(nativePath(raw, "gl.log"), "utf8")).toBe("GL bytes\n");
  expect(Buffer.from(files.current.readSync("loose.cfg")).toString()).toBe("host-utf8");
  await files.restart({ checksumFeed: 1, random: () => 0 }, () => {});
  expect(Buffer.from(files.current.readSync("packed.cfg")).toString()).toBe("source-raw");
  cvars.set("fs_basepath", host.sourceText, true); cvars.set("fs_homepath", host.sourceText, true);
  cvars.set("fs_cdpath", raw.sourceText, true); cvars.set("fs_copyfiles", "1", true);
  writeFileSync(nativePath(raw, "baseq3/cd-only.cfg"), "copied-raw-root");
  await files.restart({ checksumFeed: 2, random: () => 0 }, () => {});
  expect(Buffer.from(files.current.readSync("cd-only.cfg")).toString()).toBe("copied-raw-root");
  expect(readFileSync(nativePath(host, "baseq3/cd-only.cfg"), "utf8")).toBe("copied-raw-root");
});

test("common startup encodes Unicode defaults while byte overrides and saved configs retain their roots", async () => {
  const directory = temporary(), hostPath = join(directory, "rootUnicode中文", "é");
  const host = NativeRoot.fromHost(hostPath), raw = NativeRoot.fromSource(`${Buffer.from(join(directory, "rootUnicode中文")).toString("latin1")}/\xe9`);
  seed(host, "host-utf8"); seed(raw, "source-raw");
  const common = await CommonConsole.open({ roots: { dataPath: hostPath, homePath: hostPath, cdPath: null, product: "baseq3" },
    startup: new StartupCommands(`+set fs_basepath "${raw.sourceText}" +set fs_homepath "${raw.sourceText}"`),
    random: new LinuxNativeRandom(1), build: { kind: "dedicated" }, platformPrint: () => {}, resolveCommand: () => undefined,
    assertCommandEntry: () => {}, assertOwnerEntry: () => {} }, owner => { cleanup.push(() => { owner.close(); }); });
  expect(common.cvars.get("fs_basepath")?.value).toBe(raw.sourceText);
  expect(common.cvars.get("fs_basepath")?.resetValue).toBe(host.sourceText);
  expect(Buffer.from(common.files.current.readSync("packed.cfg")).toString()).toBe("source-raw");
  common.cvars.register("fs_basepath", host.sourceText, CvarFlag.Archive);
  common.cvars.register("saved_root", raw.sourceText, CvarFlag.Archive);
  common.registerRuntimeCvars("fixture", async () => {});
  common.commands.append("writeconfig roots.cfg\n"); await common.commands.executeAsync();
  expect(readFileSync(nativePath(raw, "baseq3/roots.cfg"), "latin1")).toContain(`seta fs_basepath "${raw.sourceText}"`);
  common.cvars.set("fs_basepath", host.sourceText, true);
  common.cvars.set("saved_root", "changed", true);
  common.commands.append("exec roots.cfg\n"); await common.commands.executeAsync();
  expect(common.cvars.get("saved_root")?.value).toBe(raw.sourceText);
  // Init cvars remain write protected during config execution.
  expect(common.cvars.get("fs_basepath")?.value).toBe(host.sourceText);
  common.cvars.set("fs_basepath", raw.sourceText, true);
  await common.files.restart({ checksumFeed: 3, random: () => 0 }, () => {});
  expect(Buffer.from(common.files.current.readSync("packed.cfg")).toString()).toBe("source-raw");
  const broken = NativeRoot.fromHost(join(directory, "broken中文"));
  mkdirSync(nativePath(broken, "baseq3"), { recursive: true });
  writeFileSync(nativePath(broken, "baseq3/productid.txt"), SOURCE_PRODUCT_ID);
  common.cvars.set("fs_basepath", broken.sourceText, true);
  common.cvars.set("fs_homepath", broken.sourceText, true);
  await expect(common.files.restart({ checksumFeed: 4, random: () => 0 }, () => {})).rejects.toThrow("Invalid game folder");
  expect(common.cvars.get("fs_basepath")?.value).toBe(raw.sourceText);
  expect(Buffer.from(common.files.current.readSync("packed.cfg")).toString()).toBe("source-raw");
});
