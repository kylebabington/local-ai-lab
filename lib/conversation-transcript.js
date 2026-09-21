// =========================================================
// lib/conversation-transcript.js
//
// Display-only unified conversation transcript.
//
// Persists UI-visible turns for Chat / Project / File / Computer.
// Does NOT own model context. Never feed this file into Ollama,
// Project RAG, File RAG, or the Computer agent loop.
//
// Shape: { version, conversationId, createdAt, messages }
// Mutations require conversationId matching the open current
// conversation; closed/closing conversations reject writes (409).
// =========================================================


import fs from "node:fs/promises";
import path from "node:path";

import {
    assertValidConversationId,
    createConversationId,
} from "./conversation-id.js";


const TRANSCRIPT_ENV = "LOCAL_AI_TRANSCRIPT_PATH";
const LEGACY_HISTORY_ENV = "LOCAL_AI_TRANSCRIPT_LEGACY_HISTORY_PATH";
const MAX_BYTES_ENV = "LOCAL_AI_TRANSCRIPT_MAX_BYTES";

const DEFAULT_TRANSCRIPT_PATH = path.join("data", "conversation-transcript.json");
const DEFAULT_LEGACY_HISTORY_PATH = "./chat-history.json";
const DEFAULT_MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const TRANSCRIPT_VERSION = 1;

const CONTEXT_MODES = new Set(["chat", "project", "file", "computer"]);
const ROLES = new Set(["user", "assistant"]);
const APPROVAL_STATUSES = new Set([
    "pending",
    "approved",
    "rejected",
    "expired",
]);
const APPROVAL_PERMISSIONS = new Set(["read", "approval", "high-risk"]);
const PUBLIC_ARG_KEYS = [
    "path",
    "source",
    "destination",
    "query",
    "root",
    "recursive",
    "maxDepth",
    "maxResults",
    "reason",
];

let mutationQueue = Promise.resolve();
let loaded = false;
let conversationId = null;
let createdAt = null;
let messages = [];
/** @type {"open" | "closing" | "closed"} */
let writeState = "open";


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


export function transcriptPath() {
    const override = process.env[TRANSCRIPT_ENV];
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }

    return path.resolve(DEFAULT_TRANSCRIPT_PATH);
}


export function legacyHistoryPath() {
    const override = process.env[LEGACY_HISTORY_ENV];
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }

    return path.resolve(DEFAULT_LEGACY_HISTORY_PATH);
}


export function maxTranscriptBytes() {
    const raw = process.env[MAX_BYTES_ENV];
    if (raw && String(raw).trim()) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return DEFAULT_MAX_TRANSCRIPT_BYTES;
}


async function ensureParentDir(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
}


async function atomicWriteJson(filePath, value) {
    await ensureParentDir(filePath);
    const json = `${JSON.stringify(value, null, 2)}\n`;
    const byteLength = Buffer.byteLength(json, "utf8");

    if (byteLength > maxTranscriptBytes()) {
        const error = new Error(
            `Transcript would exceed the ${maxTranscriptBytes()} byte limit.`,
        );
        error.code = "TRANSCRIPT_TOO_LARGE";
        error.status = 413;
        throw error;
    }

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


function validationError(message) {
    const error = new Error(message);
    error.code = "TRANSCRIPT_VALIDATION";
    error.status = 400;
    return error;
}


function conversationChangedError() {
    const error = new Error(
        "Conversation changed. This message belongs to an older conversation.",
    );
    error.code = "CONVERSATION_CHANGED";
    error.status = 409;
    return error;
}


function snapshotDoc() {
    return {
        version: TRANSCRIPT_VERSION,
        conversationId,
        createdAt,
        messages: messages.map((item) => ({ ...item })),
        writeState,
    };
}


function sanitizePublicArgs(args) {
    if (!isPlainObject(args)) {
        return {};
    }

    const display = {};

    for (const key of PUBLIC_ARG_KEYS) {
        if (key in args) {
            display[key] = args[key];
        }
    }

    return display;
}


function sanitizeProjectSource(source) {
    if (!isPlainObject(source)) {
        throw validationError("Project source must be an object.");
    }

    if (typeof source.filePath !== "string") {
        throw validationError("Project source filePath must be a string.");
    }

    if (!Number.isFinite(source.startLine) || !Number.isFinite(source.endLine)) {
        throw validationError("Project source lines must be numbers.");
    }

    if (!Number.isFinite(source.similarity)) {
        throw validationError("Project source similarity must be a number.");
    }

    return {
        filePath: source.filePath,
        startLine: source.startLine,
        endLine: source.endLine,
        similarity: source.similarity,
    };
}


function sanitizeFileSource(source) {
    if (!isPlainObject(source)) {
        throw validationError("File source must be an object.");
    }

    if (source.sourceType !== "file") {
        throw validationError('File source sourceType must be "file".');
    }

    for (const key of ["filePath", "name", "rootId"]) {
        if (typeof source[key] !== "string") {
            throw validationError(`File source ${key} must be a string.`);
        }
    }

    if (!Number.isFinite(source.chunkIndex)) {
        throw validationError("File source chunkIndex must be a number.");
    }

    if (!Number.isFinite(source.similarity)) {
        throw validationError("File source similarity must be a number.");
    }

    const cleaned = {
        sourceType: "file",
        filePath: source.filePath,
        name: source.name,
        rootId: source.rootId,
        chunkIndex: source.chunkIndex,
        similarity: source.similarity,
    };

    if (source.pageStart !== undefined) {
        if (!Number.isFinite(source.pageStart)) {
            throw validationError("File source pageStart must be a number.");
        }
        cleaned.pageStart = source.pageStart;
    }

    if (source.pageEnd !== undefined) {
        if (!Number.isFinite(source.pageEnd)) {
            throw validationError("File source pageEnd must be a number.");
        }
        cleaned.pageEnd = source.pageEnd;
    }

    return cleaned;
}


function sanitizeMemorySource(source) {
    if (!isPlainObject(source)) {
        throw validationError("Memory source must be an object.");
    }

    if (source.sourceType !== "memory") {
        throw validationError('Memory source sourceType must be "memory".');
    }

    if (typeof source.memoryId !== "string" || !source.memoryId.trim()) {
        throw validationError("Memory source memoryId must be a non-empty string.");
    }

    if (typeof source.chunkId !== "string" || !source.chunkId.trim()) {
        throw validationError("Memory source chunkId must be a non-empty string.");
    }

    if (!Number.isFinite(source.similarity)) {
        throw validationError("Memory source similarity must be a number.");
    }

    if (typeof source.preview !== "string") {
        throw validationError("Memory source preview must be a string.");
    }

    if (source.startedAt !== null && typeof source.startedAt !== "string") {
        throw validationError("Memory source startedAt must be a string or null.");
    }

    if (source.endedAt !== null && typeof source.endedAt !== "string") {
        throw validationError("Memory source endedAt must be a string or null.");
    }

    if (!Array.isArray(source.contextModes)) {
        throw validationError("Memory source contextModes must be an array.");
    }

    const contextModes = source.contextModes.filter(
        (mode) => typeof mode === "string" && CONTEXT_MODES.has(mode),
    );

    return {
        sourceType: "memory",
        memoryId: source.memoryId.trim(),
        chunkId: source.chunkId.trim(),
        similarity: source.similarity,
        startedAt: source.startedAt ?? null,
        endedAt: source.endedAt ?? null,
        contextModes,
        preview: source.preview.slice(0, 280),
    };
}


function sanitizeSources(sources) {
    if (sources === undefined) {
        return undefined;
    }

    if (!Array.isArray(sources)) {
        throw validationError("sources must be an array.");
    }

    return sources.map((source) => {
        if (isPlainObject(source) && source.sourceType === "file") {
            return sanitizeFileSource(source);
        }

        if (isPlainObject(source) && source.sourceType === "memory") {
            return sanitizeMemorySource(source);
        }

        return sanitizeProjectSource(source);
    });
}


function sanitizeToolUses(toolUses) {
    if (toolUses === undefined) {
        return undefined;
    }

    if (!Array.isArray(toolUses)) {
        throw validationError("toolUses must be an array.");
    }

    return toolUses.map((item) => {
        if (!isPlainObject(item)) {
            throw validationError("Each toolUse must be an object.");
        }

        if (typeof item.tool !== "string" || typeof item.summary !== "string") {
            throw validationError("toolUse requires string tool and summary.");
        }

        return {
            tool: item.tool,
            summary: item.summary,
        };
    });
}


function sanitizeApproval(approval) {
    if (approval === undefined) {
        return undefined;
    }

    if (approval === null) {
        return null;
    }

    if (!isPlainObject(approval)) {
        throw validationError("approval must be an object or null.");
    }

    if (typeof approval.id !== "string" || !approval.id) {
        throw validationError("approval.id must be a non-empty string.");
    }

    if (typeof approval.tool !== "string") {
        throw validationError("approval.tool must be a string.");
    }

    if (!APPROVAL_PERMISSIONS.has(approval.permission)) {
        throw validationError("approval.permission is invalid.");
    }

    if (typeof approval.reason !== "string") {
        throw validationError("approval.reason must be a string.");
    }

    return {
        id: approval.id,
        tool: approval.tool,
        permission: approval.permission,
        reason: approval.reason,
        arguments: sanitizePublicArgs(approval.arguments),
    };
}


function sanitizeApprovalStatus(status) {
    if (status === undefined) {
        return undefined;
    }

    if (!APPROVAL_STATUSES.has(status)) {
        throw validationError("approvalStatus is invalid.");
    }

    return status;
}


/**
 * Validate and return a display-safe transcript message.
 * Strips unknown top-level and nested fields.
 */
export function sanitizeTranscriptMessage(raw) {
    if (!isPlainObject(raw)) {
        throw validationError("Transcript message must be an object.");
    }

    if (typeof raw.id !== "string" || !raw.id.trim()) {
        throw validationError("Message id must be a non-empty string.");
    }

    if (!ROLES.has(raw.role)) {
        throw validationError('Message role must be "user" or "assistant".');
    }

    if (typeof raw.content !== "string") {
        throw validationError("Message content must be a string.");
    }

    if (raw.createdAt !== null && typeof raw.createdAt !== "string") {
        throw validationError("Message createdAt must be a string or null.");
    }

    if (!CONTEXT_MODES.has(raw.contextMode)) {
        throw validationError("Message contextMode is invalid.");
    }

    const message = {
        id: raw.id.trim(),
        role: raw.role,
        content: raw.content,
        createdAt: raw.createdAt,
        contextMode: raw.contextMode,
    };

    const sources = sanitizeSources(raw.sources);
    if (sources !== undefined) {
        message.sources = sources;
    }

    const toolUses = sanitizeToolUses(raw.toolUses);
    if (toolUses !== undefined) {
        message.toolUses = toolUses;
    }

    const approval = sanitizeApproval(raw.approval);
    if (approval !== undefined) {
        message.approval = approval;
    }

    const approvalStatus = sanitizeApprovalStatus(raw.approvalStatus);
    if (approvalStatus !== undefined) {
        message.approvalStatus = approvalStatus;
    }

    return message;
}


function sanitizePatch(raw) {
    if (!isPlainObject(raw)) {
        throw validationError("Patch body must be an object.");
    }

    const forbidden = ["id", "role", "createdAt", "contextMode"];
    for (const key of forbidden) {
        if (key in raw) {
            throw validationError(`Cannot patch immutable field "${key}".`);
        }
    }

    const patch = {};

    if ("content" in raw) {
        if (typeof raw.content !== "string") {
            throw validationError("Patch content must be a string.");
        }
        patch.content = raw.content;
    }

    if ("sources" in raw) {
        patch.sources = sanitizeSources(raw.sources);
    }

    if ("toolUses" in raw) {
        patch.toolUses = sanitizeToolUses(raw.toolUses);
    }

    if ("approval" in raw) {
        patch.approval = sanitizeApproval(raw.approval);
    }

    if ("approvalStatus" in raw) {
        patch.approvalStatus = sanitizeApprovalStatus(raw.approvalStatus);
    }

    if (Object.keys(patch).length === 0) {
        throw validationError("Patch must include at least one mutable field.");
    }

    return patch;
}


async function persistUnlocked() {
    await atomicWriteJson(transcriptPath(), {
        version: TRANSCRIPT_VERSION,
        conversationId,
        createdAt,
        messages,
    });
}


function assertWritableFor(requestConversationId) {
    if (
        typeof requestConversationId !== "string" ||
        !requestConversationId.trim()
    ) {
        throw validationError("conversationId is required.");
    }

    assertValidConversationId(requestConversationId);

    if (writeState !== "open") {
        throw conversationChangedError();
    }

    if (requestConversationId !== conversationId) {
        throw conversationChangedError();
    }
}


async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}


function installFreshConversationUnlocked() {
    conversationId = createConversationId();
    createdAt = new Date().toISOString();
    messages = [];
    writeState = "open";
}


async function migrateFromLegacyHistory() {
    const historyFile = legacyHistoryPath();

    let raw;
    try {
        raw = await fs.readFile(historyFile, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            installFreshConversationUnlocked();
            await persistUnlocked();
            return { migrated: false, count: 0 };
        }
        throw error;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const wrapped = new Error(
            `Legacy chat history at ${historyFile} is malformed JSON: ${error.message}`,
        );
        wrapped.code = "LEGACY_HISTORY_MALFORMED";
        throw wrapped;
    }

    if (!Array.isArray(parsed)) {
        const wrapped = new Error(
            `Legacy chat history at ${historyFile} must be a JSON array.`,
        );
        wrapped.code = "LEGACY_HISTORY_INVALID";
        throw wrapped;
    }

    const migrated = [];

    for (let index = 0; index < parsed.length; index += 1) {
        const item = parsed[index];
        if (!isPlainObject(item)) {
            continue;
        }

        if (item.role !== "user" && item.role !== "assistant") {
            continue;
        }

        if (typeof item.content !== "string") {
            continue;
        }

        migrated.push(
            sanitizeTranscriptMessage({
                id: `migrated-${index}`,
                role: item.role,
                content: item.content,
                createdAt: null,
                contextMode: "chat",
            }),
        );
    }

    conversationId = createConversationId();
    createdAt = new Date().toISOString();
    messages = migrated;
    writeState = "open";
    await persistUnlocked();
    return { migrated: true, count: migrated.length };
}


async function loadFromDiskUnlocked() {
    const filePath = transcriptPath();

    let raw;
    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return { exists: false };
        }
        throw error;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const wrapped = new Error(
            `Transcript at ${filePath} is malformed JSON: ${error.message}`,
        );
        wrapped.code = "TRANSCRIPT_MALFORMED";
        throw wrapped;
    }

    if (!isPlainObject(parsed) || !Array.isArray(parsed.messages)) {
        const wrapped = new Error(
            `Transcript at ${filePath} must be an object with a messages array.`,
        );
        wrapped.code = "TRANSCRIPT_INVALID";
        throw wrapped;
    }

    messages = parsed.messages.map((item) => sanitizeTranscriptMessage(item));

    let upgraded = false;

    if (
        typeof parsed.conversationId === "string" &&
        parsed.conversationId.trim()
    ) {
        assertValidConversationId(parsed.conversationId);
        conversationId = parsed.conversationId;
    } else {
        conversationId = createConversationId();
        upgraded = true;
    }

    if (parsed.createdAt === null || typeof parsed.createdAt === "string") {
        createdAt = parsed.createdAt ?? null;
    } else if (parsed.createdAt === undefined) {
        createdAt = new Date().toISOString();
        upgraded = true;
    } else {
        const wrapped = new Error(
            `Transcript at ${filePath} has an invalid createdAt.`,
        );
        wrapped.code = "TRANSCRIPT_INVALID";
        throw wrapped;
    }

    writeState = "open";

    if (upgraded || parsed.version !== TRANSCRIPT_VERSION) {
        await persistUnlocked();
    }

    return { exists: true, upgraded };
}


async function initializeTranscriptUnlocked() {
    if (loaded) {
        return { loaded: true, migrated: false };
    }

    const result = await loadFromDiskUnlocked();

    if (result.exists) {
        loaded = true;
        return { loaded: true, migrated: false, upgraded: result.upgraded };
    }

    const migration = await migrateFromLegacyHistory();
    loaded = true;
    return {
        loaded: true,
        migrated: migration.migrated,
        migratedCount: migration.count,
    };
}


export function initializeTranscript() {
    return enqueueMutation(() => initializeTranscriptUnlocked());
}


export function getTranscript() {
    return enqueueMutation(async () => {
        await initializeTranscriptUnlocked();
        return {
            version: TRANSCRIPT_VERSION,
            conversationId,
            createdAt,
            messages: messages.map((item) => ({ ...item })),
            writeState,
        };
    });
}


/**
 * Append messages to the CURRENT open conversation only.
 * @param {string} requestConversationId
 * @param {unknown[]} rawMessages
 */
export function appendMessages(requestConversationId, rawMessages) {
    return enqueueMutation(async () => {
        await initializeTranscriptUnlocked();
        assertWritableFor(requestConversationId);

        if (!Array.isArray(rawMessages)) {
            throw validationError("messages must be an array.");
        }

        if (rawMessages.length === 0) {
            throw validationError("messages must not be empty.");
        }

        const existingIds = new Set(messages.map((item) => item.id));
        const nextMessages = messages.map((item) => ({ ...item }));
        const appended = [];

        for (const raw of rawMessages) {
            const cleaned = sanitizeTranscriptMessage(raw);

            if (existingIds.has(cleaned.id)) {
                continue;
            }

            existingIds.add(cleaned.id);
            nextMessages.push(cleaned);
            appended.push(cleaned);
        }

        if (appended.length > 0) {
            const previous = messages;
            messages = nextMessages;
            try {
                await persistUnlocked();
            } catch (error) {
                messages = previous;
                throw error;
            }
        }

        return {
            ok: true,
            appended: appended.length,
            conversationId,
            createdAt,
            messages: messages.map((item) => ({ ...item })),
        };
    });
}


/**
 * @param {string} requestConversationId
 * @param {string} id
 * @param {object} rawPatch
 */
export function patchMessage(requestConversationId, id, rawPatch) {
    return enqueueMutation(async () => {
        await initializeTranscriptUnlocked();
        assertWritableFor(requestConversationId);

        if (typeof id !== "string" || !id.trim()) {
            throw validationError("Message id must be a non-empty string.");
        }

        const index = messages.findIndex((item) => item.id === id);
        if (index < 0) {
            const error = new Error(`Transcript message not found: ${id}`);
            error.code = "TRANSCRIPT_NOT_FOUND";
            error.status = 404;
            throw error;
        }

        const patchBody = isPlainObject(rawPatch) ? { ...rawPatch } : rawPatch;
        if (isPlainObject(patchBody) && "conversationId" in patchBody) {
            delete patchBody.conversationId;
        }

        const patch = sanitizePatch(patchBody);
        const current = messages[index];
        const next = sanitizeTranscriptMessage({ ...current, ...patch });
        const previous = messages[index];
        messages[index] = next;

        try {
            await persistUnlocked();
        } catch (error) {
            messages[index] = previous;
            throw error;
        }

        return {
            ok: true,
            conversationId,
            message: { ...messages[index] },
            messages: messages.map((item) => ({ ...item })),
        };
    });
}


/**
 * Mark the current conversation closing so further append/patch fail.
 * Returns a snapshot suitable for archival.
 */
export function beginCloseCurrentConversation() {
    return enqueueMutation(async () => {
        await initializeTranscriptUnlocked();

        if (writeState === "closing" || writeState === "closed") {
            return snapshotDoc();
        }

        writeState = "closing";
        return snapshotDoc();
    });
}


/**
 * Replace current transcript with a brand-new empty conversation.
 */
export function installNewConversation() {
    return enqueueMutation(async () => {
        await initializeTranscriptUnlocked();
        installFreshConversationUnlocked();
        await persistUnlocked();
        return snapshotDoc();
    });
}


/**
 * Forget-all / destructive reset of the current transcript only.
 */
export function resetCurrentTranscript() {
    return enqueueMutation(async () => {
        await initializeTranscriptUnlocked();
        installFreshConversationUnlocked();
        await persistUnlocked();
        return snapshotDoc();
    });
}


/**
 * @deprecated Destructive empty of messages without new id — prefer lifecycle.
 * Kept for narrow test helpers; marks closed then installs fresh.
 */
export function clearTranscript() {
    return enqueueMutation(async () => {
        await initializeTranscriptUnlocked();
        installFreshConversationUnlocked();
        await persistUnlocked();
        return {
            ok: true,
            conversationId,
            createdAt,
            messages: [],
        };
    });
}


/** Test helpers — reset in-memory state between sandbox runs. */
export function _resetTranscriptStateForTests() {
    loaded = false;
    conversationId = null;
    createdAt = null;
    messages = [];
    writeState = "open";
}


export const _test = {
    sanitizeTranscriptMessage,
    sanitizePublicArgs,
    DEFAULT_MAX_TRANSCRIPT_BYTES,
    CONTEXT_MODES,
    APPROVAL_STATUSES,
    TRANSCRIPT_VERSION,
    fileExists,
};
