/*
 * UI_BuildQ3Model_List from id Software's code/ui/ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { gameFormat } from "../../game/format.ts";
import type { GameFormatArgument } from "../../game/format.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import type { RendererResources } from "../../render/world.ts";

export interface TeamArenaPlayerModel { name: string; icon: SceneShader | null }

/** Retained uiInfo.q3HeadNames/Icons; callers await builds within one UI operation. */
export class TeamArenaModels {
  readonly heads: readonly TeamArenaPlayerModel[] = Array.from({ length: 256 }, () => ({ name: "", icon: null }));
  headCount = 0;

  constructor(
    private readonly files: CommonFileState,
    private readonly resources: Pick<RendererResources, "registerShaderNoMip">,
    private readonly print: (text: string) => void,
    private readonly assertActive: () => void,
  ) {}

  async buildList(): Promise<void> {
    this.assertActive();
    this.headCount = 0;
    const directories = new Uint8Array(2048), filenames = new Uint8Array(2048);
    const directoryCount = this.files.current.getFileList("models/players", "/", directories);
    let directoryOffset = 0;
    for (let index = 0; index < directoryCount && this.headCount < this.heads.length; index++) {
      this.assertActive();
      let directory = this.listEntry(directories, directoryOffset);
      directoryOffset += directory.length + 1;
      if (directory.endsWith("/")) directory = directory.slice(0, -1);
      if (directory === "." || directory === "..") continue;
      const fileCount = this.files.current.getFileList(`models/players/${directory}`, "tga", filenames);
      let fileOffset = 0;
      for (let file = 0; file < fileCount && this.headCount < this.heads.length; file++) {
        this.assertActive();
        const filename = this.listEntry(filenames, fileOffset);
        fileOffset += filename.length + 1;
        const dot = filename.indexOf("."), skin = dot < 0 ? filename : filename.slice(0, dot);
        if (skin.length >= 64) throw new RangeError("UI_BuildQ3Model_List COM_StripExtension exceeds skinname[64]");
        const folded = skin.toLowerCase();
        if (!folded.startsWith("icon_") || folded === "icon_blue" || folded === "icon_red") continue;
        const scratch = folded === "icon_default"
          ? this.format(directory, [], 256)
          : this.format("%s/%s", [directory, skin.slice(5)], 256);
        const row = this.heads[this.headCount];
        if (row === undefined) throw new RangeError("UI_BuildQ3Model_List exceeds q3HeadNames");
        // Source compares the current retained slot, not q3HeadNames[k].
        if (this.headCount > 0 && scratch.toLowerCase() === row.name.toLowerCase()) continue;
        row.name = this.format(scratch, [], 64);
        const icon = await this.resources.registerShaderNoMip(`models/players/${directory}/${skin}`);
        this.assertActive();
        row.icon = icon;
        this.headCount++;
      }
    }
  }

  private listEntry(list: Uint8Array, offset: number): string {
    const end = list.indexOf(0, offset);
    if (end < 0) throw new RangeError("UI_BuildQ3Model_List source listing lacks a terminator");
    return String.fromCharCode(...list.subarray(offset, end));
  }

  private format(format: string, args: readonly GameFormatArgument[], capacity: number): string {
    const text = gameFormat(format, args);
    if (text.length >= capacity) {
      this.print(`Com_sprintf: overflow of ${text.length} in ${capacity}\n`);
      this.assertActive();
    }
    return text.slice(0, capacity - 1);
  }
}
