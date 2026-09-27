// =========================================================
// lib/tools/file-intelligence.js
//
// Read-only Computer adapter over the File Intelligence
// content index (Phase 4C).
//
// File Intelligence = knowledge/search authority.
// Computer allowed roots = live filesystem/action authority.
//
// This module never reads file bytes from disk. It serves the
// indexed snapshot only, and uses the Computer path-safety layer
// solely to report whether a live path is Computer-accessible.
// =========================================================


import crypto from "node:crypto";
import path from "node:path";

import {
    CONTENT_EXTRACTOR_VERSION,
    loadFileContentIndex,
    searchFileContent,
} from "../file-content.js";
import { isSensitiveFilename, resolveExistingPath } from "./path-safety.js";


export const FILE_REF_PATTERN = /^idxf_[0-9a-f]{32}$/;
export const SEARCH_DEFAULT_RESULTS = 6;
export const SEARCH_MAX_RESULTS = 10;
export const GET_DEFAULT_CHUNKS = 4;
export const GET_MAX_CHUNKS = 6;
export const GET_MAX_TOTAL_CHARS = 14_000;
export const EXCERPT_MAX_CHARS = 1_600;

const SEARCHABLE_STATUSES = new Set(["indexed", "reused"]);

const MSG_INDEX_UNAVAILABLE =
    "File content index is not available. Scan and index files first.";
const MSG_INDEX_REBUILD =
    "File content index must be rebuilt before it can be searched.";
const MSG_SEARCH_UNAVAILABLE =
    "File Intelligence search is temporarily unavailable.";
const MSG_INDEX_CHANGED =
    "File Intelligence index changed during search. Try again.";
const MSG_STALE_REF = "Unknown or stale indexed file reference.";
const MSG_NO_CHUNKS = "No indexed chunks are available for that file.";


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


function safeError(message) {
    return new Error(message);
}


/**
 * Opaque, one-way reference for the CURRENT indexed identity of a file.
 * Changes whenever the indexed fingerprint, extractor, or embedding model does.
 */
export function computeFileRef({
    rootId,
    absolutePath,
    fingerprint,
    extractorVersion,
    embeddingModel,
}) {
    const digest = crypto
        .createHash("sha256")
        .update(
            [
                "idxf",
                "v1",
                String(rootId),
                normalizeCompare(String(absolutePath)),
                String(fingerprint),
                `x${extractorVersion ?? CONTENT_EXTRACTOR_VERSION}`,
                String(embeddingModel ?? ""),
            ].join("|"),
        )
        .digest("hex");
    return `idxf_${digest.slice(0, 32)}`;
}


function indexGeneration(index) {
    if (!index) {
        return null;
    }
    return JSON.stringify([
        index.createdAt ?? null,
        index.embeddingModel ?? null,
        index.extractorVersion ?? null,
        index.inventoryScannedAt ?? null,
    ]);
}


function sameFileKey(rootId, absolutePath) {
    return `${rootId}\0${normalizeCompare(absolutePath)}`;
}


function fileRowKey(row) {
    return `${sameFileKey(row.rootId, row.absolutePath)}\0${row.fingerprint}`;
}


function searchableFileRows(index) {
    return (index?.files ?? []).filter(
        (file) =>
            file &&
            SEARCHABLE_STATUSES.has(file.status) &&
            Number(file.chunkCount) > 0 &&
            typeof file.rootId === "string" &&
            typeof file.absolutePath === "string" &&
            typeof file.fingerprint === "string",
    );
}


function refForRow(row, index) {
    return computeFileRef({
        rootId: row.rootId,
        absolutePath: row.absolutePath,
        fingerprint: row.fingerprint,
        extractorVersion: row.extractorVersion ?? index.extractorVersion,
        embeddingModel: row.embeddingModel ?? index.embeddingModel,
    });
}


function clampText(text, maxChars) {
    const value = String(text ?? "");
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars - 1)}…`;
}


/**
 * Independently ask the Computer path-safety layer whether the live
 * file is within Computer authority, and whether it still matches the
 * indexed fingerprint. Only when both hold is a computerPath handed off.
 * Freshness is not checked outside Computer authority, so snapshotCurrent
 * is omitted there rather than reported as a misleading false.
 *
 * @param {string} absolutePath indexed absolute path (never returned unless valid)
 * @param {string} fingerprint indexed fingerprint
 */
export async function checkComputerAccess(absolutePath, fingerprint) {
    let target;
    try {
        target = await resolveExistingPath(absolutePath);
    } catch {
        return { computerAccessible: false };
    }

    if (!target.stats.isFile() || isSensitiveFilename(target.real)) {
        return { computerAccessible: false };
    }

    const liveFingerprint = `${target.stats.size}:${Number(target.stats.mtimeMs)}`;
    if (liveFingerprint !== fingerprint) {
        return { computerAccessible: true, snapshotCurrent: false };
    }

    return {
        computerAccessible: true,
        snapshotCurrent: true,
        computerPath: target.real,
    };
}


function makeAccessCache() {
    const cache = new Map();
    return async (row) => {
        const key = fileRowKey(row);
        if (!cache.has(key)) {
            cache.set(key, checkComputerAccess(row.absolutePath, row.fingerprint));
        }
        return cache.get(key);
    };
}


async function loadIndexSafe() {
    try {
        return await loadFileContentIndex();
    } catch (error) {
        console.error("File Intelligence adapter: index load failed:", error);
        throw safeError(MSG_INDEX_UNAVAILABLE);
    }
}


function mapSearchError(error) {
    const message = String(error?.message ?? "");
    if (
        message.includes("does not exist") ||
        message.includes("no searchable chunks") ||
        message.includes("Malformed file-content-index")
    ) {
        return safeError(MSG_INDEX_UNAVAILABLE);
    }
    if (
        message.includes("does not match current model") ||
        message.includes("malformed or incomplete embeddings")
    ) {
        return safeError(MSG_INDEX_REBUILD);
    }
    return safeError(MSG_SEARCH_UNAVAILABLE);
}


async function searchOneGeneration(args) {
    const before = await loadIndexSafe();
    if (!before) {
        throw safeError(MSG_INDEX_UNAVAILABLE);
    }

    let raw;
    try {
        raw = await searchFileContent(args.query, {
            rootId: args.rootId,
            extension: args.extension,
            limit: args.maxResults ?? SEARCH_DEFAULT_RESULTS,
        });
    } catch (error) {
        console.error("File Intelligence adapter: search failed:", error);
        throw mapSearchError(error);
    }

    const after = await loadIndexSafe();
    if (!after || indexGeneration(before) !== indexGeneration(after)) {
        return { changed: true };
    }

    return { changed: false, raw, index: after };
}


/**
 * search_file_index executor.
 *
 * @param {{ query: string, rootId?: string, extension?: string, maxResults?: number }} args
 */
export async function searchFileIndex(args) {
    let attempt = await searchOneGeneration(args);
    if (attempt.changed) {
        attempt = await searchOneGeneration(args);
        if (attempt.changed) {
            throw safeError(MSG_INDEX_CHANGED);
        }
    }

    const { raw, index } = attempt;
    const chunksById = new Map(
        index.chunks.map((chunk) => [chunk.chunkId, chunk]),
    );
    const rowsByKey = new Map(
        searchableFileRows(index).map((row) => [fileRowKey(row), row]),
    );
    const access = makeAccessCache();
    const results = [];

    for (const match of raw) {
        const chunk = chunksById.get(match.chunkId);
        if (!chunk) {
            continue;
        }
        const row = rowsByKey.get(fileRowKey(chunk));
        if (!row) {
            continue;
        }

        const authority = await access(row);
        results.push({
            fileRef: refForRow(row, index),
            rootId: row.rootId,
            filePath: row.relativePath ?? row.name,
            name: row.name,
            extension: row.extension,
            chunkIndex: chunk.chunkIndex,
            similarity: match.similarity,
            pageStart: chunk.pageStart ?? null,
            pageEnd: chunk.pageEnd ?? null,
            excerpt: clampText(chunk.content, EXCERPT_MAX_CHARS),
            ...authority,
        });
    }

    return {
        query: args.query,
        indexedAt: index.createdAt ?? null,
        snapshot: true,
        note:
            "Indexed File Intelligence snapshot. Not proof of current live disk contents.",
        results,
    };
}


/**
 * get_indexed_file executor. Resolves fileRef ONLY against the current
 * File content index and returns indexed chunks — never live disk bytes.
 *
 * @param {{ fileRef: string, startChunk?: number, maxChunks?: number }} args
 */
export async function getIndexedFile(args) {
    const fileRef = String(args.fileRef ?? "");
    if (!FILE_REF_PATTERN.test(fileRef)) {
        throw safeError(MSG_STALE_REF);
    }

    const index = await loadIndexSafe();
    if (!index) {
        throw safeError(MSG_INDEX_UNAVAILABLE);
    }

    const row = searchableFileRows(index).find(
        (candidate) => refForRow(candidate, index) === fileRef,
    );
    if (!row) {
        throw safeError(MSG_STALE_REF);
    }

    const rowKey = fileRowKey(row);
    const fileChunks = index.chunks
        .filter(
            (chunk) =>
                chunk &&
                typeof chunk.absolutePath === "string" &&
                fileRowKey(chunk) === rowKey,
        )
        .sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (fileChunks.length === 0) {
        throw safeError(MSG_NO_CHUNKS);
    }

    const startChunk = Number.isInteger(args.startChunk) ? args.startChunk : 0;
    const maxChunks = Math.min(
        Math.max(
            Number.isInteger(args.maxChunks) ? args.maxChunks : GET_DEFAULT_CHUNKS,
            1,
        ),
        GET_MAX_CHUNKS,
    );

    const chunks = [];
    let usedChars = 0;
    let position = startChunk;

    while (position < fileChunks.length && chunks.length < maxChunks) {
        const chunk = fileChunks[position];
        const remaining = GET_MAX_TOTAL_CHARS - usedChars;
        if (chunks.length > 0 && String(chunk.content ?? "").length > remaining) {
            break;
        }
        const content = clampText(chunk.content, Math.max(remaining, 1));
        chunks.push({
            chunkIndex: chunk.chunkIndex,
            pageStart: chunk.pageStart ?? null,
            pageEnd: chunk.pageEnd ?? null,
            content,
        });
        usedChars += content.length;
        position += 1;
    }

    const hasMore = position < fileChunks.length;
    const authority = await checkComputerAccess(row.absolutePath, row.fingerprint);

    return {
        fileRef,
        rootId: row.rootId,
        filePath: row.relativePath ?? row.name,
        name: row.name,
        extension: row.extension,
        indexedAt: index.createdAt ?? null,
        snapshot: true,
        note:
            "Indexed File Intelligence snapshot. Not live filesystem content.",
        startChunk,
        returnedChunks: chunks.length,
        totalChunks: fileChunks.length,
        hasMore,
        nextChunk: hasMore ? position : null,
        chunks,
        ...authority,
    };
}


/** Test helpers — not for production routes. */
export const _test = {
    indexGeneration,
    MSG_INDEX_UNAVAILABLE,
    MSG_INDEX_REBUILD,
    MSG_SEARCH_UNAVAILABLE,
    MSG_INDEX_CHANGED,
    MSG_STALE_REF,
    MSG_NO_CHUNKS,
};
