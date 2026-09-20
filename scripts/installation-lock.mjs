import { acquireLock } from "../dist/storage.js";

export function withInstallationLock(workspace, operation) {
  const release = acquireLock(workspace, ".glue-install-lock", "Another installation operation is active, or its lock remains after interruption. Inspect .glue-install-lock/owner.json and confirm that process stopped before removing the lock.");
  try { return operation(); }
  finally {
    const failure = release();
    if (failure) console.error(failure + " The leftover .glue-install-lock directory blocks later installations here until it is removed; nothing holds it.");
  }
}
