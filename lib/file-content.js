// =========================================================
// lib/file-content.js
//
// File Intelligence content layer (Phase 4B):
//   supported types → safe pre-read → extract → chunk →
//   incremental embeddings → separate content index →
//   semantic retrieval
//
// Paths come only from Phase 4A inventory records.
// Never trust arbitrary absolute paths from the browser.
// =========================================================


import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import {
    isFileContentIndexing,
    runFileIntelligenceMutation,
} from "./file-intelligence-state.js";
import { getInventory, listRoots } from "./file-inventory.js";
import {
    EMBEDDING_MODEL,
    createEmbeddings,
    ensureModelAvailable,
} from "./ollama.js";
import {
    isPathInsideRoot,
    isSensitiveFilename,
} from "./tools/path-safety.js";


export const MAX_CONTENT_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TOP_K = 6;
export const CONTENT_INDEX_VERSION = 1;
export const CONTENT_EXTRACTOR_VERSION = 1;
export const STATUS_ISSUES_CAP = 100;

const EMBED_BATCH_SIZE = 16;
const TARGET_CHUNK_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 200;
const PREVIEW_MAX_CHARS = 280;

const CONTENT_INDEX_ENV = "LOCAL_AI_FILE_CONTENT_INDEX_PATH";

/** Statuses surfaced as display-safe issues (not indexed/reused). */
const ISSUE_STATUSES = new Set([
    "error",
    "stale",
    "too_large",
    "no_text",
    "unsupported",
    "unsafe",
    "sensitive",
]);

const SAFE_ISSUE_MESSAGES = {
    pdf_extract_failed: "Could not extract text from this PDF.",
    docx_extract_failed: "Could not extract text from this Word document.",
    text_extract_failed: "Could not extract text from this file.",
    extract_failed: "Could not extract text from this file.",
    stale: "This file changed after the metadata scan. Scan folders again before indexing.",
    too_large: "File exceeds the 10 MiB content-index limit.",
    no_text: "No extractable text was found.",
    unsupported: "This file type is not supported for content indexing yet.",
    unsafe: "This file could not be indexed safely.",
    sensitive: "This file could not be indexed safely.",
};

const TEXT_EXTENSIONS = new Set([
    "txt",
    "md",
    "markdown",
    "json",
    "csv",
    "log",
    "yaml",
    "yml",
    "xml",
    "html",
    "htm",
    "css",
    "js",
    "jsx",
    "ts",
    "tsx",
    "py",
    "toml",
    "ini",
    "cfg",
    "conf",
    "sql",
    "sh",
    "bash",
    "ps1",
    "bat",
    "cmd",
    "rs",
    "go",
    "java",
    "c",
    "h",
    "cpp",
    "hpp",
    "cs",
    "rb",
    "php",
    "r",
    "swift",
    "kt",
    "scala",
    "lua",
    "pl",
    "tex",
    "rst",
    "tsv",
]);

const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx"]);

/** Optional injectables for deterministic tests. */
let embedTextsFn = null;


function contentIndexPath() {
    const override = process.env[CONTENT_INDEX_ENV];
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }
    return path.resolve(process.cwd(), "data", "file-content-index.json");
}


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


function extensionOf(nameOrPath) {
    const ext = path.extname(nameOrPath).replace(/^\./, "").toLowerCase();
    return ext;
}


/**
 * @param {string} extension
 * @returns {"text" | "pdf" | "docx" | null}
 */
export function contentKindForExtension(extension) {
    const ext = String(extension ?? "")
        .replace(/^\./, "")
        .toLowerCase();

    if (ext === "pdf") {
        return "pdf";
    }
    if (ext === "docx") {
        return "docx";
    }
    if (TEXT_EXTENSIONS.has(ext)) {
        return "text";
    }
    return null;
}


export function isSupportedContentExtension(extension) {
    return contentKindForExtension(extension) !== null;
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


function emptySummary() {
    return {
        inventoryFiles: 0,
        supportedFiles: 0,
        indexedFiles: 0,
        reusedFiles: 0,
        staleFiles: 0,
        unsupportedFiles: 0,
        tooLargeFiles: 0,
        noTextFiles: 0,
        errorFiles: 0,
        unsafeFiles: 0,
        chunkCount: 0,
        filesReprocessed: 0,
        chunksEmbedded: 0,
        chunksReused: 0,
    };
}


/**
 * @returns {object}
 */
function emptyIndexDoc() {
    return {
        version: CONTENT_INDEX_VERSION,
        extractorVersion: CONTENT_EXTRACTOR_VERSION,
        createdAt: null,
        embeddingModel: EMBEDDING_MODEL,
        inventoryScannedAt: null,
        summary: emptySummary(),
        files: [],
        chunks: [],
    };
}


/**
 * Load content index or null if missing.
 * Malformed JSON fails loudly.
 *
 * @returns {Promise<object | null>}
 */
export async function loadFileContentIndex() {
    const filePath = contentIndexPath();
    let raw;

    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error(
            "Malformed file-content-index.json: file is not valid JSON.",
        );
    }

    if (
        typeof data !== "object" ||
        data === null ||
        !Array.isArray(data.files) ||
        !Array.isArray(data.chunks)
    ) {
        throw new Error(
            "Malformed file-content-index.json: expected files and chunks arrays.",
        );
    }

    return data;
}


/**
 * Persist a fully constructed candidate index (atomic rename).
 * Call only after embeddings succeed for all new chunks.
 *
 * @param {object} index
 */
export async function saveFileContentIndex(index) {
    await atomicWriteJson(contentIndexPath(), index);
}


/**
 * Remove content-index rows for a root. Caller must already hold
 * the File Intelligence mutation lock (e.g. removeRoot).
 *
 * @param {string} rootId
 */
export async function pruneFileContentIndexForRoot(rootId) {
    const id = String(rootId ?? "").trim();
    if (!id) {
        return null;
    }

    const existing = await loadFileContentIndex();
    if (!existing) {
        return null;
    }

    const files = existing.files.filter((file) => file.rootId !== id);
    const chunks = existing.chunks.filter((chunk) => chunk.rootId !== id);

    if (
        files.length === existing.files.length &&
        chunks.length === existing.chunks.length
    ) {
        return existing;
    }

    const next = {
        ...existing,
        files,
        chunks,
        summary: recomputeIndexSummary(files, chunks, existing.summary),
    };

    await saveFileContentIndex(next);
    return next;
}


/**
 * Application-defined issue code for a non-success content-index status.
 * @param {string} status
 * @param {string | null | undefined} extractorKind
 */
export function contentIssueCode(status, extractorKind) {
    if (status === "error") {
        if (extractorKind === "pdf") {
            return "pdf_extract_failed";
        }
        if (extractorKind === "docx") {
            return "docx_extract_failed";
        }
        if (extractorKind === "text") {
            return "text_extract_failed";
        }
        return "extract_failed";
    }
    if (status === "sensitive") {
        return "sensitive";
    }
    if (ISSUE_STATUSES.has(status)) {
        return status;
    }
    return "extract_failed";
}


/**
 * Fixed user-safe message for a content-index issue code.
 * @param {string} code
 */
export function contentIssueMessage(code) {
    return SAFE_ISSUE_MESSAGES[code] ?? SAFE_ISSUE_MESSAGES.extract_failed;
}


/**
 * Persist only application-defined safe outcomes — never raw library text.
 * @param {string} status
 * @param {string | null | undefined} extractorKind
 * @returns {{ code: string, message: string } | null}
 */
export function toPersistedFileError(status, extractorKind) {
    if (!ISSUE_STATUSES.has(status) && status !== "sensitive") {
        return null;
    }
    const code = contentIssueCode(status, extractorKind);
    return {
        code,
        message: contentIssueMessage(code),
    };
}


/**
 * Best-effort scrub of legacy string errors when reading old indexes.
 * New writes must use toPersistedFileError() instead.
 * @param {unknown} text
 */
export function sanitizeIssueMessage(text) {
    if (typeof text !== "string" || !text.trim()) {
        return contentIssueMessage("extract_failed");
    }
    const firstLine = text.split(/\r?\n/)[0].trim();
    // Strip absolute Windows / POSIX paths from legacy dependency text.
    const withoutPaths = firstLine
        .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
        .replace(/\/(?:Users|home|tmp|var|etc|usr|opt|private)\/[^\s"']+/gi, "[path]")
        .replace(/\\\\[^\s"']+/g, "[path]");
    if (!withoutPaths || withoutPaths === "[path]") {
        return contentIssueMessage("extract_failed");
    }
    return withoutPaths.slice(0, 280);
}


/**
 * Resolve a display-safe issue from a persisted file row (new or legacy).
 * @param {object} file
 * @returns {{ name: string, relativePath: string, status: string, code: string, message: string } | null}
 */
export function resolveFileIssue(file) {
    if (!file || typeof file !== "object") {
        return null;
    }
    const status = file.status;
    if (!ISSUE_STATUSES.has(status)) {
        return null;
    }

    const name = typeof file.name === "string" ? file.name : "";
    const relativePath =
        typeof file.relativePath === "string" ? file.relativePath : name;
    const extractorKind =
        typeof file.extractor === "string" ? file.extractor : null;

    // Prefer structured persisted outcomes when present and well-formed.
    if (
        file.error &&
        typeof file.error === "object" &&
        typeof file.error.code === "string" &&
        typeof file.error.message === "string" &&
        SAFE_ISSUE_MESSAGES[file.error.code]
    ) {
        return {
            name,
            relativePath,
            status,
            code: file.error.code,
            message: SAFE_ISSUE_MESSAGES[file.error.code],
        };
    }

    // Legacy string/null error fields: derive fixed copy from status only.
    // sanitizeIssueMessage exists for callers that must scrub unknown legacy text;
    // known issue statuses always use application-defined messages.
    const code = contentIssueCode(status, extractorKind);
    return {
        name,
        relativePath,
        status,
        code,
        message: contentIssueMessage(code),
    };
}


/**
 * Build capped issues list from index file rows.
 * @param {object[]} files
 */
function buildStatusIssues(files) {
    const issues = [];
    let issueCount = 0;

    for (const file of files ?? []) {
        const issue = resolveFileIssue(file);
        if (!issue) {
            continue;
        }
        issueCount += 1;
        if (issues.length < STATUS_ISSUES_CAP) {
            issues.push(issue);
        }
    }

    return { issues, issueCount };
}


function recomputeIndexSummary(files, chunks, prior = {}) {
    const summary = {
        ...emptySummary(),
        inventoryFiles: prior.inventoryFiles ?? files.length,
        filesReprocessed: prior.filesReprocessed ?? 0,
        chunksEmbedded: prior.chunksEmbedded ?? 0,
        chunksReused: prior.chunksReused ?? 0,
    };

    summary.chunkCount = chunks.length;

    for (const file of files) {
        switch (file.status) {
            case "indexed":
                summary.indexedFiles += 1;
                summary.supportedFiles += 1;
                break;
            case "reused":
                summary.reusedFiles += 1;
                summary.indexedFiles += 1;
                summary.supportedFiles += 1;
                break;
            case "stale":
                summary.staleFiles += 1;
                summary.supportedFiles += 1;
                break;
            case "unsupported":
                summary.unsupportedFiles += 1;
                break;
            case "too_large":
                summary.tooLargeFiles += 1;
                summary.supportedFiles += 1;
                break;
            case "no_text":
                summary.noTextFiles += 1;
                summary.supportedFiles += 1;
                break;
            case "error":
                summary.errorFiles += 1;
                summary.supportedFiles += 1;
                break;
            case "unsafe":
            case "sensitive":
                summary.unsafeFiles += 1;
                break;
            default:
                break;
        }
    }

    return summary;
}


function fileIdentityKey(rootId, absolutePath) {
    return `${rootId}\0${normalizeCompare(absolutePath)}`;
}


function chunkIdFor(rootId, absolutePath, fingerprint, chunkIndex) {
    return crypto
        .createHash("sha256")
        .update(
            `${rootId}|${normalizeCompare(absolutePath)}|${fingerprint}|${chunkIndex}|v${CONTENT_EXTRACTOR_VERSION}`,
        )
        .digest("hex")
        .slice(0, 24);
}


/**
 * Normalize plain text extracted from files (data only).
 * @param {string} text
 */
export function normalizeExtractedText(text) {
    let value = String(text ?? "");
    value = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    value = value.replace(/\u0000/g, "");
    value = value.replace(/\n{3,}/g, "\n\n");
    return value;
}


/**
 * Deterministic text chunker with overlap.
 * Prefer paragraph / newline boundaries; avoid mid-word cuts.
 *
 * @param {string} text
 * @param {object} meta
 * @param {{ page?: number, startChar: number, endChar: number, text: string }[]} [pageSpans]
 */
export function chunkTextContent(text, meta, pageSpans = null) {
    const content = String(text ?? "");
    if (content.trim().length === 0) {
        return [];
    }

    const chunks = [];
    let start = 0;
    let chunkIndex = 0;

    while (start < content.length) {
        while (start < content.length && /\s/.test(content[start])) {
            start += 1;
        }
        if (start >= content.length) {
            break;
        }

        let end = Math.min(start + TARGET_CHUNK_CHARS, content.length);

        if (end < content.length) {
            const window = content.slice(start, end);
            const paraBreak = window.lastIndexOf("\n\n");
            const lineBreak = window.lastIndexOf("\n");
            const spaceBreak = window.lastIndexOf(" ");

            if (paraBreak >= TARGET_CHUNK_CHARS * 0.4) {
                end = start + paraBreak;
            } else if (lineBreak >= TARGET_CHUNK_CHARS * 0.5) {
                end = start + lineBreak;
            } else if (spaceBreak >= TARGET_CHUNK_CHARS * 0.5) {
                end = start + spaceBreak;
            }
        }

        if (end <= start) {
            end = Math.min(start + TARGET_CHUNK_CHARS, content.length);
        }

        let slice = content.slice(start, end);
        // Trim trailing partial word only when we cut mid-word mid-file.
        if (end < content.length && /\S/.test(content[end]) && /\S/.test(slice.at(-1) ?? "")) {
            const lastSpace = slice.lastIndexOf(" ");
            if (lastSpace > 0) {
                slice = slice.slice(0, lastSpace);
                end = start + slice.length;
            }
        }

        slice = slice.trimEnd();
        if (slice.trim().length === 0) {
            start = end;
            continue;
        }

        const endChar = start + slice.length;
        const pageRange = pageRangeForSpan(start, endChar, pageSpans);

        chunks.push({
            chunkId: chunkIdFor(
                meta.rootId,
                meta.absolutePath,
                meta.fingerprint,
                chunkIndex,
            ),
            rootId: meta.rootId,
            absolutePath: meta.absolutePath,
            relativePath: meta.relativePath,
            name: meta.name,
            extension: meta.extension,
            fingerprint: meta.fingerprint,
            chunkIndex,
            content: slice,
            startChar: start,
            endChar,
            pageStart: pageRange?.pageStart ?? null,
            pageEnd: pageRange?.pageEnd ?? null,
        });

        chunkIndex += 1;

        if (end >= content.length) {
            break;
        }

        const nextStart = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
        start = nextStart;
    }

    return chunks;
}


function pageRangeForSpan(startChar, endChar, pageSpans) {
    if (!Array.isArray(pageSpans) || pageSpans.length === 0) {
        return null;
    }

    let pageStart = null;
    let pageEnd = null;

    for (const span of pageSpans) {
        if (span.endChar <= startChar || span.startChar >= endChar) {
            continue;
        }
        if (pageStart === null || span.page < pageStart) {
            pageStart = span.page;
        }
        if (pageEnd === null || span.page > pageEnd) {
            pageEnd = span.page;
        }
    }

    if (pageStart === null) {
        return null;
    }

    return { pageStart, pageEnd };
}


/**
 * Decode UTF-8 from validated bytes and normalize.
 * @param {Buffer} buffer
 */
export function extractPlainTextFromBuffer(buffer) {
    const text = normalizeExtractedText(buffer.toString("utf8"));
    return {
        text,
        extractor: "text",
        pages: null,
        warnings: [],
    };
}


/**
 * @param {Buffer} buffer
 */
export async function extractDocxFromBuffer(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    const warnings = Array.isArray(result.messages)
        ? result.messages.map((message) => String(message.message ?? message))
        : [];

    return {
        text: normalizeExtractedText(result.value ?? ""),
        extractor: "docx",
        pages: null,
        warnings,
    };
}


/**
 * @param {Buffer} buffer
 */
export async function extractPdfFromBuffer(buffer) {
    const data = Uint8Array.from(buffer);
    const parser = new PDFParse({ data });

    try {
        const result = await parser.getText();
        const pages = [];
        const pageSpans = [];
        let combined = "";

        if (Array.isArray(result?.pages) && result.pages.length > 0) {
            for (let i = 0; i < result.pages.length; i += 1) {
                const pageEntry = result.pages[i];
                const pageNum =
                    typeof pageEntry?.num === "number"
                        ? pageEntry.num
                        : typeof pageEntry?.page === "number"
                          ? pageEntry.page
                          : i + 1;
                const pageText = normalizeExtractedText(
                    String(pageEntry?.text ?? ""),
                );
                pages.push({ page: pageNum, text: pageText });

                if (combined.length > 0 && pageText.length > 0) {
                    combined += "\n\n";
                }
                const startChar = combined.length;
                combined += pageText;
                pageSpans.push({
                    page: pageNum,
                    startChar,
                    endChar: combined.length,
                    text: pageText,
                });
            }
        } else {
            combined = normalizeExtractedText(String(result?.text ?? ""));
            if (combined.trim().length > 0) {
                pages.push({ page: 1, text: combined });
                pageSpans.push({
                    page: 1,
                    startChar: 0,
                    endChar: combined.length,
                    text: combined,
                });
            }
        }

        return {
            text: combined,
            extractor: "pdf",
            pages,
            pageSpans,
            warnings: [],
        };
    } finally {
        await parser.destroy();
    }
}


/**
 * Revalidate inventory row against live filesystem and return
 * owned file bytes when safe to read.
 *
 * @param {object} entry inventory file row
 * @param {object[]} roots current configured roots
 * @param {{ metaOnly?: boolean }} [options]
 */
export async function validateAndReadInventoryFile(entry, roots, options = {}) {
    const rootId = entry?.rootId;
    const absolutePath = entry?.absolutePath;
    const fingerprint = entry?.fingerprint;

    if (
        typeof rootId !== "string" ||
        typeof absolutePath !== "string" ||
        typeof fingerprint !== "string"
    ) {
        return { ok: false, status: "unsafe", reason: "Malformed inventory entry." };
    }

    const root = roots.find((item) => item.id === rootId);
    if (!root || typeof root.realPath !== "string") {
        return { ok: false, status: "unsafe", reason: "File root no longer exists." };
    }

    const resolvedLogical = path.resolve(absolutePath);
    if (!isPathInsideRoot(resolvedLogical, root.realPath)) {
        return {
            ok: false,
            status: "unsafe",
            reason: "Inventory path is outside its File Intelligence root.",
        };
    }

    let stats;
    try {
        stats = await fs.lstat(resolvedLogical);
    } catch {
        return { ok: false, status: "unsafe", reason: "File no longer exists." };
    }

    if (stats.isSymbolicLink()) {
        return { ok: false, status: "unsafe", reason: "Refusing symlink or junction." };
    }

    if (!stats.isFile()) {
        return { ok: false, status: "unsafe", reason: "Not a regular file." };
    }

    const baseName = path.basename(resolvedLogical);
    if (isSensitiveFilename(baseName)) {
        return { ok: false, status: "sensitive", reason: "Sensitive filename." };
    }

    let realPath;
    try {
        realPath = await fs.realpath(resolvedLogical);
    } catch {
        return { ok: false, status: "unsafe", reason: "Could not resolve real path." };
    }

    if (!isPathInsideRoot(realPath, root.realPath)) {
        return {
            ok: false,
            status: "unsafe",
            reason: "Resolved path escaped File Intelligence root.",
        };
    }

    const mtimeMs = Number(stats.mtimeMs);
    const currentFingerprint = `${stats.size}:${mtimeMs}`;
    if (currentFingerprint !== fingerprint) {
        return {
            ok: false,
            status: "stale",
            reason: "File changed since metadata scan.",
            currentFingerprint,
        };
    }

    if (stats.size > MAX_CONTENT_FILE_BYTES) {
        return {
            ok: false,
            status: "too_large",
            reason: `File exceeds ${MAX_CONTENT_FILE_BYTES} bytes.`,
            size: stats.size,
        };
    }

    // Prefer inventory size guard before read; re-check after lstat.
    const inventorySize = Number(entry.size);
    if (
        Number.isFinite(inventorySize) &&
        inventorySize > MAX_CONTENT_FILE_BYTES
    ) {
        return {
            ok: false,
            status: "too_large",
            reason: `File exceeds ${MAX_CONTENT_FILE_BYTES} bytes.`,
            size: inventorySize,
        };
    }

    if (options.metaOnly) {
        return {
            ok: true,
            realPath,
            size: stats.size,
            mtimeMs,
            fingerprint: currentFingerprint,
        };
    }

    const buffer = await fs.readFile(realPath);

    if (buffer.length > MAX_CONTENT_FILE_BYTES) {
        return {
            ok: false,
            status: "too_large",
            reason: `File exceeds ${MAX_CONTENT_FILE_BYTES} bytes.`,
            size: buffer.length,
        };
    }

    return {
        ok: true,
        realPath,
        buffer,
        size: stats.size,
        mtimeMs,
        fingerprint: currentFingerprint,
    };
}


async function extractFromValidatedBuffer(kind, buffer) {
    if (kind === "text") {
        return extractPlainTextFromBuffer(buffer);
    }
    if (kind === "docx") {
        return extractDocxFromBuffer(buffer);
    }
    if (kind === "pdf") {
        return extractPdfFromBuffer(buffer);
    }
    throw new Error(`Unsupported content kind: ${kind}`);
}


function canReuseFile(prevFile, entry, embeddingModel) {
    if (!prevFile) {
        return false;
    }

    // Only reuse files that previously produced searchable chunks.
    if (prevFile.status !== "indexed" && prevFile.status !== "reused") {
        return false;
    }

    return (
        prevFile.rootId === entry.rootId &&
        normalizeCompare(prevFile.absolutePath) ===
            normalizeCompare(entry.absolutePath) &&
        prevFile.fingerprint === entry.fingerprint &&
        prevFile.embeddingModel === embeddingModel &&
        prevFile.extractorVersion === CONTENT_EXTRACTOR_VERSION
    );
}


function priorChunksForFile(prevIndex, prevFile) {
    if (!prevIndex || !prevFile) {
        return [];
    }

    return prevIndex.chunks.filter(
        (chunk) =>
            chunk.rootId === prevFile.rootId &&
            normalizeCompare(chunk.absolutePath) ===
                normalizeCompare(prevFile.absolutePath) &&
            chunk.fingerprint === prevFile.fingerprint,
    );
}


/**
 * Embed texts with shared Ollama client (or test stub).
 * Failures are build-level — callers must not persist.
 *
 * @param {string[]} texts
 * @param {string} modelName
 */
async function embedTexts(texts, modelName) {
    if (texts.length === 0) {
        return [];
    }

    const runner = embedTextsFn ?? createEmbeddings;
    const embeddings = await runner(texts, modelName);

    if (!Array.isArray(embeddings)) {
        throw new Error("Embedding response was malformed: expected an array.");
    }

    if (embeddings.length !== texts.length) {
        throw new Error(
            `Embedding count mismatch: requested ${texts.length}, received ${embeddings.length}.`,
        );
    }

    for (let i = 0; i < embeddings.length; i += 1) {
        const vector = embeddings[i];
        if (
            !Array.isArray(vector) ||
            vector.length === 0 ||
            !vector.every((n) => typeof n === "number" && Number.isFinite(n))
        ) {
            throw new Error(
                `Embedding vector payload malformed at index ${i}.`,
            );
        }
    }

    return embeddings;
}


async function embedChunksInBatches(chunks, modelName) {
    const embedded = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const vectors = await embedTexts(
            batch.map((chunk) => chunk.content),
            modelName,
        );

        for (let j = 0; j < batch.length; j += 1) {
            embedded.push({
                ...batch[j],
                embedding: vectors[j],
            });
        }
    }

    return embedded;
}


function cosineSimilarity(vectorA, vectorB) {
    if (vectorA.length !== vectorB.length) {
        throw new Error("Cannot compare embeddings of different lengths.");
    }

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < vectorA.length; i += 1) {
        const a = vectorA[i];
        const b = vectorB[i];
        dot += a * b;
        magA += a * a;
        magB += b * b;
    }

    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);

    if (magA === 0 || magB === 0) {
        return 0;
    }

    return dot / (magA * magB);
}


function diversifyFileMatches(ranked, topK) {
    if (!Array.isArray(ranked) || ranked.length === 0 || topK <= 0) {
        return [];
    }

    const selected = [];
    const selectedIds = new Set();
    const perFile = new Map();

    for (const chunk of ranked) {
        if (selected.length >= topK) {
            break;
        }

        const fileKey = normalizeCompare(chunk.absolutePath);
        const count = perFile.get(fileKey) ?? 0;
        if (count >= 2) {
            continue;
        }

        selected.push(chunk);
        selectedIds.add(chunk.chunkId);
        perFile.set(fileKey, count + 1);
    }

    if (selected.length < topK) {
        for (const chunk of ranked) {
            if (selected.length >= topK) {
                break;
            }
            if (selectedIds.has(chunk.chunkId)) {
                continue;
            }
            selected.push(chunk);
            selectedIds.add(chunk.chunkId);
        }
    }

    return selected;
}


/**
 * Assert index is searchable with the current embedding model.
 * @param {object | null} index
 */
export function assertSearchableFileContentIndex(index) {
    if (!index) {
        const error = new Error(
            "File content index does not exist. Index file contents on the Files page first.",
        );
        error.status = 400;
        throw error;
    }

    if (index.embeddingModel !== EMBEDDING_MODEL) {
        const error = new Error(
            `File content index embedding model "${index.embeddingModel}" ` +
                `does not match current model "${EMBEDDING_MODEL}". ` +
                `Rebuild the File content index.`,
        );
        error.status = 409;
        throw error;
    }

    if (!Array.isArray(index.chunks) || index.chunks.length === 0) {
        const error = new Error(
            "File content index has no searchable chunks.",
        );
        error.status = 400;
        throw error;
    }

    for (const chunk of index.chunks) {
        if (
            !Array.isArray(chunk.embedding) ||
            chunk.embedding.length === 0 ||
            !chunk.embedding.every(
                (n) => typeof n === "number" && Number.isFinite(n),
            )
        ) {
            const error = new Error(
                "File content index contains malformed or incomplete embeddings. Rebuild the index.",
            );
            error.status = 500;
            throw error;
        }
    }
}


/**
 * Build / update the File content index from Phase 4A inventory.
 * Acquires the shared File Intelligence mutation lock.
 *
 * @param {object} [options]
 * @param {boolean} [options.skipModelCheck]
 */
export async function buildFileContentIndex(options = {}) {
    return runFileIntelligenceMutation("contentIndex", async () => {
        return buildFileContentIndexUnlocked(options);
    });
}


/**
 * Index build body. Caller must hold the contentIndex lock
 * (or be a test using _test helpers carefully).
 *
 * @param {object} [options]
 */
export async function buildFileContentIndexUnlocked(options = {}) {
    const inventory = await getInventory();

    if (!inventory || inventory.scannedAt == null) {
        const error = new Error(
            "Scan folders first. File content indexing requires a Phase 4A metadata inventory.",
        );
        error.status = 400;
        throw error;
    }

    if (!options.skipModelCheck && !embedTextsFn) {
        await ensureModelAvailable(EMBEDDING_MODEL);
    }

    const roots = await listRoots();
    const previous = await loadFileContentIndex();
    const previousByIdentity = new Map();

    if (previous) {
        for (const file of previous.files) {
            previousByIdentity.set(
                fileIdentityKey(file.rootId, file.absolutePath),
                file,
            );
        }
    }

    const nextFiles = [];
    const reusedChunks = [];
    const pendingChunks = [];
    let filesReprocessed = 0;
    let chunksReused = 0;

    for (const entry of inventory.files) {
        const kind = contentKindForExtension(entry.extension);
        const identity = fileIdentityKey(entry.rootId, entry.absolutePath);
        const prevFile = previousByIdentity.get(identity);

        if (!kind) {
            nextFiles.push({
                rootId: entry.rootId,
                absolutePath: entry.absolutePath,
                relativePath: entry.relativePath,
                name: entry.name,
                extension: entry.extension,
                fingerprint: entry.fingerprint,
                status: "unsupported",
                extractor: null,
                extractorVersion: CONTENT_EXTRACTOR_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                chunkCount: 0,
                warnings: [],
                error: toPersistedFileError("unsupported", null),
            });
            continue;
        }

        // Size guard from inventory before any FS open when possible.
        if (
            Number.isFinite(Number(entry.size)) &&
            Number(entry.size) > MAX_CONTENT_FILE_BYTES
        ) {
            nextFiles.push({
                rootId: entry.rootId,
                absolutePath: entry.absolutePath,
                relativePath: entry.relativePath,
                name: entry.name,
                extension: entry.extension,
                fingerprint: entry.fingerprint,
                status: "too_large",
                extractor: kind,
                extractorVersion: CONTENT_EXTRACTOR_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                chunkCount: 0,
                warnings: [],
                error: toPersistedFileError("too_large", kind),
            });
            continue;
        }

        if (canReuseFile(prevFile, entry, EMBEDDING_MODEL)) {
            // Reuse key matches inventory, but disk may have changed
            // since the metadata scan — always revalidate before reuse.
            let reuseCheck;
            try {
                reuseCheck = await validateAndReadInventoryFile(entry, roots, {
                    metaOnly: true,
                });
            } catch (error) {
                console.error(
                    `File content validation failed for ${entry.relativePath}:`,
                    error,
                );
                nextFiles.push({
                    rootId: entry.rootId,
                    absolutePath: entry.absolutePath,
                    relativePath: entry.relativePath,
                    name: entry.name,
                    extension: entry.extension,
                    fingerprint: entry.fingerprint,
                    status: "error",
                    extractor: kind,
                    extractorVersion: CONTENT_EXTRACTOR_VERSION,
                    embeddingModel: EMBEDDING_MODEL,
                    chunkCount: 0,
                    warnings: [],
                    error: toPersistedFileError("error", kind),
                });
                continue;
            }

            if (!reuseCheck.ok) {
                nextFiles.push({
                    rootId: entry.rootId,
                    absolutePath: entry.absolutePath,
                    relativePath: entry.relativePath,
                    name: entry.name,
                    extension: entry.extension,
                    fingerprint: entry.fingerprint,
                    status: reuseCheck.status,
                    extractor: kind,
                    extractorVersion: CONTENT_EXTRACTOR_VERSION,
                    embeddingModel: EMBEDDING_MODEL,
                    chunkCount: 0,
                    warnings: [],
                    error: toPersistedFileError(reuseCheck.status, kind),
                });
                // Do not retain prior chunks for stale/unsafe/etc.
                continue;
            }

            const oldChunks = priorChunksForFile(previous, prevFile);
            if (
                oldChunks.length > 0 &&
                oldChunks.every(
                    (chunk) =>
                        Array.isArray(chunk.embedding) &&
                        chunk.embedding.length > 0,
                )
            ) {
                nextFiles.push({
                    ...prevFile,
                    status: "reused",
                    relativePath: entry.relativePath,
                    name: entry.name,
                    extension: entry.extension,
                    chunkCount: oldChunks.length,
                });
                reusedChunks.push(...oldChunks);
                chunksReused += oldChunks.length;
                continue;
            }
        }

        filesReprocessed += 1;

        let validated;
        try {
            validated = await validateAndReadInventoryFile(entry, roots);
        } catch (error) {
            console.error(
                `File content validation failed for ${entry.relativePath}:`,
                error,
            );
            nextFiles.push({
                rootId: entry.rootId,
                absolutePath: entry.absolutePath,
                relativePath: entry.relativePath,
                name: entry.name,
                extension: entry.extension,
                fingerprint: entry.fingerprint,
                status: "error",
                extractor: kind,
                extractorVersion: CONTENT_EXTRACTOR_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                chunkCount: 0,
                warnings: [],
                error: toPersistedFileError("error", kind),
            });
            continue;
        }

        if (!validated.ok) {
            nextFiles.push({
                rootId: entry.rootId,
                absolutePath: entry.absolutePath,
                relativePath: entry.relativePath,
                name: entry.name,
                extension: entry.extension,
                fingerprint: entry.fingerprint,
                status: validated.status,
                extractor: kind,
                extractorVersion: CONTENT_EXTRACTOR_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                chunkCount: 0,
                warnings: [],
                error: toPersistedFileError(validated.status, kind),
            });
            // Intentionally do NOT copy prior chunks for stale/unsafe/etc.
            continue;
        }

        let extracted;
        try {
            extracted = await extractFromValidatedBuffer(kind, validated.buffer);
        } catch (error) {
            console.error(
                `File content extraction failed for ${entry.relativePath}:`,
                error,
            );
            nextFiles.push({
                rootId: entry.rootId,
                absolutePath: entry.absolutePath,
                relativePath: entry.relativePath,
                name: entry.name,
                extension: entry.extension,
                fingerprint: entry.fingerprint,
                status: "error",
                extractor: kind,
                extractorVersion: CONTENT_EXTRACTOR_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                chunkCount: 0,
                warnings: [],
                error: toPersistedFileError("error", kind),
            });
            continue;
        }

        if (extracted.text.trim().length === 0) {
            nextFiles.push({
                rootId: entry.rootId,
                absolutePath: entry.absolutePath,
                relativePath: entry.relativePath,
                name: entry.name,
                extension: entry.extension,
                fingerprint: entry.fingerprint,
                status: "no_text",
                extractor: extracted.extractor,
                extractorVersion: CONTENT_EXTRACTOR_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                chunkCount: 0,
                warnings: extracted.warnings ?? [],
                error: toPersistedFileError("no_text", extracted.extractor),
            });
            continue;
        }

        const meta = {
            rootId: entry.rootId,
            absolutePath: entry.absolutePath,
            relativePath: entry.relativePath,
            name: entry.name,
            extension: entry.extension,
            fingerprint: entry.fingerprint,
        };

        const fileChunks = chunkTextContent(
            extracted.text,
            meta,
            extracted.pageSpans ?? null,
        );

        if (fileChunks.length === 0) {
            nextFiles.push({
                rootId: entry.rootId,
                absolutePath: entry.absolutePath,
                relativePath: entry.relativePath,
                name: entry.name,
                extension: entry.extension,
                fingerprint: entry.fingerprint,
                status: "no_text",
                extractor: extracted.extractor,
                extractorVersion: CONTENT_EXTRACTOR_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                chunkCount: 0,
                warnings: extracted.warnings ?? [],
                error: toPersistedFileError("no_text", extracted.extractor),
            });
            continue;
        }

        pendingChunks.push(...fileChunks);
        nextFiles.push({
            rootId: entry.rootId,
            absolutePath: entry.absolutePath,
            relativePath: entry.relativePath,
            name: entry.name,
            extension: entry.extension,
            fingerprint: entry.fingerprint,
            status: "indexed",
            extractor: extracted.extractor,
            extractorVersion: CONTENT_EXTRACTOR_VERSION,
            embeddingModel: EMBEDDING_MODEL,
            chunkCount: fileChunks.length,
            warnings: extracted.warnings ?? [],
            error: null,
        });
    }

    // Build-level embedding: failure aborts without writing.
    let newlyEmbedded = [];
    try {
        newlyEmbedded = await embedChunksInBatches(pendingChunks, EMBEDDING_MODEL);
    } catch (error) {
        console.error("File content indexing embedding failed:", error);
        const wrapped = new Error(
            "Could not reach Ollama while creating embeddings.",
        );
        wrapped.status = error.status ?? 503;
        wrapped.cause = error;
        throw wrapped;
    }

    const allChunks = [...reusedChunks, ...newlyEmbedded];
    const summary = recomputeIndexSummary(nextFiles, allChunks, {
        inventoryFiles: inventory.files.length,
        filesReprocessed,
        chunksEmbedded: newlyEmbedded.length,
        chunksReused,
    });
    summary.inventoryFiles = inventory.files.length;
    summary.filesReprocessed = filesReprocessed;
    summary.chunksEmbedded = newlyEmbedded.length;
    summary.chunksReused = chunksReused;

    const candidate = {
        version: CONTENT_INDEX_VERSION,
        extractorVersion: CONTENT_EXTRACTOR_VERSION,
        createdAt: new Date().toISOString(),
        embeddingModel: EMBEDDING_MODEL,
        inventoryScannedAt: inventory.scannedAt,
        summary,
        files: nextFiles,
        chunks: allChunks,
    };

    await saveFileContentIndex(candidate);
    return summary;
}


/**
 * @returns {Promise<object>}
 */
export async function getFileContentIndexStatus() {
    const inventory = await getInventory();
    const index = await loadFileContentIndex();
    const summary = index?.summary ?? emptySummary();
    const { issues, issueCount } = buildStatusIssues(index?.files ?? []);

    return {
        inventoryExists: inventory !== null && inventory.scannedAt != null,
        inventoryScannedAt: inventory?.scannedAt ?? null,
        inventoryFiles: inventory?.files?.length ?? 0,
        indexExists: index !== null && index.createdAt != null,
        indexedAt: index?.createdAt ?? null,
        embeddingModel: index?.embeddingModel ?? EMBEDDING_MODEL,
        extractorVersion: index?.extractorVersion ?? null,
        indexedFiles: summary.indexedFiles ?? 0,
        reusedFiles: summary.reusedFiles ?? 0,
        chunkCount: summary.chunkCount ?? 0,
        supportedFiles: summary.supportedFiles ?? 0,
        unsupportedFiles: summary.unsupportedFiles ?? 0,
        staleFiles: summary.staleFiles ?? 0,
        tooLargeFiles: summary.tooLargeFiles ?? 0,
        noTextFiles: summary.noTextFiles ?? 0,
        errorFiles: summary.errorFiles ?? 0,
        unsafeFiles: summary.unsafeFiles ?? 0,
        indexing: isFileContentIndexing(),
        issueCount,
        issues,
        summary,
    };
}


/**
 * Semantic search over the File content index.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {string} [options.rootId]
 * @param {string} [options.extension]
 * @param {number} [options.limit]
 * @param {boolean} [options.skipModelCheck]
 */
export async function searchFileContent(query, options = {}) {
    const question = typeof query === "string" ? query.trim() : "";
    if (!question) {
        throw new Error("Search query is required.");
    }

    const index = await loadFileContentIndex();
    assertSearchableFileContentIndex(index);

    if (!options.skipModelCheck && !embedTextsFn) {
        await ensureModelAvailable(EMBEDDING_MODEL);
    }

    const [queryEmbedding] = await embedTexts([question], EMBEDDING_MODEL);

    let limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) {
        limit = FILE_TOP_K;
    }
    limit = Math.min(limit, 20);

    const rootId =
        typeof options.rootId === "string" && options.rootId.trim()
            ? options.rootId.trim()
            : null;
    const extensionRaw =
        typeof options.extension === "string" ? options.extension.trim() : "";
    const extension = extensionRaw
        ? extensionRaw.replace(/^\./, "").toLowerCase()
        : null;

    const scored = [];

    for (const chunk of index.chunks) {
        if (rootId && chunk.rootId !== rootId) {
            continue;
        }
        if (extension && chunk.extension !== extension) {
            continue;
        }

        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        scored.push({ ...chunk, similarity });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const selected = diversifyFileMatches(scored, limit);

    return selected.map((chunk) => ({
        sourceType: "file",
        chunkId: chunk.chunkId,
        rootId: chunk.rootId,
        filePath: chunk.relativePath,
        absolutePath: chunk.absolutePath,
        name: chunk.name,
        extension: chunk.extension,
        chunkIndex: chunk.chunkIndex,
        similarity: chunk.similarity,
        pageStart: chunk.pageStart ?? undefined,
        pageEnd: chunk.pageEnd ?? undefined,
        preview: clampPreview(chunk.content),
        content: chunk.content,
    }));
}


function clampPreview(text) {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= PREVIEW_MAX_CHARS) {
        return normalized;
    }
    return `${normalized.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}


/** Test helpers — not for production routes. */
export const _test = {
    contentIndexPath,
    TARGET_CHUNK_CHARS,
    CHUNK_OVERLAP_CHARS,
    TEXT_EXTENSIONS,
    DOCUMENT_EXTENSIONS,
    setEmbedTextsFn(fn) {
        embedTextsFn = fn;
    },
    clearEmbedTextsFn() {
        embedTextsFn = null;
    },
    cosineSimilarity,
    diversifyFileMatches,
    fileIdentityKey,
    chunkIdFor,
    canReuseFile,
    buildFileContentIndexUnlocked,
    normalizeCompare,
};
