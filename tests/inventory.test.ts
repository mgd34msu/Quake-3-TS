import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventorySource } from "../tools/inventory.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "quake3-inventory-"));
  temporaryDirectories.push(path);
  return path;
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const process = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Fixture command failed: ${stderr}`);
}

async function sourceFixture(): Promise<string> {
  const root = temporaryDirectory();
  await Bun.write(join(root, "code/qcommon/z.h"), "#ifndef Z_H\n#define Z_H\n#endif\n");
  await Bun.write(join(root, "code/game/a.c"), "#ifdef MISSIONPACK\nint value;\n#endif");
  await Bun.write(join(root, "code/game/Conscript"), "@FILES = qw( a.c );\n");
  await run(["git", "init", "--quiet"], root);
  await run(["git", "-c", "user.name=Inventory Test", "-c", "user.email=inventory@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture"], root);
  return root;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("source inventory", () => {
  test("records stable source metadata with wc-compatible line counts", async () => {
    const root = await sourceFixture();
    const inventory = await inventorySource(root);
    expect(inventory.files.map((file) => file.path)).toEqual(["code/game/a.c", "code/game/Conscript", "code/qcommon/z.h"]);
    expect(inventory.totals).toEqual({ fileCount: 3, lineCount: 6, missionpackDirectives: 1 });
    expect(inventory.files[0]).toMatchObject({
      module: "game",
      category: "core-runtime",
      lineCount: 2,
      missionpackDirectives: 1,
      buildMembership: "referenced",
      buildFiles: ["code/game/Conscript"],
      targetFiles: [],
      evidence: [],
      status: "planned",
    });
    expect(inventory.files[0]?.sha256).toBe(new Bun.CryptoHasher("sha256").update("#ifdef MISSIONPACK\nint value;\n#endif").digest("hex"));
    expect(inventory.files[2]).toMatchObject({ buildMembership: "unresolved", buildFiles: [] });
    expect(inventory.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("preserves only validated coverage mappings", async () => {
    const root = await sourceFixture();
    const previous: unknown = {
      files: [
        { path: "code/game/a.c", targetFiles: ["src/game/a.ts"], evidence: ["tests/a.test.ts"], status: "verified" },
        { path: "code/game/Conscript", targetFiles: [], evidence: ["docs/GROUNDING.md"], status: "not-applicable" },
        { path: "code/qcommon/z.h", targetFiles: "invalid", evidence: [], status: "implemented" },
      ],
    };
    const inventory = await inventorySource(root, previous);
    expect(inventory.files[0]).toMatchObject({
      targetFiles: ["src/game/a.ts"], evidence: ["tests/a.test.ts"], status: "verified",
    });
    expect(inventory.files[2]).toMatchObject({ targetFiles: [], evidence: [], status: "planned" });
    expect(inventory.files[1]).toMatchObject({ targetFiles: [], evidence: ["docs/GROUNDING.md"], status: "not-applicable" });
    const replacement = await inventorySource(root, {
      files: [{ path: "code/game/Conscript", targetFiles: ["tools/build.ts"], evidence: ["docs/GROUNDING.md"], status: "replaced" }],
    });
    expect(replacement.files[1]).toMatchObject({ targetFiles: ["tools/build.ts"], evidence: ["docs/GROUNDING.md"], status: "replaced" });
    const invalidStatus = await inventorySource(root, {
      files: [{ path: "code/game/a.c", targetFiles: ["src/game/a.ts"], evidence: ["tests/a.test.ts"], status: "unknown" }],
    });
    expect(invalidStatus.files[0]).toMatchObject({ targetFiles: [], evidence: [], status: "planned" });
  });

  test("includes tool, library, platform and generator sources while separating packaging and excluding data", async () => {
    const root = await sourceFixture();
    const inputs = [
      "q3radiant/QGL_WIN.C", "q3radiant/VIEW.CPP", "q3radiant/VIEW.H", "q3asm/assemble.c",
      "q3map/map.c", "common/bspfile.h", "libs/jpeg6/decode.cpp", "libs/cmdlib.h",
      "code/splines/q_shared.hpp", "code/macosx/input.m", "code/unix/matha.s",
      "code/unix/ftol.nasm", "code/game/g_syscalls.asm", "lcc/lburg/gram.y",
      "lcc/src/x86.md", "lcc/src/rcc.asdl", "ui/menudef.h",
    ];
    for (const path of inputs) await Bun.write(join(root, path), "authored source fixture\n");
    for (const path of ["README.md", "lcc/README.md", "ui/menus.txt", "q3radiant/editor.rc", "lcc/test.1bk", "q3asm/tool.exe", ".git/hidden.c"])
      await Bun.write(join(root, path), "excluded fixture\n");
    await Bun.write(join(root, "q3map/makefile"), "# map.c and unrelated/map.c are literal references\n");
    await Bun.write(join(root, "q3radiant/editor.vcproj"), '<File RelativePath="VIEW.CPP" />\n');
    await Bun.write(join(root, "code/unix/build.sh"), "#!/bin/sh\n");
    const inventory = await inventorySource(root);
    expect(inventory.files).toHaveLength(inputs.length + 5);
    for (const path of inputs) expect(inventory.files.find((file) => file.path === path)).toMatchObject({ targetFiles: [], evidence: [], status: "planned" });
    expect(inventory.files.find((file) => file.path === "q3radiant/VIEW.CPP")).toMatchObject({ module: "q3radiant", category: "tool", buildFiles: ["q3radiant/editor.vcproj"] });
    expect(inventory.files.find((file) => file.path === "q3map/map.c")).toMatchObject({ module: "q3map", category: "tool", buildMembership: "referenced" });
    expect(inventory.files.find((file) => file.path === "libs/jpeg6/decode.cpp")).toMatchObject({ module: "libs/jpeg6", category: "library" });
    expect(inventory.files.find((file) => file.path === "code/macosx/input.m")).toMatchObject({ module: "macosx", category: "platform-replaced" });
    expect(inventory.files.find((file) => file.path === "lcc/src/x86.md")).toMatchObject({ module: "lcc", category: "tool" });
    expect(inventory.files.filter((file) => file.category === "packaging").map((file) => file.path)).toEqual(["code/game/Conscript", "code/unix/build.sh", "q3map/makefile"]);
    expect(inventory.buildMembershipMethod).toContain("unresolved does not mean excluded");
  });

  test("reports a missing source tree", async () => {
    const missing = join(temporaryDirectory(), "missing");
    await expect(inventorySource(missing)).rejects.toThrow(`Cannot inventory source code at ${missing}`);
  });
});
