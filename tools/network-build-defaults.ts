import { join } from "node:path";
import type { NetworkDefaults } from "../src/core/network-defaults.ts";

export function networkDefaultsPlugin(workspace: string, defaults: NetworkDefaults): Bun.BunPlugin {
  const path = join(workspace, "src/core/network-defaults.ts");
  return {
    name: "network-defaults",
    setup(build) {
      build.onLoad({ filter: /[/\\]core[/\\]network-defaults\.ts$/u }, async (args) => {
        if (args.path !== path) return undefined;
        let contents = await Bun.file(path).text();
        for (const [name, value] of Object.entries({ Q3_MASTER_SERVER: defaults.masterServer,
          Q3_AUTH_SERVER: defaults.authorizeServer, Q3_AUTH_PORT: String(defaults.authorizePort) })) {
          const expression = `process.env[${JSON.stringify(name)}]`;
          if (contents.split(expression).length !== 2) throw new Error(`Expected exactly one endpoint read for ${name}`);
          contents = contents.replace(expression, () => JSON.stringify(value));
        }
        return { contents, loader: "ts" };
      });
    },
  };
}
