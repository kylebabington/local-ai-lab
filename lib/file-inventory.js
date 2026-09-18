// =========================================================
// lib/file-inventory.js
//
// File Intelligence: selected roots, safe metadata scanning,
// persistence, and filename/path search.
//
// Authority is persisted file roots — NOT Computer mode's
// LOCAL_AI_ALLOWED_ROOTS. No content reads, embeddings, or
// filesystem mutations inside user folders.
// =========================================================


import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
    isFileInventoryScanning,
    runFileIntelligenceMutation,
} from "./file-intelligence-state.js";
import {
    isPathInsideRoot,
    isSensitiveFilename,
} from "./tools/path-safety.js";


export const MAX_SCAN_DEPTH = 20;
export const MAX_INVENTORY_FILES = 50_000;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const ROOTS_ENV = "LOCAL_AI_FILE_ROOTS_PATH";
const INVENTORY_ENV = "LOCAL_AI_FILE_INVENTORY_PATH";

const IGNORED_DIR_NAMES = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".vercel",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    "$recycle.bin",
    "system volume information",
    ".trash",
]);


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


function rootsPath() {
    const override = process.env[ROOTS_ENV];
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }
    return path.resolve(process.cwd(), "data", "file-roots.json");
}


function inventoryPath() {
    const override = process.env[INVENTORY_ENV];
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }
    return path.resolve(process.cwd(), "data", "file-inventory.json");
}


function rootIdForRealPath(realPath) {
    return crypto
        .createHash("sha256")
        .update(normalizeCompare(realPath))
        .digest("hex")
        .slice(0, 16);
}


function isFilesystemRoot(resolvedPath) {
    return normalizeCompare(resolvedPath) === normalizeCompare(path.parse(resolvedPath).root);
}


function isIgnoredDirectoryName(name) {
    return IGNORED_DIR_NAMES.has(name.toLowerCase());
}


function emptySummary() {
    return {
        fileCount: 0,
        totalBytes: 0,
        skippedCount: 0,
        errorCount: 0,
        truncated: false,
        truncationReason: null,
    };
}


function emptyInventory() {
    return {
        version: 1,
        scannedAt: null,
        roots: [],
        summary: emptySummary(),
        files: [],
    };
}


function emptyRootsDoc() {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        roots: [],
    };
}


function recomputeSummary(files, base = {}) {
    let totalBytes = 0;
    for (const file of files) {
        totalBytes += file.size ?? 0;
    }

    return {
        fileCount: files.length,
        totalBytes,
        skippedCount: base.skippedCount ?? 0,
        errorCount: base.errorCount ?? 0,
        truncated: Boolean(base.truncated),
        truncationReason: base.truncationReason ?? null,
    };
}


async function ensureParentDir(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
}


async function atomicWriteJson(filePath, value) {
    await ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const json = `${JSON.stringify(value, null, 2)}\n`;

    try {
        await fs.writeFile(tempPath, json, "utf8");
        await fs.rename(tempPath, filePath);
    } catch (error) {
        try {
            await fs.unlink(tempPath);
        } catch {
            // ignore cleanup failure
        }
        throw error;
    }
}


async function readJsonFile(filePath, label) {
    let raw;

    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(`Malformed ${label}: file is not valid JSON.`);
    }
}


async function loadRootsDoc() {
    const data = await readJsonFile(rootsPath(), "file-roots.json");

    if (data === null) {
        return emptyRootsDoc();
    }

    if (
        typeof data !== "object" ||
        data === null ||
        !Array.isArray(data.roots)
    ) {
        throw new Error("Malformed file-roots.json: expected an object with a roots array.");
    }

    return {
        version: 1,
        updatedAt:
            typeof data.updatedAt === "string"
                ? data.updatedAt
                : new Date().toISOString(),
        roots: data.roots,
    };
}


async function saveRootsDoc(doc) {
    await atomicWriteJson(rootsPath(), {
        version: 1,
        updatedAt: new Date().toISOString(),
        roots: doc.roots,
    });
}


async function loadInventoryDoc() {
    const data = await readJsonFile(inventoryPath(), "file-inventory.json");

    if (data === null) {
        return null;
    }

    if (
        typeof data !== "object" ||
        data === null ||
        !Array.isArray(data.files)
    ) {
        throw new Error(
            "Malformed file-inventory.json: expected an object with a files array.",
        );
    }

    return data;
}


async function saveInventoryDoc(doc) {
    await atomicWriteJson(inventoryPath(), doc);
}


/**
 * Validate and normalize a candidate File Intelligence root.
 * Requires an explicitly absolute path.
 *
 * @param {string} requestedPath
 */
export async function validateFileRoot(requestedPath) {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
        throw new Error("Path is required.");
    }

    const trimmed = requestedPath.trim();

    if (!path.isAbsolute(trimmed)) {
        throw new Error("File Intelligence root must be an absolute path.");
    }

    const resolved = path.resolve(trimmed);

    let stats;
    try {
        stats = await fs.lstat(resolved);
    } catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("Path does not exist.");
        }
        throw new Error(`Could not access path: ${error.message}`);
    }

    if (!stats.isDirectory()) {
        throw new Error("Path must be a directory.");
    }

    if (stats.isSymbolicLink()) {
        throw new Error("File Intelligence root cannot be a symbolic link or junction.");
    }

    const realPath = await fs.realpath(resolved);

    if (isFilesystemRoot(realPath) || isFilesystemRoot(resolved)) {
        throw new Error(
            "File Intelligence root cannot be a filesystem or volume root.",
        );
    }

    return {
        id: rootIdForRealPath(realPath),
        path: resolved,
        realPath,
    };
}


function findOverlap(existingRoots, candidate) {
    const candidateNorm = normalizeCompare(candidate.realPath);

    for (const root of existingRoots) {
        const existingNorm = normalizeCompare(root.realPath);

        if (existingNorm === candidateNorm) {
            return {
                kind: "duplicate",
                message: `This folder is already configured as a File Intelligence root (${root.path}).`,
            };
        }

        if (isPathInsideRoot(candidate.realPath, root.realPath)) {
            return {
                kind: "overlap",
                message: `This folder is inside an existing File Intelligence root (${root.path}). Remove the parent root first, or choose a different folder.`,
            };
        }

        if (isPathInsideRoot(root.realPath, candidate.realPath)) {
            return {
                kind: "overlap",
                message: `An existing File Intelligence root (${root.path}) is inside this folder. Remove the nested root first, or choose a different folder.`,
            };
        }
    }

    return null;
}


export async function listRoots() {
    const doc = await loadRootsDoc();
    return doc.roots;
}


/**
 * Read-only inventory snapshot for content indexing / status.
 * @returns {Promise<object | null>}
 */
export async function getInventory() {
    return loadInventoryDoc();
}


export async function addRoot(requestedPath) {
    return runFileIntelligenceMutation("addRoot", async () => {
        const candidate = await validateFileRoot(requestedPath);
        const doc = await loadRootsDoc();
        const overlap = findOverlap(doc.roots, candidate);

        if (overlap) {
            throw new Error(overlap.message);
        }

        doc.roots.push(candidate);
        await saveRootsDoc(doc);
        return candidate;
    });
}


export async function removeRoot(rootId) {
    return runFileIntelligenceMutation("removeRoot", async () => {
        if (typeof rootId !== "string" || !rootId.trim()) {
            throw new Error("Root id is required.");
        }

        const id = rootId.trim();
        const doc = await loadRootsDoc();
        const index = doc.roots.findIndex((root) => root.id === id);

        if (index === -1) {
            throw new Error("Unknown File Intelligence root.");
        }

        const [removed] = doc.roots.splice(index, 1);
        await saveRootsDoc(doc);

        const inventory = await loadInventoryDoc();

        if (inventory) {
            const remaining = inventory.files.filter((file) => file.rootId !== id);
            const next = {
                ...inventory,
                version: 1,
                roots: doc.roots,
                files: remaining,
                summary: recomputeSummary(remaining, {
                    skippedCount: 0,
                    errorCount: 0,
                    truncated: false,
                    truncationReason: null,
                }),
            };
            await saveInventoryDoc(next);
        }

        // Immediate content-index prune while still holding the
        // shared File Intelligence lock (no nested acquisition).
        const { pruneFileContentIndexForRoot } = await import("./file-content.js");
        await pruneFileContentIndexForRoot(id);

        return removed;
    });
}


/**
 * @param {object} [options]
 * @param {number} [options.maxScanDepth]
 * @param {number} [options.maxInventoryFiles]
 */
export async function scanInventory(options = {}) {
    return runFileIntelligenceMutation("scan", async () => {
        const maxDepth =
            Number.isInteger(options.maxScanDepth) && options.maxScanDepth > 0
                ? options.maxScanDepth
                : MAX_SCAN_DEPTH;
        const maxFiles =
            Number.isInteger(options.maxInventoryFiles) &&
            options.maxInventoryFiles > 0
                ? options.maxInventoryFiles
                : MAX_INVENTORY_FILES;

        const rootsDoc = await loadRootsDoc();

        if (rootsDoc.roots.length === 0) {
            throw new Error(
                "Add at least one File Intelligence folder before scanning.",
            );
        }

        const files = [];
        let skippedCount = 0;
        let errorCount = 0;
        let truncated = false;
        let truncationReason = null;

        for (const root of rootsDoc.roots) {
            if (truncated) {
                break;
            }

            const walkResult = await walkRoot(root, {
                maxDepth,
                maxFiles,
                files,
                skippedCount,
                errorCount,
            });

            skippedCount = walkResult.skippedCount;
            errorCount = walkResult.errorCount;

            if (walkResult.truncated) {
                truncated = true;
                truncationReason = walkResult.truncationReason;
            }
        }

        const summary = {
            fileCount: files.length,
            totalBytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
            skippedCount,
            errorCount,
            truncated,
            truncationReason,
        };

        const inventory = {
            version: 1,
            scannedAt: new Date().toISOString(),
            roots: rootsDoc.roots,
            summary,
            files,
        };

        await saveInventoryDoc(inventory);
        return summary;
    });
}


async function walkRoot(root, state) {
    const stack = [{ dirPath: root.realPath, depth: 0 }];
    let truncated = false;
    let truncationReason = null;

    while (stack.length > 0) {
        if (state.files.length >= state.maxFiles) {
            return {
                skippedCount: state.skippedCount,
                errorCount: state.errorCount,
                truncated: true,
                truncationReason: `Inventory file limit reached (${state.maxFiles}).`,
            };
        }

        const { dirPath, depth } = stack.pop();

        let entries;
        try {
            entries = await fs.readdir(dirPath, { withFileTypes: true });
        } catch {
            state.errorCount += 1;
            continue;
        }

        for (const entry of entries) {
            if (state.files.length >= state.maxFiles) {
                return {
                    skippedCount: state.skippedCount,
                    errorCount: state.errorCount,
                    truncated: true,
                    truncationReason: `Inventory file limit reached (${state.maxFiles}).`,
                };
            }

            const absolutePath = path.join(dirPath, entry.name);

            let stats;
            try {
                stats = await fs.lstat(absolutePath);
            } catch {
                state.errorCount += 1;
                continue;
            }

            if (stats.isSymbolicLink()) {
                state.skippedCount += 1;
                continue;
            }

            if (stats.isDirectory()) {
                if (isIgnoredDirectoryName(entry.name)) {
                    state.skippedCount += 1;
                    continue;
                }

                if (depth + 1 > state.maxDepth) {
                    state.skippedCount += 1;
                    if (!truncated) {
                        truncated = true;
                        truncationReason = `Scan depth limit reached (${state.maxDepth}).`;
                    }
                    continue;
                }

                let realChild;
                try {
                    realChild = await fs.realpath(absolutePath);
                } catch {
                    state.errorCount += 1;
                    continue;
                }

                if (!isPathInsideRoot(realChild, root.realPath)) {
                    state.skippedCount += 1;
                    continue;
                }

                stack.push({ dirPath: realChild, depth: depth + 1 });
                continue;
            }

            if (!stats.isFile()) {
                state.skippedCount += 1;
                continue;
            }

            if (isSensitiveFilename(entry.name)) {
                state.skippedCount += 1;
                continue;
            }

            let realFile;
            try {
                realFile = await fs.realpath(absolutePath);
            } catch {
                state.errorCount += 1;
                continue;
            }

            if (!isPathInsideRoot(realFile, root.realPath)) {
                state.skippedCount += 1;
                continue;
            }

            const relativePath = path.relative(root.realPath, realFile);
            const extension = path.extname(entry.name).replace(/^\./, "").toLowerCase();
            const mtimeMs = stats.mtimeMs;

            state.files.push({
                rootId: root.id,
                absolutePath: realFile,
                relativePath,
                name: entry.name,
                extension,
                size: stats.size,
                mtimeMs,
                modifiedAt: new Date(mtimeMs).toISOString(),
                fingerprint: `${stats.size}:${mtimeMs}`,
            });
        }
    }

    return {
        skippedCount: state.skippedCount,
        errorCount: state.errorCount,
        truncated,
        truncationReason,
    };
}


export async function getStatus() {
    const roots = await listRoots();
    const inventory = await loadInventoryDoc();
    const summary = inventory?.summary ?? emptySummary();

    return {
        roots,
        rootCount: roots.length,
        inventoryExists: inventory !== null && inventory.scannedAt != null,
        scannedAt: inventory?.scannedAt ?? null,
        fileCount: summary.fileCount ?? 0,
        totalBytes: summary.totalBytes ?? 0,
        skippedCount: summary.skippedCount ?? 0,
        errorCount: summary.errorCount ?? 0,
        truncated: Boolean(summary.truncated),
        truncationReason: summary.truncationReason ?? null,
        scanning: isFileInventoryScanning(),
    };
}


/**
 * @param {object} [params]
 * @param {string} [params.query]
 * @param {string} [params.rootId]
 * @param {string} [params.extension]
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @param {string} [params.sort]
 * @param {string} [params.direction]
 */
export async function searchInventory(params = {}) {
    const inventory = await loadInventoryDoc();
    const files = inventory?.files ?? [];

    const query =
        typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
    const rootId =
        typeof params.rootId === "string" && params.rootId.trim()
            ? params.rootId.trim()
            : null;
    const extensionRaw =
        typeof params.extension === "string" ? params.extension.trim() : "";
    const extension = extensionRaw
        ? extensionRaw.replace(/^\./, "").toLowerCase()
        : null;

    let filtered = files;

    if (rootId) {
        filtered = filtered.filter((file) => file.rootId === rootId);
    }

    if (extension) {
        filtered = filtered.filter((file) => file.extension === extension);
    }

    if (query) {
        filtered = filtered.filter((file) => {
            const name = String(file.name ?? "").toLowerCase();
            const relative = String(file.relativePath ?? "").toLowerCase();
            return name.includes(query) || relative.includes(query);
        });
    }

    const sort = ["name", "modified", "size"].includes(params.sort)
        ? params.sort
        : "name";
    const direction = params.direction === "desc" ? "desc" : "asc";
    const dirMul = direction === "desc" ? -1 : 1;

    filtered = [...filtered].sort((a, b) => {
        let cmp = 0;

        if (sort === "size") {
            cmp = (a.size ?? 0) - (b.size ?? 0);
        } else if (sort === "modified") {
            cmp = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
        } else {
            cmp = String(a.name ?? "").localeCompare(
                String(b.name ?? ""),
                undefined,
                { sensitivity: "base" },
            );
        }

        if (cmp === 0) {
            cmp = String(a.relativePath ?? "").localeCompare(
                String(b.relativePath ?? ""),
                undefined,
                { sensitivity: "base" },
            );
        }

        return cmp * dirMul;
    });

    const total = filtered.length;
    let limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1) {
        limit = DEFAULT_LIMIT;
    }
    limit = Math.min(limit, MAX_LIMIT);

    let offset = Number(params.offset);
    if (!Number.isInteger(offset) || offset < 0) {
        offset = 0;
    }

    const page = filtered.slice(offset, offset + limit);

    return {
        total,
        offset,
        limit,
        files: page,
    };
}


/** Test helpers — not for production routes. */
export const _test = {
    rootsPath,
    inventoryPath,
    normalizeCompare,
    isFilesystemRoot,
    MAX_LIMIT,
    DEFAULT_LIMIT,
};
