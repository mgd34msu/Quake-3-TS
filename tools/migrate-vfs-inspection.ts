// Prints an apply_patch migration for the former inspection-only VFS.open API.
import { readFileSync } from "node:fs";

const search = Bun.spawnSync(["rg", "-l", "VirtualFileSystem\\.open\\b", "src", "tests", "tools"]);
if (search.exitCode !== 0 && search.exitCode !== 1) throw new Error(new TextDecoder().decode(search.stderr));
const paths = new TextDecoder().decode(search.stdout).trim().split("\n").filter(path => path.length > 0).sort();
const sections: string[] = [];
for (const path of paths) {
  const hunks: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const updated = line.replaceAll(/\bVirtualFileSystem\.open\b/g, "VirtualFileSystem.openInspection");
    if (line !== updated) hunks.push(`@@\n-${line}\n+${updated}`);
  }
  if (hunks.length > 0) sections.push(`*** Update File: ${path}\n${hunks.join("\n")}`);
}
if (sections.length > 0) process.stdout.write(`*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`);
else process.stderr.write("No legacy inspection calls remain.\n");
