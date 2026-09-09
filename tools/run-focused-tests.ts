import { stat } from "node:fs/promises";
import { resolve } from "node:path";

interface PreflightResult {
  readonly paths: readonly string[];
  readonly errors: readonly string[];
}

async function preflight(arguments_: readonly string[]): Promise<PreflightResult> {
  if (arguments_.length === 0) {
    return { paths: [], errors: ["Usage: bun tools/run-focused-tests.ts <file.test.ts>..."] };
  }

  const cwd = process.cwd();
  const paths: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const argument of arguments_) {
    const path = resolve(cwd, argument);
    if (argument.startsWith("-")) {
      errors.push(`Invalid focused test path "${argument}" (resolved to "${path}"): option-like inputs are not allowed.`);
      continue;
    }

    paths.push(path);
    if (!path.endsWith(".test.ts")) {
      errors.push(`Invalid focused test path "${argument}" (resolved to "${path}"): path must end with .test.ts.`);
    }
    if (seen.has(path)) {
      errors.push(`Duplicate focused test path after resolution: ${path}`);
    } else {
      seen.add(path);
    }
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) {
        errors.push(`Invalid focused test path "${argument}" (resolved to "${path}"): path is not a regular file.`);
      }
    } catch {
      errors.push(`Invalid focused test path "${argument}" (resolved to "${path}"): path is not an existing regular file.`);
    }
  }
  return { paths, errors };
}

async function main(arguments_: readonly string[]): Promise<number> {
  const result = await preflight(arguments_);
  if (result.errors.length !== 0) {
    process.stderr.write("Focused test preflight rejected:\n");
    for (const error of result.errors) process.stderr.write(`- ${error}\n`);
    return 1;
  }

  const listing = result.paths.map((path, index) => `${index + 1}. ${path}`).join("\n");
  process.stdout.write(`Focused test files (${result.paths.length}):\n${listing}\n`);
  const child = Bun.spawn([process.execPath, "test", ...result.paths], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
