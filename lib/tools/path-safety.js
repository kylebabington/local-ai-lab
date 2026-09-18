// =========================================================
// lib/tools/path-safety.js
//
// Allowed-root containment, symlink rejection, and Windows-safe
// path comparison. All filesystem tools must go through here.
// =========================================================


import fs from "node:fs/promises";
import path from "node:path";


const ENV_ALLOWED_ROOTS = "LOCAL_AI_ALLOWED_ROOTS";


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


/**
 * Generic path containment check (Windows-aware).
 * Authority (which roots are allowed) is the caller's concern.
 *
 * @param {string} candidate
 * @param {string} root
 * @returns {boolean}
 */
export function isPathInsideRoot(candidate, root) {
    const candidateNorm = normalizeCompare(candidate);
    const rootNorm = normalizeCompare(root);

    if (candidateNorm === rootNorm) {
        return true;
    }

    const relative = path.relative(rootNorm, candidateNorm);

    if (!relative || relative === "") {
        return true;
    }

    if (path.isAbsolute(relative)) {
        return false;
    }

    const first = relative.split(/[\\/]/)[0];
    return first !== "..";
}


/**
 * Allowed roots for this process.
 * LOCAL_AI_ALLOWED_ROOTS uses path.delimiter (";" on Windows).
 * If unset, only process.cwd().
 *
 * @returns {string[]}
 */
export function getAllowedRoots() {
    const raw = process.env[ENV_ALLOWED_ROOTS];

    if (!raw || !raw.trim()) {
        return [path.resolve(process.cwd())];
    }

    return raw
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry));
}


async function lstatIfExists(filePath) {
    try {
        return await fs.lstat(filePath);
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }

        throw error;
    }
}


/**
 * Walk every existing prefix of resolvedPath and reject
 * if any component is a symbolic link.
 *
 * @param {string} resolvedPath
 */
async function assertNoSymlinkComponents(resolvedPath) {
    const parsed = path.parse(resolvedPath);
    let current = parsed.root;
    const rest = resolvedPath.slice(parsed.root.length);
    const parts = rest.split(/[\\/]/).filter(Boolean);

    for (const part of parts) {
        current = path.join(current, part);
        const stats = await lstatIfExists(current);

        if (!stats) {
            break;
        }

        if (stats.isSymbolicLink()) {
            throw new Error("Symbolic links are not allowed.");
        }
    }
}


function findMatchingRoot(resolvedPath, roots) {
    return roots.find((root) => isPathInsideRoot(resolvedPath, root)) ?? null;
}


/**
 * Resolve a requested path, require logical containment, reject
 * symlink components, then confirm realpath still sits inside a
 * real allowed root.
 *
 * Used for paths that must already exist.
 *
 * @param {string} requestedPath
 */
export async function resolveExistingPath(requestedPath) {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
        throw new Error("Path is required.");
    }

    const roots = getAllowedRoots();
    const resolved = path.resolve(requestedPath);
    const logicalRoot = findMatchingRoot(resolved, roots);

    if (!logicalRoot) {
        throw new Error("Path is outside the allowed filesystem roots.");
    }

    await assertNoSymlinkComponents(resolved);

    const stats = await lstatIfExists(resolved);

    if (!stats) {
        throw new Error("Path does not exist.");
    }

    if (stats.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed.");
    }

    const realTarget = await fs.realpath(resolved);
    const realRoot = await fs.realpath(logicalRoot);

    if (!isPathInsideRoot(realTarget, realRoot)) {
        throw new Error("Path is outside the allowed filesystem roots.");
    }

    return {
        requested: requestedPath,
        resolved,
        real: realTarget,
        stats,
        root: logicalRoot,
    };
}


/**
 * Resolve a destination that may not exist yet.
 * Validates the logical path, then the nearest existing parent's
 * real location. Refuses overwrites.
 *
 * @param {string} requestedPath
 */
export async function resolveNewPath(requestedPath) {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
        throw new Error("Path is required.");
    }

    const roots = getAllowedRoots();
    const resolved = path.resolve(requestedPath);
    const logicalRoot = findMatchingRoot(resolved, roots);

    if (!logicalRoot) {
        throw new Error("Path is outside the allowed filesystem roots.");
    }

    const existing = await lstatIfExists(resolved);

    if (existing) {
        throw new Error("Destination already exists.");
    }

    let parent = path.dirname(resolved);

    while (true) {
        const parentStats = await lstatIfExists(parent);

        if (parentStats) {
            await assertNoSymlinkComponents(parent);

            if (parentStats.isSymbolicLink()) {
                throw new Error("Symbolic links are not allowed.");
            }

            const realParent = await fs.realpath(parent);
            const realRoot = await fs.realpath(logicalRoot);

            if (!isPathInsideRoot(realParent, realRoot)) {
                throw new Error("Path is outside the allowed filesystem roots.");
            }

            return {
                requested: requestedPath,
                resolved,
                parent,
                realParent,
                root: logicalRoot,
            };
        }

        const next = path.dirname(parent);

        if (next === parent) {
            throw new Error("Path is outside the allowed filesystem roots.");
        }

        parent = next;
    }
}


export function isSensitiveFilename(filename) {
    const name = path.basename(filename).toLowerCase();

    if (name === ".env" || name.startsWith(".env.")) {
        return true;
    }

    if (name.endsWith(".pem") || name.endsWith(".key")) {
        return true;
    }

    if (name === "id_rsa" || name === "id_ed25519") {
        return true;
    }

    return false;
}


export function toDisplayPath(absolutePath) {
    const roots = getAllowedRoots();
    const match = findMatchingRoot(absolutePath, roots);

    if (!match) {
        return path.basename(absolutePath);
    }

    const relative = path.relative(match, absolutePath);
    return relative || ".";
}
