import type { Buffer } from "node:buffer";

export interface FileChildInformation {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Every descriptor is owned by the caller and compatible with Bun's node:fs. */
export interface FileNativeOperations {
  descriptorPath(descriptor: number): Buffer;
  descriptorPosition(descriptor: number): number;
  openDirectory(path: Buffer): number;
  duplicateDirectory(descriptor: number): number;
  inspectChild(parent: number, name: Buffer): FileChildInformation;
  openChildDirectory(parent: number, name: Buffer): number;
  openChild(parent: number, name: Buffer, flags: number, mode: number): number;
  mkdirChild(parent: number, name: Buffer): void;
  renameChild(sourceParent: number, sourceName: Buffer, destinationParent: number, destinationName: Buffer): void;
  linkChild(sourceParent: number, sourceName: Buffer, destinationParent: number, destinationName: Buffer): void;
  unlinkChild(parent: number, name: Buffer): void;
}
