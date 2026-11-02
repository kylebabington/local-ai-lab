// =========================================================
// lib/tools/storage.js
//
// Read-only disk inspection inside temporary scan grants.
// Does not use LOCAL_AI_ALLOWED_ROOTS. Never deletes.
// =========================================================


import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    isPathInsideRoot,
    resolveExistingPath,
} from "./path-safety.js";
import {
    addSessionGrant,
    beginSessionScan,
    endSessionScan,
    findGrantForPath,
    getGrantRoots,
    getLastDiscovery,
    isSessionScanning,
    listSessionGrants,
    listSuggestedScanFolders,
    setLastDiscovery,
} from "../storage-session.js";


export const NO_SCAN_GRANT_MESSAGE =
    "No storage scan folders are authorized. Select a folder in the Computer scan panel first.";

export const VOLUME_ROOT_MESSAGE =
    "A whole drive cannot be scanned. Choose a specific folder.";

export const PROFILE_ROOT_MESSAGE =
    "The user profile folder is too broad. Choose a specific folder such as Downloads.";

export const PROTECTED_LOCATION_MESSAGE =
    "That location is protected and cannot be scanned.";

export const DEFAULT_MAX_DEPTH = 6;
export const MAX_SCAN_DEPTH = 8;
export const DEFAULT_MAX_ENTRIES = 8_000;
export const MAX_SCAN_ENTRIES = 20_000;
export const DEFAULT_MAX_MS = 15_000;
export const MAX_SCAN_MS = 30_000;
export const TOP_RESULTS = 15;

const SKIP_DIRECTORY_NAMES = new Set([
    "windows",
    "system32",
    "winsxs",
    "appdata",
    "$recycle.bin",
    "system volume information",
    "recovery",
    ".ssh",
    ".gnupg",
    "program files",
    "program files (x86)",
    "programdata",
]);

const CACHE_DIRECTORY_NAMES = new Set([
    "temp",
    "tmp",
    "cache",
    "caches",
    "node_modules",
    ".cache",
    ".npm",
    ".nuxt",
    "__pycache__",
]);


function isPlainObject(value) {
    return Boolean(value) && typeof value !== "undefined" && typeof value === "object" && !Array.isArray(value);
}


function rejectUnknownKeys(args, allowed) {
    const extra = Object.keys(args).filter((key) => !allowed.includes(key));

    if (extra.length > 0) {
        throw new Error(`Unexpected argument(s): ${extra.join(", ")}.`);
    }
}


function requireString(args, field, maxLength = 4096) {
    const value = args[field];

    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`"${field}" must be a non-empty string.`);
    }

    const trimmed = value.trim();

    if (trimmed.length > maxLength) {
        throw new Error(`"${field}" is too long.`);
    }

    return trimmed;
}


function optionalInteger(args, field, fallback, min, max) {
    if (!(field in args) || args[field] === undefined) {
        return fallback;
    }

    const value = args[field];

    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`"${field}" must be an integer.`);
    }

    if (value < min || value > max) {
        throw new Error(`"${field}" must be between ${min} and ${max}.`);
    }

    return value;
}


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


export function isFilesystemRoot(filePath) {
    const resolved = path.resolve(filePath);
    const parsed = path.parse(resolved);
    return normalizeCompare(resolved) === normalizeCompare(parsed.root);
}


function protectedPrefixes() {
    const prefixes = [];
    const home = os.homedir();
    const parsedHome = path.parse(home);
    const driveRoot = parsedHome.root || (process.platform === "win32" ? "C:\\" : "/");

    prefixes.push(
        path.join(driveRoot, "Windows"),
        path.join(driveRoot, "Program Files"),
        path.join(driveRoot, "Program Files (x86)"),
        path.join(driveRoot, "ProgramData"),
        path.join(driveRoot, "$Recycle.Bin"),
        path.join(driveRoot, "System Volume Information"),
        path.join(driveRoot, "Recovery"),
        path.join(home, "AppData"),
        path.join(home, "AppData", "Roaming"),
        path.join(home, "AppData", "Local"),
        path.join(home, "AppData", "LocalLow"),
    );

    if (process.platform === "win32") {
        prefixes.push(
            path.join(driveRoot, "Users", "Default"),
            path.join(driveRoot, "Users", "Public", "AccountPictures"),
        );
    }

    return prefixes;
}


export function describeProtectedReason(resolvedPath) {
    if (isFilesystemRoot(resolvedPath)) {
        return VOLUME_ROOT_MESSAGE;
    }

    if (normalizeCompare(resolvedPath) === normalizeCompare(os.homedir())) {
        return PROFILE_ROOT_MESSAGE;
    }

    for (const prefix of protectedPrefixes()) {
        if (isPathInsideRoot(resolvedPath, prefix)) {
            return PROTECTED_LOCATION_MESSAGE;
        }
    }

    return null;
}


async function lstatSafe(filePath) {
    try {
        return await fs.lstat(filePath);
    } catch {
        return null;
    }
}


export async function assertGrantablePath(requestedPath) {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
        throw new Error("Path is required.");
    }

    const trimmed = requestedPath.trim();

    if (/^[A-Za-z]:[\\/]?$/.test(trimmed) || trimmed === path.sep) {
        throw new Error(VOLUME_ROOT_MESSAGE);
    }

    if (!path.isAbsolute(trimmed)) {
        throw new Error("Scan folders must be absolute paths.");
    }

    const resolved = path.resolve(trimmed);
    const stats = await lstatSafe(resolved);

    if (!stats) {
        throw new Error("Path does not exist.");
    }

    if (stats.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed.");
    }

    if (!stats.isDirectory()) {
        throw new Error("Path must be a directory.");
    }

    const realPath = await fs.realpath(resolved);
    const reason = describeProtectedReason(realPath) ?? describeProtectedReason(resolved);

    if (reason) {
        throw new Error(reason);
    }

    return {
        path: resolved,
        realPath,
    };
}


export async function grantScanFolder(requestedPath) {
    const candidate = await assertGrantablePath(requestedPath);
    const grant = addSessionGrant(candidate);
    return publicGrantView(grant);
}


function publicGrantView(grant) {
    return {
        id: grant.id,
        path: grant.path,
        addedAt: new Date(grant.addedAt).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
    };
}


export function validateInspectDiskUsage(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, ["path", "maxDepth", "maxEntries", "maxMs"]);

    return {
        path: requireString(args, "path"),
        maxDepth: optionalInteger(args, "maxDepth", DEFAULT_MAX_DEPTH, 0, MAX_SCAN_DEPTH),
        maxEntries: optionalInteger(
            args,
            "maxEntries",
            DEFAULT_MAX_ENTRIES,
            1,
            MAX_SCAN_ENTRIES,
        ),
        maxMs: optionalInteger(args, "maxMs", DEFAULT_MAX_MS, 1_000, MAX_SCAN_MS),
    };
}


export function validateRequestStorageScan(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, ["path", "reason"]);

    return {
        path: requireString(args, "path"),
        reason: requireString(args, "reason", 500),
    };
}


export async function requestStorageScan(args) {
    const grant = await grantScanFolder(args.path);
    return {
        granted: true,
        grant,
        message: "Read-only scan access granted for this session only.",
    };
}


function shouldSkipDirectoryName(name) {
    return SKIP_DIRECTORY_NAMES.has(name.toLowerCase());
}


function isCacheName(name) {
    return CACHE_DIRECTORY_NAMES.has(name.toLowerCase());
}


function keepTop(list, item, key) {
    list.push(item);
    list.sort((left, right) => (right[key] ?? 0) - (left[key] ?? 0));
    if (list.length > TOP_RESULTS) {
        list.length = TOP_RESULTS;
    }
}


export async function inspectDiskUsage(args) {
    const { path: requestedPath, maxDepth, maxEntries, maxMs } =
        validateInspectDiskUsage(args ?? {});

    const grantRoots = getGrantRoots();

    if (grantRoots.length === 0) {
        throw Object.assign(new Error(NO_SCAN_GRANT_MESSAGE), {
            code: "NO_GRANT",
        });
    }

    const grant = findGrantForPath(requestedPath);

    if (!grant) {
        throw Object.assign(
            new Error("That folder is not in the current scan session. Grant access first."),
            { code: "NO_GRANT" },
        );
    }

    const target = await resolveExistingPath(requestedPath, {
        roots: grantRoots,
        outsideMessage:
            "That folder is not in the current scan session. Grant access first.",
    });

    if (!target.stats.isDirectory()) {
        throw new Error("Path must be a directory.");
    }

    const protectedReason =
        describeProtectedReason(target.real) ?? describeProtectedReason(target.resolved);

    if (protectedReason) {
        throw new Error(protectedReason);
    }

    const signal = beginSessionScan();
    const started = Date.now();
    const largestDirectories = [];
    const largestFiles = [];
    const possibleCaches = [];
    const dirBytes = new Map();

    let filesVisited = 0;
    let directoriesVisited = 0;
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let limit = null;

    function hitLimit(kind) {
        truncated = true;
        limit = kind;
        if (kind === "time") {
            timedOut = true;
        }
        if (kind === "cancelled") {
            cancelled = true;
        }
    }

    async function walk(directory, depth, grantRoot) {
        if (signal.aborted) {
            hitLimit("cancelled");
            return;
        }

        if (Date.now() - started > maxMs) {
            hitLimit("time");
            return;
        }

        if (filesVisited + directoriesVisited >= maxEntries) {
            hitLimit("entries");
            return;
        }

        let dirents;

        try {
            dirents = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }

        directoriesVisited += 1;
        let localBytes = 0;

        for (const dirent of dirents) {
            if (signal.aborted) {
                hitLimit("cancelled");
                return;
            }

            if (Date.now() - started > maxMs) {
                hitLimit("time");
                return;
            }

            if (filesVisited + directoriesVisited >= maxEntries) {
                hitLimit("entries");
                return;
            }

            if (dirent.isSymbolicLink()) {
                continue;
            }

            const absolute = path.join(directory, dirent.name);

            if (shouldSkipDirectoryName(dirent.name)) {
                continue;
            }

            if (dirent.isDirectory()) {
                if (depth >= maxDepth) {
                    hitLimit("depth");
                    continue;
                }

                let realChild;

                try {
                    const childStats = await fs.lstat(absolute);
                    if (childStats.isSymbolicLink()) {
                        continue;
                    }
                    realChild = await fs.realpath(absolute);
                } catch {
                    continue;
                }

                if (!isPathInsideRoot(realChild, grantRoot)) {
                    throw new Error("Symbolic links are not allowed.");
                }

                await walk(realChild, depth + 1, grantRoot);
                localBytes += dirBytes.get(realChild) ?? 0;
                continue;
            }

            if (!dirent.isFile()) {
                continue;
            }

            const stats = await lstatSafe(absolute);

            if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
                continue;
            }

            filesVisited += 1;
            const size = Number.isFinite(stats.size) ? stats.size : 0;
            localBytes += size;
            totalBytes += size;

            keepTop(
                largestFiles,
                {
                    name: dirent.name,
                    path: absolute,
                    sizeBytes: size,
                },
                "sizeBytes",
            );
        }

        dirBytes.set(directory, localBytes);
        keepTop(
            largestDirectories,
            {
                name: path.basename(directory) || directory,
                path: directory,
                sizeBytes: localBytes,
                possibleCache: isCacheName(path.basename(directory)),
            },
            "sizeBytes",
        );

        if (isCacheName(path.basename(directory)) && localBytes > 0) {
            keepTop(
                possibleCaches,
                {
                    name: path.basename(directory),
                    path: directory,
                    sizeBytes: localBytes,
                },
                "sizeBytes",
            );
        }
    }

    try {
        await walk(target.real, 0, grant.realPath);
    } finally {
        endSessionScan();
    }

    const complete = !truncated && !timedOut && !cancelled;
    const queriedAt = new Date().toISOString();
    const result = {
        untrusted: true,
        tool: "inspect_disk_usage",
        path: target.resolved,
        grantId: grant.id,
        complete,
        incomplete: complete
            ? null
            : {
                  truncated,
                  timedOut,
                  cancelled,
                  limit,
              },
        filesVisited,
        directoriesVisited,
        totalBytes,
        elapsedMs: Date.now() - started,
        maxDepth,
        maxEntries,
        maxMs,
        largestDirectories,
        largestFiles,
        possibleCaches,
        interpretationLimits: [
            "This listing is only the granted folder, not the whole drive.",
            "possibleCache names are heuristics. They are not proof that files are unused or safe to move.",
            "Incomplete scans must not be treated as a full inventory.",
        ],
    };

    setLastDiscovery({
        path: target.resolved,
        complete,
        filesVisited,
        directoriesVisited,
        totalBytes,
        truncated,
        timedOut,
        cancelled,
        queriedAt,
    });

    return result;
}


async function suggestionAvailability(suggestion) {
    const stats = await lstatSafe(suggestion.path);

    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
        return { ...suggestion, available: false };
    }

    const reason = describeProtectedReason(suggestion.path);
    if (reason) {
        return { ...suggestion, available: false };
    }

    return { ...suggestion, available: true };
}


export async function describeStorageSession() {
    const suggestions = await Promise.all(
        listSuggestedScanFolders().map(suggestionAvailability),
    );

    return {
        grants: listSessionGrants(),
        suggestions,
        discovery: getLastDiscovery(),
        scanning: isSessionScanning(),
    };
}
