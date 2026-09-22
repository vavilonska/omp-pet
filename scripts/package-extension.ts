import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The current sealed package target is win32-x64");
}

const workspaceRoot = resolve(import.meta.dir, "..");
const templateRoot = join(workspaceRoot, "packaging", "windows");
const releaseRoot = join(workspaceRoot, "release");
const packageTemplate = JSON.parse(
  await readFile(join(templateRoot, "package.json"), "utf8"),
) as { name: string; version: string };
const bundleName = `${packageTemplate.name}-${packageTemplate.version}-win32-x64`;
const bundleRoot = join(releaseRoot, bundleName);
const payloadRoot = join(bundleRoot, "payload");
const extensionEntry = join(workspaceRoot, "packages", "omp-extension", "dist", "index.js");
const runtimeExecutable = join(
  workspaceRoot,
  "runtime",
  "src-tauri",
  "target",
  "release",
  "omp-pet-runtime.exe",
);
const runtimeHash = createHash("sha256")
  .update(await readFile(runtimeExecutable))
  .digest("hex")
  .slice(0, 12);
const packagedRuntimeRelative = `bin/win32-x64/${runtimeHash}/omp-pet-runtime.exe`;
const packagedLoaderRelative = `bin/win32-x64/${runtimeHash}/WebView2Loader.dll`;
const webviewLoader = join(
  workspaceRoot,
  "runtime",
  "src-tauri",
  "target",
  "release",
  "WebView2Loader.dll",
);

for (const source of [extensionEntry, runtimeExecutable, webviewLoader]) {
  if (!(await stat(source).catch(() => null))?.isFile()) {
    throw new Error(`Required build artifact is missing: ${source}`);
  }
}

const resolvedRelease = resolve(releaseRoot);
const resolvedBundle = resolve(bundleRoot);
if (!resolvedBundle.startsWith(`${resolvedRelease}\\`)) {
  throw new Error("Unsafe release output path");
}
await rm(bundleRoot, { recursive: true, force: true });
await mkdir(join(payloadRoot, "dist"), { recursive: true });
await mkdir(join(payloadRoot, "docs"), { recursive: true });
await mkdir(join(payloadRoot, "bin", "win32-x64", runtimeHash), { recursive: true });

for (const name of ["install.ps1", "uninstall.ps1", "install.cmd", "uninstall.cmd", "README.md"]) {
  await copyFile(join(templateRoot, name), join(bundleRoot, name));
}
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await copyFile(join(workspaceRoot, name), join(bundleRoot, name));
}
await copyFile(join(templateRoot, "package.json"), join(payloadRoot, "package.json"));
await copyFile(
  join(templateRoot, ".omp-pet-package.json"),
  join(payloadRoot, ".omp-pet-package.json"),
);
await copyFile(extensionEntry, join(payloadRoot, "dist", "index.js"));
await copyFile(
  join(workspaceRoot, "docs", "ANIMATION_TIMING.md"),
  join(payloadRoot, "docs", "ANIMATION_TIMING.md"),
);
await copyFile(
  join(workspaceRoot, "runtime", "public", "fonts", "NotoSansSC-OFL.txt"),
  join(payloadRoot, "docs", "NotoSansSC-OFL.txt"),
);
await copyFile(
  runtimeExecutable,
  join(payloadRoot, ...packagedRuntimeRelative.split("/")),
);
await copyFile(
  webviewLoader,
  join(payloadRoot, ...packagedLoaderRelative.split("/")),
);
await writeFile(
  join(payloadRoot, "bin", "win32-x64", "runtime-current.txt"),
  `${runtimeHash}/omp-pet-runtime.exe\n`,
  "utf8",
);

const checksumFiles = [
  "package.json",
  ".omp-pet-package.json",
  "dist/index.js",
  "docs/ANIMATION_TIMING.md",
  "docs/NotoSansSC-OFL.txt",
  "bin/win32-x64/runtime-current.txt",
  packagedRuntimeRelative,
  packagedLoaderRelative,
];
const checksums: Record<string, string> = {};
for (const relativePath of checksumFiles) {
  const bytes = await readFile(join(payloadRoot, ...relativePath.split("/")));
  checksums[relativePath] = createHash("sha256").update(bytes).digest("hex");
}
await writeFile(
  join(payloadRoot, "SHA256SUMS.json"),
  `${JSON.stringify(checksums, null, 2)}\n`,
  "utf8",
);

const zipPath = join(releaseRoot, `${bundleName}.zip`);
await rm(zipPath, { force: true });
const archive = Bun.spawn([
  "tar.exe",
  "-a",
  "-c",
  "-f",
  zipPath,
  "-C",
  releaseRoot,
  bundleName,
], { stdout: "inherit", stderr: "inherit" });
const archiveExitCode = await archive.exited;
if (archiveExitCode !== 0) throw new Error(`ZIP creation failed with exit code ${archiveExitCode}`);
const archiveHash = createHash("sha256").update(await readFile(zipPath)).digest("hex");
await writeFile(
  `${zipPath}.sha256`,
  `${archiveHash}  ${basename(zipPath)}\n`,
  "utf8",
);

console.log(`Created ${basename(bundleRoot)}`);
console.log(`Created ${basename(zipPath)}`);
console.log(`Created ${basename(zipPath)}.sha256`);
