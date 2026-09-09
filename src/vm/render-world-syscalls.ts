/*
 * World traps from id Software code/client/cl_cgame.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CollisionWorld } from "../collision/world.ts";
import type { Vec3 } from "../core/math.ts";
import type { RendererResources } from "../render/world.ts";
import type { QvmMemory } from "./memory.ts";

function vector(view: DataView): Vec3 {
  return { x: view.getFloat32(0, true), y: view.getFloat32(4, true), z: view.getFloat32(8, true) };
}

export function qvmRenderWorldSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory,
  resources: RendererResources, collision: Pick<CollisionWorld, "clusterPVS">,
): number | Promise<number> | null {
  if (role !== "cgame") return null;
  switch (words.getInt32(0, true)) {
    case 36:
      return resources.loadWorld(memory.readString(words.getInt32(4, true))).then(() => 0);
    case 86: {
      const outputWord = words.getInt32(4, true), capacity = words.getInt32(8, true);
      return Number(resources.getEntityToken(token => { memory.writeString(outputWord, token, capacity); }));
    }
    case 88: {
      const firstWord = words.getInt32(4, true), secondWord = words.getInt32(8, true);
      return Number(resources.inPVS(() => vector(memory.view(firstWord, 12)),
        () => vector(memory.view(secondWord, 12)), cluster => collision.clusterPVS(cluster)));
    }
    default: return null;
  }
}
