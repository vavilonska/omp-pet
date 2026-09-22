import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPetDataRoot, runtimeDescriptorPath, runtimeExecutableCandidates } from "../src/paths";

describe("OMP pet data paths", () => {
  test("uses the non-virtualized OMP home on Windows", () => {
    if (process.platform !== "win32" || process.env.OMP_PET_DATA_DIR?.trim()) return;
    expect(getPetDataRoot()).toBe(join(homedir(), ".omp", "omp-pet"));
  });

  test("isolates runtime descriptors by session id", () => {
    expect(runtimeDescriptorPath("session-one")).toBe(
      join(getPetDataRoot(), "runtimes", "session-one.json"),
    );
    expect(() => runtimeDescriptorPath("../escape")).toThrow("Invalid OMP pet runtime id");
  });

  test("keeps the legacy packaged runtime as a safe fallback", () => {
    expect(runtimeExecutableCandidates().some(path => path.endsWith("omp-pet-runtime.exe"))).toBe(
      true,
    );
  });
});
