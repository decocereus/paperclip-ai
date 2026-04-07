import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type SymlinkEntry = {
  source: string;
  target: string;
};

export async function hydrateEmbeddedPostgresRuntimeSymlinks(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (process.arch !== "arm64") return;

  let packageJsonPath: string;
  try {
    const entryPath = require.resolve("@embedded-postgres/darwin-arm64");
    packageJsonPath = path.join(path.dirname(entryPath), "..", "package.json");
  } catch {
    return;
  }

  const packageDir = path.dirname(packageJsonPath);
  const symlinkManifestPath = path.join(packageDir, "native", "pg-symlinks.json");

  let symlinks: SymlinkEntry[];
  try {
    symlinks = JSON.parse(await fs.readFile(symlinkManifestPath, "utf8")) as SymlinkEntry[];
  } catch {
    return;
  }

  for (const entry of symlinks) {
    const target = path.join(packageDir, entry.target);
    const source = path.join(packageDir, entry.source);
    const targetDir = path.dirname(target);
    const relativeSource = path.relative(targetDir, source);

    try {
      const stats = await fs.lstat(target).catch(() => null);
      if (stats) continue;
      await fs.mkdir(targetDir, { recursive: true });
      await fs.symlink(relativeSource, target);
    } catch {
      // Ignore hydration failures here; embedded-postgres will still surface
      // a clearer startup error if the runtime is not usable.
    }
  }
}
