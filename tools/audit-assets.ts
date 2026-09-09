import { mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { parseArgs } from "node:util";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { parseMd3 } from "../src/assets/md3.ts";
import { decodeTga } from "../src/assets/tga.ts";
import { decodeJpeg } from "../src/assets/jpeg.ts";
import { decodeWav } from "../src/assets/wav.ts";
import { parseAas } from "../src/botlib/aas.ts";
import { RoqDecoder } from "../src/cinematic/roq.ts";
import { findDataPath } from "../src/engine/data-path.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { VfsSource } from "../src/assets/vfs.ts";

type AuditDetails = AasAuditDetails | RoqAuditDetails;

interface AasAuditDetails {
  readonly kind: "aas";
  readonly version: 4 | 5;
  readonly bspChecksum: number;
  readonly areas: number;
  readonly reachabilities: number;
  readonly clusters: number;
}

interface RoqAuditDetails {
  readonly kind: "roq";
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly frames: number;
  readonly audioEvents: number;
  readonly audioSampleValues: number;
}

interface AuditRecord {
  readonly path: string;
  readonly kind: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: VfsSource;
  readonly details?: AuditDetails;
}

function auditRoq(data: Uint8Array, path: string): RoqAuditDetails {
  const decoder = new RoqDecoder(data, path);
  let frames = 0;
  let audioEvents = 0;
  let audioSampleValues = 0;
  for (;;) {
    const event = decoder.next();
    switch (event.kind) {
      case "frame":
        frames += 1;
        break;
      case "audio":
        audioEvents += 1;
        audioSampleValues += event.samples.length;
        break;
      case "end":
        return {
          kind: "roq", width: decoder.width, height: decoder.height, frameRate: decoder.frameRate,
          frames, audioEvents, audioSampleValues,
        };
      default: {
        const exhaustive: never = event;
        throw new Error(`Unknown RoQ event: ${String(exhaustive)}`);
      }
    }
  }
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string" }, product: { type: "string", default: "missionpack" },
    output: { type: "string", default: ".artifacts/asset-audit.json" },
    limit: { type: "string" }, kinds: { type: "string", default: "bsp,md3,tga,jpg,wav,aas,roq" },
  },
});
if (values.product !== "baseq3" && values.product !== "missionpack") throw new Error("Product must be baseq3 or missionpack");
const product: Product = values.product;
const dataPath = await findDataPath(values.data);
const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
try {
  const kinds = new Set(values.kinds.split(","));
  for (const kind of kinds) if (!["bsp", "md3", "tga", "jpg", "wav", "aas", "roq"].includes(kind)) throw new Error(`Unsupported audit kind ${kind}`);
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (limit !== Infinity && (!Number.isInteger(limit) || limit <= 0)) throw new Error("Limit must be a positive integer");
  const counts = new Map<string, number>();
  const errors: { path: string; error: string }[] = [];
  const records: AuditRecord[] = [];
  const started = performance.now();
  for (const path of vfs.list()) {
    const kind = extname(path).slice(1);
    if (!kinds.has(kind) || (counts.get(kind) ?? 0) >= limit) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    try {
      const data = await vfs.read(path);
      const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
      let details: AuditDetails | undefined;
      switch (kind) {
        case "bsp": parseBsp(data, path); break;
        case "md3": parseMd3(data, path); break;
        case "tga": decodeTga(data, path); break;
        case "jpg": decodeJpeg(data, path, text => { process.stderr.write(text); }); break;
        case "wav": decodeWav(data, path); break;
        case "aas": {
          const world = parseAas(data, path);
          details = {
            kind: "aas", version: world.version, bspChecksum: world.bspChecksum,
            areas: world.areas.length, reachabilities: world.reachability.length, clusters: world.clusters.length,
          };
          break;
        }
        case "roq": details = auditRoq(data, path); break;
        default: throw new Error(`Missing parser for ${kind}`);
      }
      if (new Bun.CryptoHasher("sha256").update(data).digest("hex") !== sha256) {
        throw new Error("Asset parser mutated its input bytes");
      }
      const source = vfs.source(path);
      if (source === undefined) throw new Error(`Missing VFS provenance for ${path}`);
      const common = { path, kind, bytes: data.length, sha256, source };
      records.push(details === undefined ? common : { ...common, details });
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
      process.stderr.write(`${path}: ${errors.at(-1)?.error}\n`);
    }
    if (records.length > 0 && records.length % 250 === 0) process.stdout.write(`Validated ${records.length} assets\n`);
  }
  const report = {
    product, dataPath, mergedFiles: vfs.list().length, limit: limit === Infinity ? null : limit,
    kinds: [...kinds], counts: Object.fromEntries(counts), passed: records.length, failed: errors.length,
    elapsedMilliseconds: Math.round(performance.now() - started), errors, records,
  };
  await mkdir(dirname(values.output), { recursive: true });
  await Bun.write(values.output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify({ ...report, records: undefined, errors: undefined })}\nReport: ${values.output}\n`);
  if (errors.length !== 0) process.exitCode = 1;
} finally {
  vfs.close();
}
