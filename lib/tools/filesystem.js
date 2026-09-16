// =========================================================
// lib/tools/filesystem.js
//
// Actual filesystem operations. Callers must already have
// validated permission. This module still re-checks paths.
// =========================================================


import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
    getAllowedRoots,
    resolveExistingPath,
    resolveNewPath,
    isSensitiveFilename,
    toDisplayPath,
} from "./path-safety.js";


const MAX_LIST_RESULTS = 500;
const MAX_RECURSION_DEPTH = 4;
const MAX_SEARCH_RESULTS = 50;
const MAX_READ_BYTES = 250_000;


async function lstatSafe(filePath) {
    try {
        return await fs.lstat(filePath);
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "EACCES") {
            return null;
        }

        throw error;
    }
}


export async function listDirectory(args) {
    const target = await resolveExistingPath(args.path);

    if (!target.stats.isDirectory()) {
        throw new Error("Path is not a directory.");
    }

    const recursive = args.recursive === true;
    const requestedDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 2;
    const maxDepth = Math.min(
        Math.max(requestedDepth, 0),
        MAX_RECURSION_DEPTH,
    );

    const entries = [];
    let truncated = false;

    async function walk(directory, depth) {
        if (entries.length >= MAX_LIST_RESULTS) {
            truncated = true;
            return;
        }

        let dirents;

        try {
            dirents = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const dirent of dirents) {
            if (entries.length >= MAX_LIST_RESULTS) {
                truncated = true;
                return;
            }

            const absolute = path.join(directory, dirent.name);

            if (dirent.isSymbolicLink()) {
                continue;
            }

            if (dirent.isDirectory()) {
                entries.push({
                    name: dirent.name,
                    path: toDisplayPath(absolute),
                    type: "directory",
                });

                if (recursive && depth < maxDepth) {
                    await walk(absolute, depth + 1);
                }

                continue;
            }

            if (!dirent.isFile()) {
                continue;
            }

            const stats = await lstatSafe(absolute);

            entries.push({
                name: dirent.name,
                path: toDisplayPath(absolute),
                type: "file",
                size: stats?.size ?? null,
            });
        }
    }

    await walk(target.real, 0);

    return {
        path: toDisplayPath(target.real),
        recursive,
        truncated,
        entries,
    };
}


export async function getFileInfo(args) {
    const target = await resolveExistingPath(args.path);
    const type = target.stats.isDirectory()
        ? "directory"
        : target.stats.isFile()
            ? "file"
            : "other";

    return {
        name: path.basename(target.real),
        path: toDisplayPath(target.real),
        type,
        extension: type === "file" ? path.extname(target.real) : null,
        size: target.stats.size,
        modifiedAt: target.stats.mtime.toISOString(),
    };
}


export async function searchFiles(args) {
    const rootTarget = await resolveExistingPath(args.root);
    const query = String(args.query).toLowerCase();
    const requestedMax = Number.isInteger(args.maxResults) ? args.maxResults : 50;
    const maxResults = Math.min(Math.max(requestedMax, 1), MAX_SEARCH_RESULTS);

    if (!rootTarget.stats.isDirectory()) {
        throw new Error("Search root is not a directory.");
    }

    const matches = [];
    let truncated = false;

    async function walk(directory, depth) {
        if (matches.length >= maxResults || depth > MAX_RECURSION_DEPTH + 8) {
            if (matches.length >= maxResults) {
                truncated = true;
            }
            return;
        }

        let dirents;

        try {
            dirents = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const dirent of dirents) {
            if (matches.length >= maxResults) {
                truncated = true;
                return;
            }

            if (dirent.isSymbolicLink()) {
                continue;
            }

            const absolute = path.join(directory, dirent.name);
            const display = toDisplayPath(absolute);
            const haystack = `${dirent.name} ${display}`.toLowerCase();

            if (haystack.includes(query)) {
                matches.push({
                    name: dirent.name,
                    path: display,
                    type: dirent.isDirectory() ? "directory" : "file",
                });
            }

            if (dirent.isDirectory()) {
                await walk(absolute, depth + 1);
            }
        }
    }

    await walk(rootTarget.real, 0);

    return {
        query: args.query,
        root: toDisplayPath(rootTarget.real),
        truncated,
        matches,
    };
}


export async function readTextFile(args) {
    const target = await resolveExistingPath(args.path);

    if (!target.stats.isFile()) {
        throw new Error("Path is not a file.");
    }

    if (isSensitiveFilename(target.real)) {
        throw new Error("Reading that file is blocked.");
    }

    if (target.stats.size > MAX_READ_BYTES) {
        throw new Error(
            `File is too large to read. Maximum size is ${MAX_READ_BYTES} bytes.`,
        );
    }

    const buffer = await fs.readFile(target.real);

    if (buffer.includes(0)) {
        throw new Error("File looks binary and will not be returned.");
    }

    let content = buffer.toString("utf8");
    let truncated = false;

    if (content.length > MAX_READ_BYTES) {
        content = content.slice(0, MAX_READ_BYTES);
        truncated = true;
    }

    return {
        path: toDisplayPath(target.real),
        truncated,
        content,
    };
}


export async function createDirectory(args) {
    const dest = await resolveNewPath(args.path);
    await fs.mkdir(dest.resolved, { recursive: false });

    return {
        path: toDisplayPath(dest.resolved),
        created: true,
    };
}


export async function copyFile(args) {
    const source = await resolveExistingPath(args.source);

    if (!source.stats.isFile()) {
        throw new Error("Source is not a file.");
    }

    const dest = await resolveNewPath(args.destination);
    await fs.copyFile(source.real, dest.resolved, fsConstants.COPYFILE_EXCL);

    return {
        source: toDisplayPath(source.real),
        destination: toDisplayPath(dest.resolved),
        copied: true,
    };
}


export async function moveFile(args) {
    const source = await resolveExistingPath(args.source);

    if (!source.stats.isFile()) {
        throw new Error("Source is not a file.");
    }

    const dest = await resolveNewPath(args.destination);
    await fs.rename(source.real, dest.resolved);

    return {
        source: toDisplayPath(source.real),
        destination: toDisplayPath(dest.resolved),
        moved: true,
    };
}


export async function renameFile(args) {
    return moveFile({
        source: args.source,
        destination: args.destination,
    });
}


export function getPublicRoots() {
    return getAllowedRoots();
}
