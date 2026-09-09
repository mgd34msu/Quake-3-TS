// SPDX-License-Identifier: GPL-2.0-or-later

export interface AssetReader {
  read(path: string): Promise<Uint8Array>;
  has(path: string): boolean;
  list(prefix?: string): readonly string[];
}

/** Detached adapters for FS_ReadFile contents; retained source lifetimes use RetainedFileReader. */
export interface SourceFileReader {
  readFileLength(path: string): number;
  readFileOptional(path: string): Promise<Uint8Array | undefined>;
  readFileOptionalSync(path: string): Uint8Array | undefined;
}
