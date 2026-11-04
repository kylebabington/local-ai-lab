// =========================================================
// lib/synthetic-reclaim-roots.js
//
// Dedicated synthetic test-root registry for Milestone D2.
// Default: no authorized removal roots.
// Registration is only possible when the in-process test
// authority token is present (verification harness). Ordinary
// HTTP APIs and model tools never receive this API.
// =========================================================


import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";


/** @type {symbol | null} */
let authorityToken = null;

/** @type {Map<string, { runId: string, rootId: string, realPath: string, ino: number, dev: number, sizeHint: number, registeredAt: string }>} */
const rootsById = new Map();

/** @type {Map<string, Set<string>>} */
const rootsByRun = new Map();


export function installSyntheticTestAuthority(token) {
    if (typeof token !== "symbol") {
        throw new Error("Synthetic test authority token must be a Symbol.");
    }
    authorityToken = token;
}


export function revokeSyntheticTestAuthority() {
    authorityToken = null;
}


function assertAuthority(token) {
    if (!authorityToken || token !== authorityToken) {
        throw Object.assign(
            new Error(
                "Synthetic reclaim root registration requires the in-process test authority.",
            ),
            { code: "SYNTHETIC_AUTHORITY_REQUIRED", status: 403 },
        );
    }
}


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


/**
 * Register an explicitly created synthetic test root.
 * Harness-only. Validates canonical path, identity, and refuses reparse points.
 */
export async function registerSyntheticReclaimRoot(token, { runId, rootPath }) {
    assertAuthority(token);

    if (typeof runId !== "string" || !runId.trim()) {
        throw new Error("runId is required.");
    }
    if (typeof rootPath !== "string" || !rootPath.trim()) {
        throw new Error("rootPath is required.");
    }

    const resolved = path.resolve(rootPath.trim());
    const lstat = await fs.lstat(resolved);
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
        throw Object.assign(
            new Error("Synthetic root must be a real directory (no symlinks)."),
            { code: "INVALID_SYNTHETIC_ROOT", status: 400 },
        );
    }

    try {
        const link = await fs.readlink(resolved);
        if (link) {
            throw Object.assign(
                new Error("Synthetic root must not be a reparse point."),
                { code: "INVALID_SYNTHETIC_ROOT", status: 400 },
            );
        }
    } catch (error) {
        if (error.code === "INVALID_SYNTHETIC_ROOT") {
            throw error;
        }
        // not a link
    }

    const realPath = await fs.realpath(resolved);
    const realStat = await fs.lstat(realPath);
    if (realStat.isSymbolicLink()) {
        throw Object.assign(
            new Error("Synthetic root realpath must not be a symlink."),
            { code: "INVALID_SYNTHETIC_ROOT", status: 400 },
        );
    }

    const rootId = crypto.randomUUID();
    const record = {
        runId: runId.trim(),
        rootId,
        realPath,
        ino: realStat.ino,
        dev: realStat.dev,
        sizeHint: 0,
        registeredAt: new Date().toISOString(),
    };
    rootsById.set(rootId, record);
    if (!rootsByRun.has(record.runId)) {
        rootsByRun.set(record.runId, new Set());
    }
    rootsByRun.get(record.runId).add(rootId);
    return { ...record };
}


export function clearSyntheticReclaimRoots(token, runId = null) {
    assertAuthority(token);
    if (runId == null) {
        rootsById.clear();
        rootsByRun.clear();
        return;
    }
    const set = rootsByRun.get(runId);
    if (!set) {
        return;
    }
    for (const id of set) {
        rootsById.delete(id);
    }
    rootsByRun.delete(runId);
}


export function listSyntheticReclaimRoots() {
    return [...rootsById.values()].map((record) => ({ ...record }));
}


export function isPathInsideSyntheticReclaimRoot(filePath) {
    if (typeof filePath !== "string" || !filePath) {
        return null;
    }
    const target = normalizeCompare(filePath);
    for (const record of rootsById.values()) {
        const root = normalizeCompare(record.realPath);
        if (target === root || target.startsWith(`${root}${path.sep}`)) {
            return { ...record };
        }
    }
    return null;
}


/**
 * Live revalidation: path still inside a registered root whose identity matches.
 */
export async function assertInsideLiveSyntheticRoot(filePath) {
    const match = isPathInsideSyntheticReclaimRoot(filePath);
    if (!match) {
        throw Object.assign(
            new Error(
                "Source is outside every explicitly registered synthetic reclaim test root.",
            ),
            { code: "NOT_SYNTHETIC_ROOT", status: 403 },
        );
    }

    const rootStat = await fs.lstat(match.realPath);
    if (
        rootStat.ino !== match.ino ||
        rootStat.dev !== match.dev ||
        rootStat.isSymbolicLink()
    ) {
        throw Object.assign(
            new Error(
                "Registered synthetic root identity changed; refusing removal.",
            ),
            { code: "SYNTHETIC_ROOT_CHANGED", status: 409 },
        );
    }

    const real = await fs.realpath(path.resolve(filePath));
    const realNorm = normalizeCompare(real);
    const rootNorm = normalizeCompare(match.realPath);
    if (realNorm !== rootNorm && !realNorm.startsWith(`${rootNorm}${path.sep}`)) {
        throw Object.assign(
            new Error("Canonical path escaped the registered synthetic root."),
            { code: "SYNTHETIC_ROOT_ESCAPE", status: 403 },
        );
    }

    return { match, realPath: real };
}


export const _test = {
    getAuthorityToken: () => authorityToken,
    rootsById,
};
