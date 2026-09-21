// =========================================================
// lib/conversation-archive.js
//
// Durable historical conversations as per-id JSON files plus a
// metadata-only manifest. Canonical message bodies live only in
// <conversationId>.json — never duplicated into the manifest.
//
// After successful archival, conversation files are immutable.
// =========================================================


import fs from "node:fs/promises";
import path from "node:path";

import {
    assertValidConversationId,
    isValidConversationId,
} from "./conversation-id.js";
import { sanitizeTranscriptMessage } from "./conversation-transcript.js";


const ARCHIVE_DIR_ENV = "LOCAL_AI_CONVERSATION_ARCHIVE_DIR";
const DEFAULT_ARCHIVE_DIR = path.join("data", "conversation-archive");
const ARCHIVE_VERSION = 1;
const MANIFEST_NAME = "manifest.json";

let mutationQueue = Promise.resolve();
let loaded = false;
/** @type {{ version: number, conversations: Array<object> }} */
let manifest = emptyManifest();


function enqueueMutation(work) {
    const run = mutationQueue.then(work);

    mutationQueue = run.then(
        () => undefined,
        () => undefined,
    );

    return run;
}


function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function emptyManifest() {
    return {
        version: ARCHIVE_VERSION,
        conversations: [],
    };
}


export function archiveDirPath() {
    const override = process.env[ARCHIVE_DIR_ENV];
    if (override && String(override).trim()) {
        return path.resolve(String(override).trim());
    }

    return path.resolve(DEFAULT_ARCHIVE_DIR);
}


export function archiveManifestPath() {
    return path.join(archiveDirPath(), MANIFEST_NAME);
}


/**
 * Resolve a conversation file path only after ID validation.
 */
export function archiveConversationPath(conversationId) {
    assertValidConversationId(conversationId);
    const dir = archiveDirPath();
    const filePath = path.resolve(dir, `${conversationId}.json`);
    const relative = path.relative(dir, filePath);

    if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        relative.includes(path.sep) ||
        relative.includes("/") ||
        relative.includes("\\")
    ) {
        const error = new Error("Invalid conversation archive path.");
        error.code = "ARCHIVE_PATH_INVALID";
        error.status = 400;
        throw error;
    }

    return filePath;
}


async function ensureArchiveDir() {
    await fs.mkdir(archiveDirPath(), { recursive: true });
}


async function atomicWriteJson(filePath, value) {
    await ensureArchiveDir();
    const json = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

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


function sanitizeArchivedConversation(raw) {
    if (!isPlainObject(raw)) {
        throw archiveError(
            "ARCHIVE_INVALID",
            "Archived conversation must be an object.",
            500,
        );
    }

    assertValidConversationId(raw.id);

    if (raw.version !== ARCHIVE_VERSION && raw.version !== undefined) {
        // Accept missing version on read only if id/messages valid; persist as 1.
    }

    if (raw.createdAt !== null && typeof raw.createdAt !== "string") {
        throw archiveError(
            "ARCHIVE_INVALID",
            "Archived conversation createdAt must be a string or null.",
            500,
        );
    }

    if (typeof raw.endedAt !== "string" || !raw.endedAt) {
        throw archiveError(
            "ARCHIVE_INVALID",
            "Archived conversation endedAt must be a non-empty string.",
            500,
        );
    }

    if (!Array.isArray(raw.messages)) {
        throw archiveError(
            "ARCHIVE_INVALID",
            "Archived conversation messages must be an array.",
            500,
        );
    }

    return {
        version: ARCHIVE_VERSION,
        id: raw.id,
        createdAt: raw.createdAt ?? null,
        endedAt: raw.endedAt,
        messages: raw.messages.map((item) => sanitizeTranscriptMessage(item)),
    };
}


function archiveError(code, message, status = 500) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}


async function persistManifestUnlocked() {
    await atomicWriteJson(archiveManifestPath(), manifest);
}


async function loadManifestUnlocked() {
    const filePath = archiveManifestPath();
    let raw;

    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            manifest = emptyManifest();
            await persistManifestUnlocked();
            return { created: true };
        }
        throw error;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw archiveError(
            "ARCHIVE_MANIFEST_MALFORMED",
            `Archive manifest at ${filePath} is malformed JSON: ${error.message}`,
            500,
        );
    }

    if (!isPlainObject(parsed) || !Array.isArray(parsed.conversations)) {
        throw archiveError(
            "ARCHIVE_MANIFEST_INVALID",
            `Archive manifest at ${filePath} must be an object with a conversations array.`,
            500,
        );
    }

    const conversations = [];

    for (const entry of parsed.conversations) {
        if (!isPlainObject(entry)) {
            throw archiveError(
                "ARCHIVE_MANIFEST_INVALID",
                "Archive manifest conversation entries must be objects.",
                500,
            );
        }

        assertValidConversationId(entry.id);

        if (entry.createdAt !== null && typeof entry.createdAt !== "string") {
            throw archiveError(
                "ARCHIVE_MANIFEST_INVALID",
                "Archive manifest createdAt must be a string or null.",
                500,
            );
        }

        if (typeof entry.endedAt !== "string") {
            throw archiveError(
                "ARCHIVE_MANIFEST_INVALID",
                "Archive manifest endedAt must be a string.",
                500,
            );
        }

        if (!Number.isFinite(entry.messageCount)) {
            throw archiveError(
                "ARCHIVE_MANIFEST_INVALID",
                "Archive manifest messageCount must be a number.",
                500,
            );
        }

        conversations.push({
            id: entry.id,
            createdAt: entry.createdAt ?? null,
            endedAt: entry.endedAt,
            messageCount: entry.messageCount,
        });
    }

    manifest = {
        version: ARCHIVE_VERSION,
        conversations,
    };

    return { created: false };
}


async function initializeArchiveUnlocked() {
    if (loaded) {
        return { loaded: true };
    }

    await ensureArchiveDir();
    await loadManifestUnlocked();
    loaded = true;
    return { loaded: true };
}


export function initializeArchive() {
    return enqueueMutation(() => initializeArchiveUnlocked());
}


export function listArchivedConversationMetadata() {
    return enqueueMutation(async () => {
        await initializeArchiveUnlocked();
        return {
            conversations: manifest.conversations.map((item) => ({ ...item })),
        };
    });
}


/**
 * Load one archived conversation. Missing file fails loudly if listed
 * in the manifest; optional for direct lookups.
 */
export function getArchivedConversation(conversationId) {
    return enqueueMutation(async () => {
        await initializeArchiveUnlocked();
        assertValidConversationId(conversationId);
        return loadConversationFileUnlocked(conversationId);
    });
}


async function loadConversationFileUnlocked(conversationId) {
    const filePath = archiveConversationPath(conversationId);
    let raw;

    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            const errorMissing = archiveError(
                "ARCHIVE_NOT_FOUND",
                `Archived conversation not found: ${conversationId}`,
                404,
            );
            throw errorMissing;
        }
        throw error;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw archiveError(
            "ARCHIVE_MALFORMED",
            `Archived conversation at ${filePath} is malformed JSON: ${error.message}`,
            500,
        );
    }

    const cleaned = sanitizeArchivedConversation(parsed);

    if (cleaned.id !== conversationId) {
        throw archiveError(
            "ARCHIVE_INVALID",
            `Archived conversation id mismatch in ${filePath}.`,
            500,
        );
    }

    return cleaned;
}


/**
 * Idempotent archive. If the conversation file already exists with the
 * same id, do not rewrite it (immutability). Ensure manifest lists it.
 */
export function archiveConversation(record) {
    return enqueueMutation(async () => {
        await initializeArchiveUnlocked();
        return archiveConversationUnlocked(record);
    });
}


/**
 * Lifecycle-friendly helper: same as archiveConversation but intended
 * to be awaited from the lifecycle queue (still uses archive queue).
 */
export async function archiveConversationUnlocked(record) {
    if (!isPlainObject(record)) {
        throw archiveError(
            "ARCHIVE_VALIDATION",
            "Archive record must be an object.",
            400,
        );
    }

    assertValidConversationId(record.id);

    if (!Array.isArray(record.messages) || record.messages.length === 0) {
        throw archiveError(
            "ARCHIVE_VALIDATION",
            "Cannot archive a conversation with zero messages.",
            400,
        );
    }

    const cleaned = sanitizeArchivedConversation({
        version: ARCHIVE_VERSION,
        id: record.id,
        createdAt: record.createdAt ?? null,
        endedAt: record.endedAt ?? new Date().toISOString(),
        messages: record.messages,
    });

    const filePath = archiveConversationPath(cleaned.id);
    let alreadyExists = false;

    try {
        await fs.access(filePath);
        alreadyExists = true;
    } catch {
        alreadyExists = false;
    }

    if (alreadyExists) {
        // Idempotent retry — do not rewrite immutable archive file.
        const existing = await loadConversationFileUnlocked(cleaned.id);
        if (existing.id !== cleaned.id) {
            throw archiveError(
                "ARCHIVE_INVALID",
                "Existing archive file id mismatch.",
                500,
            );
        }
    } else {
        await atomicWriteJson(filePath, cleaned);
    }

    const meta = {
        id: cleaned.id,
        createdAt: cleaned.createdAt,
        endedAt: cleaned.endedAt,
        messageCount: cleaned.messages.length,
    };

    const index = manifest.conversations.findIndex(
        (item) => item.id === cleaned.id,
    );

    if (index >= 0) {
        manifest.conversations[index] = meta;
    } else {
        manifest.conversations.push(meta);
    }

    await persistManifestUnlocked();

    return {
        ok: true,
        archived: true,
        alreadyExisted: alreadyExists,
        conversation: meta,
    };
}


export function deleteArchivedConversation(conversationId) {
    return enqueueMutation(async () => {
        await initializeArchiveUnlocked();
        return deleteArchivedConversationUnlocked(conversationId);
    });
}


export async function deleteArchivedConversationUnlocked(conversationId) {
    assertValidConversationId(conversationId);
    const filePath = archiveConversationPath(conversationId);

    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    manifest.conversations = manifest.conversations.filter(
        (item) => item.id !== conversationId,
    );
    await persistManifestUnlocked();

    return { ok: true, deleted: conversationId };
}


/**
 * Remove every canonical conversation file and reset the manifest.
 */
export function clearArchive() {
    return enqueueMutation(async () => {
        await initializeArchiveUnlocked();
        return clearArchiveUnlocked();
    });
}


export async function clearArchiveUnlocked() {
    const dir = archiveDirPath();
    let entries = [];

    try {
        entries = await fs.readdir(dir);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    for (const name of entries) {
        if (!name.endsWith(".json") || name === MANIFEST_NAME) {
            continue;
        }

        const id = name.slice(0, -".json".length);
        if (!isValidConversationId(id)) {
            continue;
        }

        try {
            await fs.unlink(path.join(dir, name));
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }

    manifest = emptyManifest();
    await persistManifestUnlocked();
    return { ok: true };
}


/**
 * Load all archived conversations for Conversation Memory sync/search.
 * Uses manifest order; fails loudly on missing/malformed files.
 */
export function loadAllArchivedConversations() {
    return enqueueMutation(async () => {
        await initializeArchiveUnlocked();
        const conversations = [];

        for (const entry of manifest.conversations) {
            conversations.push(await loadConversationFileUnlocked(entry.id));
        }

        return { conversations };
    });
}


export function _resetArchiveStateForTests() {
    loaded = false;
    manifest = emptyManifest();
}


export const _test = {
    ARCHIVE_VERSION,
    MANIFEST_NAME,
    emptyManifest,
    isValidConversationId,
};
