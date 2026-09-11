import { chmod, lstat, mkdir, mkdtemp, rename, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertBuildInputs, buildNetworkDefaults, checkedBuildSnapshot, compileSnapshot } from "./build.ts";
import { RELEASE_TARGETS } from "./release-targets.ts";

const documents = ["README.md", "LICENSE", "NOTICE.md", "docs/PLATFORMS.md",
  "licenses/IJG-README.txt", "licenses/LGPL-2.1.txt", "licenses/Bun-LICENSE.md"];

async function release(): Promise<void> {
  if (Bun.version !== "1.3.14") throw new Error("Release builds require Bun 1.3.14");
  if (process.platform !== "linux") throw new Error("Release packaging requires a Linux host with Info-ZIP zip installed");
  const zip = Bun.which("zip");
  if (zip === null) throw new Error("Release packaging requires Info-ZIP zip on PATH");
  if (Bun.which("unzip") === null) throw new Error("Release ZIP integrity checks require unzip on PATH");
  const zipEnvironment = { ...process.env, TZ: "UTC", ZIPOPT: "", UNZIPOPT: "", UNZIP: "" };
  const networkDefaults = buildNetworkDefaults(process.argv.slice(2));
  const workspace = process.cwd();
  const { snapshot, snapshotPath } = await checkedBuildSnapshot(workspace);
  const packageJson: unknown = await Bun.file(join(snapshotPath, "package.json")).json();
  if (typeof packageJson !== "object" || packageJson === null || !("version" in packageJson)
    || typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(packageJson.version)) {
    throw new Error("Release package.json requires a numeric major.minor.patch version");
  }
  for (const document of documents) {
    if (!(await lstat(join(snapshotPath, document))).isFile()) throw new Error(`Release document is not a regular file: ${document}`);
  }
  // ZIP stores DOS timestamps. A fixed UTC date and stripped extras make packaging repeatable.
  const timestamp = new Date("2000-01-01T00:00:00.000Z");
  const dist = join(workspace, "dist");
  await mkdir(dist, { recursive: true });
  const staging = await mkdtemp(join(dist, ".release-"));
  const archives = join(staging, "archives");
  await mkdir(archives);
  const checksums: string[] = [];
  for (const target of RELEASE_TARGETS) {
    const payload = join(snapshotPath, "dist", target.name);
    await mkdir(payload, { recursive: true });
    const executable = join(payload, target.executable);
    process.stdout.write(`Compiling ${target.name}\n`);
    await compileSnapshot(snapshotPath, networkDefaults, { target: target.compile, outfile: executable }, "inline");
    for (const document of documents) {
      const destination = join(payload, document);
      await mkdir(dirname(destination), { recursive: true });
      await Bun.write(destination, await Bun.file(join(snapshotPath, document)).bytes());
      await chmod(destination, 0o644);
      await utimes(destination, timestamp, timestamp);
    }
    await chmod(executable, 0o755);
    await utimes(executable, timestamp, timestamp);
    const name = `quake3-ts-${packageJson.version}-${target.name}.zip`;
    const archive = join(archives, name);
    const zipped = Bun.spawn([zip, "-X", "-9", "-q", archive, target.executable, ...documents], {
      cwd: payload, env: zipEnvironment, stdout: "inherit", stderr: "inherit",
    });
    if (await zipped.exited !== 0) throw new Error(`ZIP creation failed for ${target.name}; candidate remains at ${staging}`);
    const verified = Bun.spawn([zip, "-T", archive], { env: zipEnvironment, stdout: "inherit", stderr: "inherit" });
    if (await verified.exited !== 0) throw new Error(`ZIP integrity check failed for ${target.name}`);
    checksums.push(`${Bun.CryptoHasher.hash("sha256", await Bun.file(archive).bytes(), "hex")}  ${name}`);
  }
  await Bun.write(join(archives, "checksums.txt"), `${checksums.join("\n")}\n`);
  await assertBuildInputs(workspace, snapshotPath, snapshot);
  const published = join(dist, "releases");
  let previous = false;
  try {
    await lstat(published);
    previous = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const backup = join(staging, "previous-releases");
  if (previous) await rename(published, backup);
  try {
    await rename(archives, published);
  } catch (error) {
    if (previous) await rename(backup, published);
    throw error;
  }
  if (previous) process.stdout.write(`Previous releases retained at ${backup}\n`);
  process.stdout.write(`Built ${RELEASE_TARGETS.length} release ZIPs in ${published}; SHA256 hashes: checksums.txt\n`);
}

if (import.meta.main) await release();
