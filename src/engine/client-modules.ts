// Retail replacement policy at code/client/cl_ui.c CL_InitUI and
// code/client/cl_cgame.c CL_InitCGame, and code/server/sv_game.c
// SV_InitGameProgs's VM_Create boundaries.
// Loading diagnostics follow code/qcommon/vm.c VM_Create.
// Original engine flow: Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import type { TrackedVirtualFileSystem } from "../assets/vfs.ts";
import { parseQvm, QvmHeaderError, readQvmSourceHeader } from "../assets/qvm.ts";
import type { QvmImage } from "../assets/qvm.ts";
import { CommonError } from "../core/common-error.ts";
import type { Product } from "../shared/definitions.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import type { VmRegistration, VmRegistry } from "../vm/registry.ts";

export type ClientModuleRole = "ui" | "cgame";
export type EngineModuleRole = ClientModuleRole | "qagame";

export type RetailEngineModule<Role extends EngineModuleRole = EngineModuleRole> = {
  readonly mode: "retail-replacement";
  readonly role: Role;
  readonly sha256: string;
  readonly byteLength: number;
} & (
  | { readonly product: "baseq3"; readonly referencePackage: "baseq3/pak8"; readonly relatedGameBuildDate: "2002-09-30" }
  | { readonly product: "missionpack"; readonly referencePackage: "missionpack/pak0"; readonly relatedGameBuildDate: "2000-12-04" }
);

export type EngineModule<Role extends EngineModuleRole = EngineModuleRole> = { readonly registration: VmRegistration } & (RetailEngineModule<Role> | {
  readonly mode: "bytecode";
  readonly role: Role;
  readonly product: Product;
  readonly image: QvmImage;
  releaseImage(): void;
  completeLoading(): void;
} | {
  readonly mode: "registered";
  readonly role: Role;
  readonly product: Product;
});

export type RetailClientModule = RetailEngineModule<ClientModuleRole>;
export type ClientModule = EngineModule<ClientModuleRole>;
export type GameModule = EngineModule<"qagame">;

// These identities were read from both installations recorded in GROUNDING.md.
// Package names identify those reference artifacts, not the pack selected by a
// later filesystem open. Dates come from each package's qagame build string.
// The 2000 Team Arena artifacts are supported replacements, not established
// equivalents of the port's 1.32b source baseline.
const retailModules: readonly RetailEngineModule[] = [
  Object.freeze({
    mode: "retail-replacement", product: "baseq3", role: "ui", referencePackage: "baseq3/pak8",
    relatedGameBuildDate: "2002-09-30", byteLength: 278_308,
    sha256: "3a6fd12b889f5d35df20a09b51bf8eca46966d014be55ffad38ddc2ffb38c807",
  } satisfies RetailClientModule),
  Object.freeze({
    mode: "retail-replacement", product: "baseq3", role: "cgame", referencePackage: "baseq3/pak8",
    relatedGameBuildDate: "2002-09-30", byteLength: 325_220,
    sha256: "4ea18569bf56a282d26dc89eb9efcc5eedbe0b69c10182fc38446174c1e55b49",
  } satisfies RetailClientModule),
  Object.freeze({
    mode: "retail-replacement", product: "missionpack", role: "ui", referencePackage: "missionpack/pak0",
    relatedGameBuildDate: "2000-12-04", byteLength: 272_040,
    sha256: "7b157f32acdb21a3904d078296672ed2d32195c5b7a206922f6f7d33c6c40e40",
  } satisfies RetailClientModule),
  Object.freeze({
    mode: "retail-replacement", product: "missionpack", role: "cgame", referencePackage: "missionpack/pak0",
    relatedGameBuildDate: "2000-12-04", byteLength: 442_304,
    sha256: "09d0b6eb41ea623d67031d2d7a73058ccb3bc6556ec044ead529d48b58d15f4c",
  } satisfies RetailClientModule),
  Object.freeze({
    mode: "retail-replacement", product: "baseq3", role: "qagame", referencePackage: "baseq3/pak8",
    relatedGameBuildDate: "2002-09-30", byteLength: 469_796,
    sha256: "57c52bf22e4f528c064f8af1553a7103723bab0a02276bb11eed944bf829b219",
  } satisfies RetailEngineModule<"qagame">),
  Object.freeze({
    mode: "retail-replacement", product: "missionpack", role: "qagame", referencePackage: "missionpack/pak0",
    relatedGameBuildDate: "2000-12-04", byteLength: 547_700,
    sha256: "da041f17f296feeaf8269eabc9062cefdecddfd24ff4d84eb291902e527d1d8a",
  } satisfies RetailEngineModule<"qagame">),
];

const moduleReads = new WeakSet<VmRegistration>();

export function acquireClientModule(options: {
  readonly files: TrackedVirtualFileSystem;
  readonly product: Product;
  readonly role: ClientModuleRole;
  readonly registry: VmRegistry;
  readonly print: (text: string) => void;
  readonly hunk: HunkAccountingProfile;
}): ClientModule | null {
  return acquireModule(options);
}

/** SV_InitGameProgs acquires qagame before invoking GAME_INIT. */
export function acquireGameModule(options: {
  readonly files: TrackedVirtualFileSystem;
  readonly product: Product;
  readonly registry: VmRegistry;
  readonly print: (text: string) => void;
  readonly hunk: HunkAccountingProfile;
}): GameModule | null {
  return acquireModule({ ...options, role: "qagame" });
}

/** Read the selected pure-filtered module once. Known retail code stays TypeScript. */
function acquireModule<Role extends EngineModuleRole>(options: {
  readonly files: TrackedVirtualFileSystem;
  readonly product: Product;
  readonly role: Role;
  readonly registry: VmRegistry;
  readonly print: (text: string) => void;
  readonly hunk: HunkAccountingProfile;
}): EngineModule<Role> | null {
  // VM_Create samples before table lookup, including the already-created path.
  const hunk = options.hunk;
  const remaining = hunk.kind === "source-hunk" ? hunk.accounting.memoryRemaining() : null;
  const registration = options.registry.reserve(options.role);
  if (registration.binding.kind !== "initializing" || moduleReads.has(registration)) {
    return { mode: "registered", role: options.role, product: options.product, registration };
  }
  moduleReads.add(registration);
  const path = `vm/${options.role}.qvm`;
  options.print(`Loading vm file ${path}.\n`);
  const file = options.files.readFileRetainedSync(path);
  if (file === undefined) {
    options.print("Failed.\n");
    registration.free();
    return null;
  }
  const bytes = file.bytes;
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const selected = retailModules.find(module => module.byteLength === bytes.byteLength && module.sha256 === sha256);
  if (selected === undefined) {
    let image: QvmImage;
    try { readQvmSourceHeader(bytes, path); image = parseQvm(bytes, path); }
    catch (error) {
      registration.free();
      if (error instanceof QvmHeaderError) throw new CommonError("fatal", error.message);
      throw error;
    }
    return { mode: "bytecode", role: options.role, product: options.product, registration, image,
      releaseImage: () => { options.files.freeFile(file); },
      // VM_Create's tail follows FS_FreeFile and VM_LoadSymbols in the caller.
      completeLoading: () => {
        if (hunk.kind === "source-hunk" && remaining !== null) {
          options.print(`${options.role} loaded in ${remaining - hunk.accounting.memoryRemaining()} bytes on the hunk\n`);
        }
      } };
  }
  if (selected.product !== options.product || selected.role !== options.role) {
    registration.free();
    throw new Error(`Retail replacement mismatch for ${path}: recorded ${selected.product} ${selected.role}, requested ${options.product} ${options.role}.`);
  }
  options.files.freeFile(file);
  return Object.freeze({ ...selected, role: options.role, registration });
}
