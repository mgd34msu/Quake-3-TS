// Port of id Software's common.c Com_ParseCommandLine/StartupVariable/SafeMode/AddStartupCommands.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandBuffer } from "../core/commands.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { sourceCommandText, tokenizeCommand } from "../core/text.ts";

export interface StartupLine {
  readonly text: string;
  readonly argv: readonly string[];
}

export function parseStartupLines(sourceText: string): readonly StartupLine[] {
  const source = sourceCommandText(sourceText), lines: StartupLine[] = [];
  let start = 0, quoted = false;
  for (let index = 0; index < source.length; index++) {
    const byte = source[index];
    if (byte === '"') quoted = !quoted;
    if ((byte === "+" && !quoted) || byte === "\n" || byte === "\r") {
      if (lines.length === 31) break;
      const text = source.slice(start, index);
      lines.push(Object.freeze({ text, argv: Object.freeze(tokenizeCommand(text)) }));
      start = index + 1;
    }
  }
  const text = source.slice(start);
  lines.push(Object.freeze({ text, argv: Object.freeze(tokenizeCommand(text)) }));
  return Object.freeze(lines);
}

export class StartupCommands {
  readonly lines: readonly StartupLine[];
  private readonly consumed = new Set<number>();

  constructor(sourceText: string) { this.lines = parseStartupLines(sourceText); }

  applyVariables(cvars: CvarRegistry, match: string | null): void {
    for (const [index, line] of this.lines.entries()) {
      if (this.consumed.has(index) || line.argv[0] !== "set") continue;
      const name = line.argv[1] ?? "";
      if (match !== null && name !== match) continue;
      cvars.set(name, line.argv[2] ?? "", true);
      const registered = cvars.register(name, "");
      cvars.addFlags(registered.name, CvarFlag.UserCreated);
    }
  }

  consumeSafeMode(): boolean {
    for (const [index, line] of this.lines.entries()) {
      if (this.consumed.has(index)) continue;
      const command = line.argv[0]?.toLowerCase();
      if (command === "safe" || command === "cvar_restart") { this.consumed.add(index); return true; }
    }
    return false;
  }

  appendCommands(commands: CommandBuffer): boolean {
    let added = false;
    for (const [index, line] of this.lines.entries()) {
      if (this.consumed.has(index) || line.text.length === 0) continue;
      if (line.text.slice(0, 3).toLowerCase() !== "set") added = true;
      commands.append(line.text);
      commands.append("\n");
    }
    return added;
  }
}
