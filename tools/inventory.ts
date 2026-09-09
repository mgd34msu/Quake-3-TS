import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";

export type SourceCategory = "core-runtime" | "platform-replaced" | "library" | "tool" | "packaging" | "other";
export type BuildMembership = "referenced" | "unresolved";
export type CoverageStatus = "planned" | "in-progress" | "implemented" | "verified" | "replaced" | "not-applicable";

export interface SourceInventoryFile {
  readonly path: string;
  readonly module: string;
  readonly category: SourceCategory;
  readonly lineCount: number;
  readonly sha256: string;
  readonly missionpackDirectives: number;
  readonly buildMembership: BuildMembership;
  readonly buildFiles: readonly string[];
  readonly targetFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly status: CoverageStatus;
}

export interface Inventory {
  readonly sourceRoot: string;
  readonly sourceCommit: string;
  readonly buildMembershipMethod: string;
  readonly buildFiles: readonly string[];
  readonly totals: {
    readonly fileCount: number;
    readonly lineCount: number;
    readonly missionpackDirectives: number;
  };
  readonly files: readonly SourceInventoryFile[];
}

interface Coverage {
  readonly targetFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly status: CoverageStatus;
}

const defaultSource = "/home/buzzkill/Projects/qsrc/quake-iii-arena";
const defaultOutput = resolve(import.meta.dir, "../docs/source-inventory.json");
const coreModules = new Set(["qcommon", "game", "cgame", "q3_ui", "ui", "server", "client", "renderer", "botlib"]);
const platformModules = new Set(["macosx", "null", "unix", "win32"]);
const sourceExtensions = new Set([".c", ".h", ".cpp", ".hpp", ".m", ".asm", ".nasm", ".s", ".y", ".asdl"]);
const scriptExtensions = new Set([".sh", ".zsh", ".pl", ".pm", ".bat"]);

function isBuildFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "construct" || name === "conscript" || name.startsWith("conscript-")
    || name === "makefile" || name.startsWith("makefile.") || name.endsWith(".mak") || name.endsWith(".mk")
    || name.endsWith(".vcproj") || name.endsWith(".dsp") || name.endsWith(".pbxproj");
}

function isPackagingSource(path: string): boolean {
  return scriptExtensions.has(extname(path).toLowerCase())
    || path === "code/unix/cons" || path === "code/macosx/BuildRelease"
    || (isBuildFile(path) && ![".vcproj", ".dsp", ".pbxproj"].includes(extname(path).toLowerCase()));
}

function isSourceFile(path: string): boolean {
  return sourceExtensions.has(extname(path).toLowerCase())
    || (path.startsWith("lcc/src/") && path.endsWith(".md"))
    || isPackagingSource(path);
}

async function visitFiles(directory: string, accept: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== ".git") found.push(...await visitFiles(path, accept));
    else if (entry.isFile() && accept(path)) found.push(path);
  }
  return found.sort((left, right) => left.localeCompare(right));
}

function moduleFor(path: string): string {
  const parts = path.split("/");
  const root = parts[0];
  if (root === undefined || root.length === 0) throw new Error(`Empty source path: ${path}`);
  if (root === "code" && parts.length > 2) return parts[1] ?? root;
  if (root === "libs" && parts.length > 2) return `${root}/${parts[1]}`;
  return root;
}

function categoryFor(path: string, module: string): SourceCategory {
  if (isPackagingSource(path)) return "packaging";
  if (path.startsWith("code/") && coreModules.has(module)) return "core-runtime";
  if (path.startsWith("code/") && platformModules.has(module)) return "platform-replaced";
  if (module === "jpeg-6" || module === "splines" || module === "common" || module === "libs" || module.startsWith("libs/")) return "library";
  if (module === "bspc" || module === "lcc" || module === "q3asm" || module === "q3map" || module === "q3radiant") return "tool";
  if (module === "ui") return "core-runtime";
  return "other";
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === "string");
}

function isCoverageStatus(value: unknown): value is CoverageStatus {
  return value === "planned" || value === "in-progress" || value === "implemented" || value === "verified"
    || value === "replaced" || value === "not-applicable";
}

function coverageFrom(value: unknown): Map<string, Coverage> {
  const coverage = new Map<string, Coverage>();
  if (typeof value !== "object" || value === null || !("files" in value) || !isUnknownArray(value.files)) return coverage;
  for (const file of value.files) {
    if (typeof file !== "object" || file === null
      || !("path" in file) || typeof file.path !== "string"
      || !("targetFiles" in file) || !isStringArray(file.targetFiles)
      || !("evidence" in file) || !isStringArray(file.evidence)
      || !("status" in file) || !isCoverageStatus(file.status)) continue;
    coverage.set(file.path, {
      targetFiles: [...file.targetFiles],
      evidence: [...file.evidence],
      status: file.status,
    });
  }
  return coverage;
}

async function gitCommit(source: string): Promise<string> {
  const process = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: source, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Cannot read source commit for ${source}: ${stderr.trim()}`);
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Source commit is not a full Git hash: ${commit}`);
  return commit;
}

function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 10) count += 1;
  return count;
}

function countMissionpackDirectives(text: string): number {
  return [...text.matchAll(/^\s*#\s*(?:if|ifdef|ifndef|elif)\b[^\n]*\bMISSIONPACK\b/gm)].length;
}

function mentionsFile(buildText: string, fileName: string): boolean {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_.-])`, "m").test(buildText);
}

export async function inventorySource(source: string, previous?: unknown): Promise<Inventory> {
  const sourceRoot = resolve(source);
  let sourcePaths: string[];
  try {
    sourcePaths = await visitFiles(sourceRoot, (path) => isSourceFile(relative(sourceRoot, path).replaceAll("\\", "/")));
  } catch (error) {
    throw new Error(`Cannot inventory source code at ${sourceRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const buildPaths = await visitFiles(sourceRoot, isBuildFile);
  const buildTexts = await Promise.all(buildPaths.map(async (path) => ({
    path: relative(sourceRoot, path).replaceAll("\\", "/"),
    text: await Bun.file(path).text(),
  })));
  const preserved = coverageFrom(previous);
  const files: SourceInventoryFile[] = [];
  for (const absolutePath of sourcePaths) {
    const path = relative(sourceRoot, absolutePath).replaceAll("\\", "/");
    const module = moduleFor(path);
    const bytes = new Uint8Array(await Bun.file(absolutePath).arrayBuffer());
    const fileName = basename(path);
    const citedBuildFiles = buildTexts
      .filter((build) => mentionsFile(build.text, fileName))
      .map((build) => build.path);
    const retained = preserved.get(path) ?? { targetFiles: [], evidence: [], status: "planned" };
    files.push({
      path,
      module,
      category: categoryFor(path, module),
      lineCount: countNewlines(bytes),
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      missionpackDirectives: countMissionpackDirectives(new TextDecoder().decode(bytes)),
      buildMembership: citedBuildFiles.length === 0 ? "unresolved" : "referenced",
      buildFiles: citedBuildFiles,
      targetFiles: retained.targetFiles,
      evidence: retained.evidence,
      status: retained.status,
    });
  }
  return {
    sourceRoot,
    sourceCommit: await gitCommit(sourceRoot),
    buildMembershipMethod: "Literal basename token in Makefile*, *.mak, *.mk, Construct, Conscript*, *.vcproj, *.dsp or *.pbxproj. A mention can be a comment or a same-basename file in another directory; unresolved does not mean excluded. No variables, includes, conditionals, project structure or preprocessing are evaluated.",
    buildFiles: buildTexts.map((build) => build.path),
    totals: {
      fileCount: files.length,
      lineCount: files.reduce((sum, file) => sum + file.lineCount, 0),
      missionpackDirectives: files.reduce((sum, file) => sum + file.missionpackDirectives, 0),
    },
    files,
  };
}

interface CliOptions {
  readonly source: string;
  readonly output: string;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let source = defaultSource;
  let output = defaultOutput;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if ((option !== "--source" && option !== "--output") || value === undefined) {
      throw new Error("Usage: bun run tools/inventory.ts [--source <path>] [--output <path>]");
    }
    if (option === "--source") source = value;
    else output = value;
    index += 1;
  }
  return { source, output: resolve(output) };
}

async function readPrevious(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!await file.exists()) return undefined;
  const parsed: unknown = await file.json();
  return parsed;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const previous = await readPrevious(options.output);
  const inventory = await inventorySource(options.source, previous);
  await mkdir(dirname(options.output), { recursive: true });
  await Bun.write(options.output, `${JSON.stringify(inventory, null, 2)}\n`);
  process.stdout.write(`Inventoried ${inventory.totals.fileCount} files and ${inventory.totals.lineCount} lines at ${inventory.sourceCommit}.\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`Source inventory failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
