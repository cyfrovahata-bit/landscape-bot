import { sql } from "drizzle-orm";
import { db } from "./db.js";

export type LockedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serializes access to a business key (e.g. "reserve:2026-07-02") using a
 * Postgres advisory lock, held for the duration of `fn` -- and hands `fn`
 * the same transaction the lock lives in, so "only one caller at a time"
 * and "all its writes commit or roll back together" come from one construct
 * instead of two. Fixes the check-then-write race on car/people reservation
 * (two concurrent requests could otherwise both pass a "not taken" check
 * before either write commits) and gives the caller a real transaction to
 * write through for atomicity across several tables in one request.
 *
 * Unlike an in-process mutex, this works correctly even if miniapp-server
 * ever runs as more than one instance -- the lock lives in Postgres, not in
 * a single process's memory. It's released automatically when the
 * transaction ends (commit, rollback, or thrown error), so there's no leak
 * risk from a forgotten unlock call.
 */
export async function withLock<T>(key: string, fn: (tx: LockedTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return fn(tx);
  });
}
