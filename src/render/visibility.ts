// R_MarkLeaves and RE_RenderScene area state from id Software's tr_world.c/tr_scene.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { SourceBspResource, SourceBspVisibilityNode } from "./bsp-resource.ts";
import type { RendererPerformanceCounters } from "./performance.ts";
import { RDF_NOWORLDMODEL } from "./refdef.ts";
import type { Refdef } from "./refdef.ts";
import type { RendererVisibilitySettings } from "./settings.ts";

const CONTENTS_SOLID = 1;

/** R_Init zeros this state. Portal views retain the scene's mask and the last marked cluster. */
export class SourceWorldVisibility {
  // Linux little-endian trRefdef_t places rdflags immediately before areamask.
  // Retail area -1 reaches that predecessor byte through a C subarray overread.
  private readonly refdefArea = new DataView(new ArrayBuffer(4 + 32));
  private readonly areaMask = new DataView(this.refdefArea.buffer, 4, 32);
  private areaMaskModified = false;
  private count = 0;

  constructor(private readonly source: SourceBspResource, private readonly settings: RendererVisibilitySettings,
    private readonly performance: RendererPerformanceCounters, private readonly print: (text: string) => undefined) {}

  get visCount(): number { return this.count; }

  beginScene(refdef: Pick<Refdef, "renderFlags" | "areaMask">): void {
    this.refdefArea.setInt32(0, refdef.renderFlags, true);
    this.areaMaskModified = false;
    if ((this.refdefArea.getInt32(0, true) & RDF_NOWORLDMODEL) !== 0) return;

    const incoming = new DataView(refdef.areaMask.buffer, refdef.areaMask.byteOffset, refdef.areaMask.byteLength);
    let difference = 0;
    for (let offset = 0; offset < 32; offset += 4) {
      const word = incoming.getInt32(offset, true);
      difference |= this.areaMask.getInt32(offset, true) ^ word;
      this.areaMask.setInt32(offset, word, true);
    }
    if (difference !== 0) this.areaMaskModified = true;
  }

  /** The resolver returns the leaf's index in the combined source node allocation. */
  markLeaves(resolveLeaf: () => number): void {
    if (this.settings.lockPvs) return;

    const leaf = this.source.visibilityNode(resolveLeaf()), cluster = leaf.cluster;
    if (this.performance.viewCluster === cluster && !this.areaMaskModified && !this.settings.showClusterModified) return;

    if (this.settings.showClusterModified || this.settings.showCluster) {
      this.settings.clearShowClusterModified();
      if (this.settings.showCluster) this.print(`cluster:${cluster}  area:${leaf.area}\n`);
    }

    this.count = (this.count + 1) | 0;
    this.performance.viewCluster = cluster;

    if (this.settings.noVis || this.performance.viewCluster === -1) {
      for (let index = 0; index < this.source.visibilityNodeCount; index++) {
        const node = this.source.visibilityNode(index);
        if (node.contents !== CONTENTS_SOLID) node.visFrame = this.count;
      }
      return;
    }

    const viewCluster = this.performance.viewCluster;
    for (let index = 0; index < this.source.visibilityNodeCount; index++) {
      const node = this.source.visibilityNode(index), nodeCluster = node.cluster;
      if (nodeCluster < 0 || nodeCluster >= this.source.numClusters) continue;
      if ((this.source.clusterVisibilityByte(viewCluster, nodeCluster >> 3) & (1 << (nodeCluster & 7))) === 0) continue;
      const area = node.area;
      if (area < -1 || area >= 256) throw new RangeError(`R_MarkLeaves area ${area} is outside the supported refdef area-mask profile`);
      if ((this.refdefArea.getUint8(4 + (area >> 3)) & (1 << (area & 7))) !== 0) continue;

      let parent: SourceBspVisibilityNode | null = node;
      do {
        if (parent.visFrame === this.count) break;
        parent.visFrame = this.count;
        const parentIndex: number | null = parent.parent;
        parent = parentIndex === null ? null : this.source.visibilityNode(parentIndex);
      } while (parent !== null);
    }
  }
}
