import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getPetDataRoot(): string {
  const override = process.env.OMP_PET_DATA_DIR?.trim();
  if (override) return resolve(override);
  if (process.platform === "win32") {
    // Keep runtime discovery and imported pets outside packaged-app LocalAppData
    // virtualization. This lets OMP instances launched from a normal shell and
    // from an MSIX-hosted tool see the same files.
    return join(homedir(), ".omp", "omp-pet");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "oh-my-pi", "omp-pet");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "oh-my-pi", "omp-pet");
}

export function runtimeDescriptorPath(runtimeId?: string): string {
  if (!runtimeId) return join(getPetDataRoot(), "runtime.json");
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(runtimeId)) {
    throw new Error("Invalid OMP pet runtime id");
  }
  return join(getPetDataRoot(), "runtimes", `${runtimeId}.json`);
}

export function runtimeExecutableCandidates(): string[] {
  const override = process.env.OMP_PET_RUNTIME?.trim();
  const moduleFile = fileURLToPath(import.meta.url);
  const packageRoot = resolve(dirname(moduleFile), "..");
  const workspaceRoot = resolve(packageRoot, "..", "..");
  const executable = process.platform === "win32" ? "omp-pet-runtime.exe" : "omp-pet-runtime";
  const platformArch = `${process.platform}-${process.arch}`;
  const packagedBinRoot = join(packageRoot, "bin", platformArch);
  let packagedCurrent: string | null = null;
  try {
    const relative = readFileSync(join(packagedBinRoot, "runtime-current.txt"), "utf8")
      .trim()
      .replaceAll("\\", "/");
    if (/^[a-f0-9]{12}\/omp-pet-runtime\.exe$/.test(relative)) {
      packagedCurrent = join(packagedBinRoot, ...relative.split("/"));
    }
  } catch {
    // Older packages use the unversioned runtime path below.
  }
  return [
    ...(override ? [resolve(override)] : []),
    ...(packagedCurrent ? [packagedCurrent] : []),
    join(packagedBinRoot, executable),
    join(workspaceRoot, "runtime", "src-tauri", "target", "release", executable),
    join(workspaceRoot, "runtime", "src-tauri", "target", "debug", executable),
  ];
}
