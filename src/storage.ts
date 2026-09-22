import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, rmdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function assertUnlinked(file: string) {
  let current = resolve(file);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Glue storage files and their parent directories must not be linked.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function acquireLock(directory: string, name: string, message: string) {
  const lock = join(directory, name), owner = join(lock, "owner.json");
  try { mkdirSync(lock); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = code === "EEXIST" ? message : code === "EACCES" || code === "EPERM"
      ? "Glue cannot write its lock directory. Check this workspace's host write permissions; no lock contention was established."
      : "Glue could not create its lock directory: " + (error instanceof Error ? error.message : String(error));
    throw Object.assign(new Error(detail, { cause: error }), { code, path: lock, retryable: code === "EEXIST" });
  }
  let descriptor: number | undefined, ownerCreated = false;
  try {
    descriptor = openSync(owner, "wx", 0o600);
    ownerCreated = true;
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const completed = descriptor;
    descriptor = undefined;
    closeSync(completed);
  } catch (error) {
    // A write can fail after creating owner.json. Only remove it if our exclusive open succeeded.
    // Cleanup must not replace the original write/open failure.
    let cleanupFailed = false;
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { cleanupFailed = true; } }
    if (ownerCreated) { try { unlinkSync(owner); } catch { cleanupFailed = true; } }
    try { rmdirSync(lock); } catch { cleanupFailed = true; }
    if (cleanupFailed && error instanceof Error)
      Object.assign(error, { lockNotReleased: "Glue could not clean up its lock after owner creation failed. Inspect the lock before another write." });
    throw error;
  }
  let released = false;
  // Never throws: callers release in finally, where a throw would replace the outcome of the work the lock protected.
  // One attempt only. A lock this call failed to remove may later belong to another writer.
  return (): string | undefined => {
    if (released) return undefined;
    released = true;
    try { unlinkSync(owner); rmdirSync(lock); }
    catch (error) { return "Glue could not remove its lock (" + ((error as NodeJS.ErrnoException).code ?? "unknown error") + ")."; }
    return undefined;
  };
}

const leftoverWriteLock = " The leftover .write-lock directory blocks later writes to this context until it is removed, and blocks creating any new context if this one has no saved history. Nothing holds it, although owner.json inside may still name this running Glue process. Check the project's delete permissions.";

export function withWriteLock<T>(directory: string, operation: () => T): { value: T; lockNotReleased?: string } {
  const release = acquireLock(directory, ".write-lock", "Glue store is busy. Retry the same request. Inspect .write-lock/owner.json and confirm a crashed writer stopped before removing its lock.");
  let value: T;
  try { value = operation(); }
  catch (error) {
    const failure = release();
    if (failure && error instanceof Error) Object.assign(error, { lockNotReleased: failure + leftoverWriteLock });
    throw error;
  }
  const failure = release();
  return failure === undefined ? { value } : { value, lockNotReleased: failure + " The work above is saved." + leftoverWriteLock };
}

export function atomicWrite(file: string, bytes: string) {
  const temporary = file + "." + randomUUID() + ".tmp";
  assertUnlinked(file);
  assertUnlinked(temporary);
  // A failed exclusive open owns nothing and must not clean up another file.
  const descriptor = openSync(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, file);
    renamed = true;
  } finally {
    if (!renamed) unlinkSync(temporary);
  }
}
