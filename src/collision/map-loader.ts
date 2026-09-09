// CM_LoadMap / CM_ClearMap from id Software's code/qcommon/cm_load.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import { CommonError } from "../core/common-error.ts";
import { blockChecksum } from "../core/md4.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import { CollisionWorld } from "./world.ts";
import type { CollisionWorldProfile } from "./world.ts";
import type { CollisionCounters } from "./counters.ts";
import { CollisionBoxModel, CollisionMapResource } from "./map-resource.ts";
import type { CollisionMapData } from "./map-resource.ts";

interface CollisionMapLoaderOptions {
  readonly files: () => RetainedFileReader;
  readonly memory: () => HunkAccountingProfile;
  readonly debug: CollisionWorldProfile;
  readonly counters: CollisionCounters;
  developerPrint(text: string): undefined;
}

export interface LoadedCollisionMap {
  readonly map: CollisionMapData;
  readonly world: CollisionWorld;
  readonly checksum: number;
}

/** Common owns the server map that a same-name client load borrows. */
export class CollisionMapLoader {
  private name = "";
  private current: LoadedCollisionMap | null = null;
  private resource: CollisionMapResource | null = null;
  private readonly boxModel = new CollisionBoxModel();

  constructor(private readonly options: CollisionMapLoaderOptions) {}

  load(name: string, clientLoad: boolean): LoadedCollisionMap {
    if (name.length === 0) throw new CommonError("drop", "CM_LoadMap: NULL name");
    const { debug } = this.options;
    if (debug.kind === "shared") debug.settings.registerMap();
    this.options.developerPrint(`CM_LoadMap( ${name}, ${clientLoad ? 1 : 0} )\n`);
    if (clientLoad && this.name === name && this.current !== null) return this.current;
    this.clear();
    const files = this.options.files();
    const file = files.readFileRetainedSync(name);
    if (file === undefined) throw new CommonError("drop", `Couldn't load ${name}`);
    const bytes = file.bytes;
    const checksum = blockChecksum(bytes) | 0;
    const memory = this.options.memory();
    this.resource = new CollisionMapResource(name, memory, debug.kind === "shared" ? debug.owner : null, this.boxModel);
    const map = this.resource;
    map.load(file.terminatedBytes);
    files.freeFile(file);
    map.initializeBoxHull();
    const world = new CollisionWorld(map, { kind: "unaccounted" }, debug, this.options.counters);
    const loaded = { map, world, checksum };
    this.current = loaded;
    if (!clientLoad) this.name = name.slice(0, 63);
    return loaded;
  }

  clear(): void {
    this.name = "";
    this.current = null;
    this.resource = null;
    const { debug } = this.options;
    if (debug.kind === "shared") debug.owner.clearLevelPatches();
  }
}
