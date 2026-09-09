import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TextParseError } from "../src/core/text.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
import { parsePlayerAnimationConfig } from "../src/assets/animation.ts";
import { ClientInfo } from "../src/cgame/client-info.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { PlayerAnimation } from "../src/shared/player-state.ts";

function rows(count: number): string {
  const result: string[] = [];
  for (let index = 0; index < count; index++) {
    const firstFrame = index < PlayerAnimation.LEGS_WALKCR ? index * 10 : 200 + (index - PlayerAnimation.LEGS_WALKCR) * 10;
    const frameCount = index === 1 ? -2 : index + 1;
    const loopFrames = index % 3;
    const fps = index === 2 ? 0 : index === 3 ? 24 : 20;
    result.push(`${firstFrame} ${frameCount} ${loopFrames} ${fps}`);
  }
  return result.join("\n");
}

function animation(config: ReturnType<typeof parsePlayerAnimationConfig>, index: PlayerAnimation) {
  const value = config.animations[index];
  if (value === undefined || value === null) throw new Error(`missing animation ${index}`);
  return value;
}

describe("player animation.cfg", () => {
  test("publishes each reached field before a partial-row diagnostic and retains the unwritten cells", () => {
    for (const partial of ["777", "777 -9", "777 9 4"]) {
      const target = new ClientInfo();
      target.setAnimations(target.animations.map(() => ({ firstFrame: 901, numFrames: 902, loopFrames: 903,
        frameLerp: 904, initialLerp: 905, reversed: true, flipflop: true })));
      target.footsteps = "mech";
      target.fixedTorso = true;
      const cells = target.animations, held = cells[PlayerAnimation.LEGS_WALKCR];
      if (held === undefined) throw new Error("Missing retained animation cell");
      const diagnostics: string[] = [];
      expect(() => parsePlayerAnimationConfig(`headoffset 1 2 3\n${rows(13)}\n${partial}`, "partial.cfg", {
        target, parser: new CommonParseState(), print(message: string): void {
          diagnostics.push(message);
          expect(target.animations).toBe(cells);
          expect(target.animations[PlayerAnimation.LEGS_WALKCR]).toBe(held);
          expect(held.firstFrame).toBe(60);
          expect(target.headOffset).toEqual({ x: 1, y: 2, z: 3 });
        },
      })).toThrow(TextParseError);
      expect(diagnostics).toEqual(["Error parsing animation file: partial.cfg"]);
      expect(held).toEqual({ firstFrame: 60, numFrames: partial === "777" ? 902 : 9,
        loopFrames: partial === "777 9 4" ? 4 : 903, frameLerp: 904, initialLerp: 905,
        reversed: partial !== "777 9 4", flipflop: partial === "777" });
      expect(target).toMatchObject({ footsteps: "normal", fixedTorso: false });
      expect(cells[PlayerAnimation.LEGS_WALK]).toEqual({ firstFrame: 901, numFrames: 902, loopFrames: 903,
        frameLerp: 904, initialLerp: 905, reversed: true, flipflop: true });
    }
  });

  test("uses source atoi and atof numeric prefixes, int32 wrap and out-of-range CVFI", () => {
    const config = parsePlayerAnimationConfig(rows(25)
      .replace("0 1 0 20", "4294967295x -2147483648 4294967297tail .0000001")
      .replace("10 -2 1 20", "10x -2frames 1loop nope"));
    expect(animation(config, PlayerAnimation.BOTH_DEATH1)).toEqual({ firstFrame: -1, numFrames: -2147483648,
      loopFrames: 1, frameLerp: -2147483648, initialLerp: -2147483648, reversed: true, flipflop: false });
    expect(animation(config, PlayerAnimation.BOTH_DEAD1)).toEqual({ firstFrame: 10, numFrames: 2,
      loopFrames: 1, frameLerp: 1000, initialLerp: 1000, reversed: true, flipflop: false });
  });

  test("retains sentinel and flag fields while standalone results own their animation values", () => {
    const target = new ClientInfo(), parser = new CommonParseState();
    const sentinel = target.animations[31], flag = target.animations[PlayerAnimation.FLAG_RUN];
    if (sentinel === undefined || flag === undefined) throw new Error("Missing retained cell");
    sentinel.firstFrame = 3131;
    flag.flipflop = true;
    const config = parsePlayerAnimationConfig(`${rows(25)}\n`, "retained.cfg", { target, parser, print: () => {} });
    expect(target.animations[31]).toBe(sentinel);
    expect(sentinel.firstFrame).toBe(3131);
    expect(config.animations[31]).toBeNull();
    expect(target.animations[PlayerAnimation.FLAG_RUN]).toBe(flag);
    expect(flag.flipflop).toBe(true);
    expect(animation(config, PlayerAnimation.FLAG_RUN)).not.toBe(flag);
    flag.firstFrame = 999;
    expect(animation(config, PlayerAnimation.FLAG_RUN).firstFrame).toBe(0);
  });

  test("observes shared COM_Parse state at warnings and stops before an unreached bad token", () => {
    const target = new ClientInfo(), parser = new CommonParseState(), stop = new Error("diagnostic consumer stopped");
    const calls: string[] = [];
    expect(() => parsePlayerAnimationConfig(`headoffset 1 2 3\nfootsteps stone\n"${"x".repeat(1024)}"`, "warning.cfg", {
      target, parser, print(message): void {
        calls.push(message);
        expect(target.headOffset).toEqual({ x: 1, y: 2, z: 3 });
        expect(parser.token).toBe("stone");
        throw stop;
      },
    })).toThrow(stop);
    expect(calls).toEqual(["Bad footsteps parm in warning.cfg: stone\n"]);
    const before = parser.line;
    parsePlayerAnimationConfig(`${rows(31)}\n"${"x".repeat(1024)}"`, "tail.cfg", { target, parser, print: () => {} });
    expect(parser.line).toBeGreaterThan(before);
    expect(parser.token).toBe("20");
  });

  test("applies COM_Parse ordinary token overflow at the reached field", () => {
    const target = new ClientInfo(), parser = new CommonParseState(), first = target.animations[0];
    if (first === undefined) throw new Error("Missing first animation cell");
    Object.assign(first, { numFrames: 11, reversed: true, flipflop: true });
    const calls: string[] = [];
    expect(() => parsePlayerAnimationConfig(`17 ${"9".repeat(1024)} 5 20`, "token.cfg", {
      target, parser, print: message => { calls.push(message); },
    })).toThrow("Error parsing animation file: token.cfg");
    expect(calls).toEqual(["Error parsing animation file: token.cfg"]);
    expect(parser.token).toBe("");
    expect(first).toEqual({ firstFrame: 17, numFrames: 11, loopFrames: 0,
      frameLerp: 0, initialLerp: 0, reversed: true, flipflop: true });
  });

  test("parses metadata, source rows, reversal, integer frame timing and leg frame correction", () => {
    const config = parsePlayerAnimationConfig(`
      footsteps energy
      headoffset -3.25 .5 2
      sex Female
      fixedlegs
      fixedtorso
      extension_token
      ${rows(31)}
    `, "player.cfg");
    expect(config.footsteps).toBe("energy");
    expect(config.headOffset).toEqual({ x: -3.25, y: 0.5, z: 2 });
    expect(config.gender).toBe("female");
    expect(config.fixedLegs).toBe(true);
    expect(config.fixedTorso).toBe(true);
    expect(config.warnings.map(warning => warning.message)).toEqual(["unknown token 'extension_token' is player.cfg\n"]);
    expect(animation(config, PlayerAnimation.BOTH_DEAD1)).toEqual({
      firstFrame: 10, numFrames: 2, loopFrames: 1,
      frameLerp: 50, initialLerp: 50, reversed: true, flipflop: false,
    });
    expect(animation(config, PlayerAnimation.BOTH_DEATH2).frameLerp).toBe(1000);
    expect(animation(config, PlayerAnimation.BOTH_DEAD2).frameLerp).toBe(41);
    expect(animation(config, PlayerAnimation.LEGS_WALKCR).firstFrame).toBe(60);
    expect(animation(config, PlayerAnimation.LEGS_WALK).firstFrame).toBe(70);
    expect(animation(config, PlayerAnimation.TORSO_GETFLAG).firstFrame).toBe(320);
  });

  test("uses TORSO_GESTURE only for the missing legacy missionpack torso tail", () => {
    const config = parsePlayerAnimationConfig(rows(25));
    const gesture = animation(config, PlayerAnimation.TORSO_GESTURE);
    for (let index = PlayerAnimation.TORSO_GETFLAG; index <= PlayerAnimation.TORSO_NEGATIVE; index++) {
      expect(config.animations[index]).toEqual(gesture);
    }
    expect(config.animations).toHaveLength(37);
    expect(config.animations[31]).toBeNull();
  });

  test("synthesizes backward legs and flag animations in the source numeric slots", () => {
    const config = parsePlayerAnimationConfig(rows(25));
    expect(animation(config, PlayerAnimation.LEGS_BACKCR)).toEqual({
      ...animation(config, PlayerAnimation.LEGS_WALKCR), reversed: true,
    });
    expect(animation(config, PlayerAnimation.LEGS_BACKWALK)).toEqual({
      ...animation(config, PlayerAnimation.LEGS_WALK), reversed: true,
    });
    expect(animation(config, PlayerAnimation.FLAG_RUN)).toEqual({
      firstFrame: 0, numFrames: 16, loopFrames: 16,
      frameLerp: 66, initialLerp: 66, reversed: false, flipflop: false,
    });
    expect(animation(config, PlayerAnimation.FLAG_STAND)).toEqual({
      firstFrame: 16, numFrames: 5, loopFrames: 0,
      frameLerp: 50, initialLerp: 50, reversed: false, flipflop: false,
    });
    expect(animation(config, PlayerAnimation.FLAG_STAND2RUN)).toEqual({
      firstFrame: 16, numFrames: 5, loopFrames: 1,
      frameLerp: 66, initialLerp: 66, reversed: true, flipflop: false,
    });
  });

  test("defaults metadata and warns when the source would warn", () => {
    const config = parsePlayerAnimationConfig(`footsteps stone\nsex neutral\n${rows(25)}`, "warning.cfg");
    expect(config.footsteps).toBe("normal");
    expect(config.headOffset).toEqual({ x: 0, y: 0, z: 0 });
    expect(config.gender).toBe("neuter");
    expect(config.fixedLegs).toBe(false);
    expect(config.fixedTorso).toBe(false);
    expect(config.warnings.map(warning => warning.message)).toEqual(["Bad footsteps parm in warning.cfg: stone\n"]);
  });

  test("rejects omissions outside the six-row legacy fallback and partial rows", () => {
    expect(() => parsePlayerAnimationConfig(rows(24), "short.cfg")).toThrow("Error parsing animation file: short.cfg");
    expect(() => parsePlayerAnimationConfig(`${rows(25)}\n400 2`, "partial.cfg")).toThrow("Error parsing animation file: partial.cfg");
    expect(() => parsePlayerAnimationConfig("headoffset 1", "offset.cfg")).toThrow("source nonprogress cycle");
  });

  test("rejects source file-buffer overflow before metadata or animation writes", () => {
    const target = new ClientInfo(), diagnostics: string[] = [];
    target.footsteps = "mech";
    target.headOffset = { x: 1, y: 2, z: 3 };
    expect(() => parsePlayerAnimationConfig("x".repeat(19_999), "large.cfg", {
      target, parser: new CommonParseState(), print: message => { diagnostics.push(message); },
    })).toThrow("File large.cfg too long\n");
    expect(diagnostics).toEqual(["File large.cfg too long\n"]);
    expect(target.footsteps).toBe("mech");
    expect(target.headOffset).toEqual({ x: 1, y: 2, z: 3 });
    expect(target.animations[0]?.frameLerp).toBe(0);
  });
});

const retailPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retailPath, "baseq3", "pak0.pk3")))("parses every installed player animation.cfg", async () => {
  const hasMissionpack = existsSync(join(retailPath, "missionpack", "pak0.pk3"));
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: hasMissionpack ? "missionpack" : "baseq3" });
  const paths = vfs.list("models/players/").filter(path => path.endsWith("animation.cfg"));
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await vfs.read(path));
    const config = parsePlayerAnimationConfig(text, path);
    expect(config.animations).toHaveLength(37);
    expect(config.animations[31]).toBeNull();
    expect(config.warnings).toEqual([]);
  }
}, 30_000);
