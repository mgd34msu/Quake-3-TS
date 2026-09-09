// R_ScreenShot_f and CL_Frame AVI timing, id Software tr_init.c and cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { WritableFileSystem } from "../assets/writable-files.ts";
import type { CommandContext } from "../core/commands.ts";
import type { RendererCommandStorage } from "../render/commands.ts";
import { ScreenshotCommand, ScreenshotFilename } from "../render/screenshot.ts";
import type { ScreenshotFormat, ScreenshotGraphics } from "../render/screenshot.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";

export function aviFrameMilliseconds(fps: number, timescale: number): number {
  const value = Math.fround(Math.fround(Math.trunc(1000 / fps)) * Math.fround(timescale));
  if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648)
    throw new RangeError("Undefined native CL_Frame AVI milliseconds conversion");
  const milliseconds = Math.trunc(value);
  return milliseconds === 0 ? 1 : milliseconds;
}

/** The source statics survive renderer registration and filesystem game changes. */
export class EngineScreenshots {
  private readonly lastNumber = { tga: -1, jpeg: -1 };
  private readonly filename = new ScreenshotFilename();

  constructor(private readonly memoryProfile: HunkAccountingProfile = { kind: "unaccounted" }) {}

  command(context: CommandContext, graphics: ScreenshotGraphics & { readonly commands: Pick<RendererCommandStorage, "takeScreenshot">;
    readonly worldBaseName: string | null },
  files: WritableFileSystem, print: (text: string) => undefined, format: ScreenshotFormat = "tga"): undefined {
    const argument = context.argv[1] ?? "";
    const capture = new ScreenshotCommand(graphics, files, this.filename, print, format, this.memoryProfile);
    if (argument === "levelshot") {
      if (graphics.worldBaseName === null) throw new Error("R_LevelShot requires a loaded renderer world; source null-world dereference is undefined");
      const filename = `levelshots/${graphics.worldBaseName}.tga`;
      capture.levelshot(filename); print(`Wrote ${filename}\n`); return;
    }
    const silent = argument === "silent";
    const extension = format === "jpeg" ? "jpg" : "tga";
    let filename: string;
    if (context.argv.length === 2 && !silent) filename = `screenshots/${argument}.${extension}`.slice(0, 4095);
    else {
      if (this.lastNumber[format] === -1) this.lastNumber[format] = 0;
      filename = `screenshots/shot9999.${extension}`;
      for (; this.lastNumber[format] <= 9999; this.lastNumber[format]++) {
        filename = `screenshots/shot${String(this.lastNumber[format]).padStart(4, "0")}.${extension}`;
        if (!files.fileExists(filename)) break;
      }
      if (format === "tga" ? this.lastNumber[format] >= 9999 : this.lastNumber[format] === 10000) { print("ScreenShot: Couldn't create a file\n"); return; }
      this.lastNumber[format]++;
    }
    if (graphics.commands.takeScreenshot(capture)) this.filename.value = filename;
    if (!silent) print(`Wrote ${filename}\n`);
  }
}
