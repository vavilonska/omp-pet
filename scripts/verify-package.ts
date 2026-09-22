import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(
  await readFile(join(workspaceRoot, "packaging", "windows", "package.json"), "utf8"),
) as { name: string; version: string };
const bundleName = `${packageJson.name}-${packageJson.version}-win32-x64`;
const archivePath = join(workspaceRoot, "release", `${bundleName}.zip`);
const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-pet-package-verify-"));
const extractRoot = join(temporaryRoot, "extracted");
const bundleRoot = join(extractRoot, bundleName);
const agentRoot = join(temporaryRoot, "agent");
const installedRoot = join(agentRoot, "extensions", "omp-pet");
const environment = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentRoot,
  OMP_PET_DATA_DIR: join(temporaryRoot, "pet-data"),
};

async function run(command: string[], options: { quiet?: boolean } = {}): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: workspaceRoot,
    env: environment,
    stdout: options.quiet ? "ignore" : "inherit",
    stderr: "pipe",
  });
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
  }
}

try {
  await mkdir(extractRoot, { recursive: true });
  await run(["tar.exe", "-xf", archivePath, "-C", extractRoot]);
  await run(["cmd.exe", "/d", "/c", join(bundleRoot, "install.cmd")]);
  const runtimeRelative = (
    await readFile(join(installedRoot, "bin", "win32-x64", "runtime-current.txt"), "utf8")
  ).trim();
  if (!/^[a-f0-9]{12}\/omp-pet-runtime\.exe$/.test(runtimeRelative)) {
    throw new Error("Installed runtime pointer is invalid");
  }
  for (const relativePath of [
    "package.json",
    "dist/index.js",
    "docs/ANIMATION_TIMING.md",
    "bin/win32-x64/runtime-current.txt",
    `bin/win32-x64/${runtimeRelative}`,
    `bin/win32-x64/${runtimeRelative.replace("omp-pet-runtime.exe", "WebView2Loader.dll")}`,
  ]) {
    if (!(await stat(join(installedRoot, ...relativePath.split("/"))).catch(() => null))?.isFile()) {
      throw new Error(`Installer did not copy ${relativePath}`);
    }
  }

  // No -e flag: OMP must discover the installed package during normal startup.
  await run(["omp.exe", "models", "ls", "--json"], { quiet: true });
  await run([
    process.execPath,
    "scripts/smoke-runtime.ts",
    join(installedRoot, "bin", "win32-x64", ...runtimeRelative.split("/")),
  ]);
  await run(["cmd.exe", "/d", "/c", join(bundleRoot, "uninstall.cmd")]);
  if (await stat(installedRoot).catch(() => null)) {
    throw new Error("Uninstaller left the extension directory behind");
  }
  console.log("Sealed package install, OMP auto-discovery, runtime, and uninstall verified");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
