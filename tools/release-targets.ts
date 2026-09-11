export const RELEASE_TARGETS = [
  // Bun's x64 baseline supports SSE4.2 CPUs without requiring AVX2.
  { name: "linux-x64", compile: "bun-linux-x64-baseline", executable: "quake3-ts" },
  { name: "linux-arm64", compile: "bun-linux-arm64", executable: "quake3-ts" },
  { name: "darwin-x64", compile: "bun-darwin-x64-baseline", executable: "quake3-ts" },
  { name: "darwin-arm64", compile: "bun-darwin-arm64", executable: "quake3-ts" },
  { name: "windows-x64", compile: "bun-windows-x64-baseline", executable: "quake3-ts.exe" },
] satisfies readonly { readonly name: string; readonly compile: Bun.Build.CompileTarget; readonly executable: string }[];
