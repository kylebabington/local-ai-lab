// =========================================================
// scripts/verify-conversation-lifecycle.js
//
// New conversation / archive / forget lifecycle verification.
// Sandbox only — never touches real user data.
// =========================================================


import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, ".conversation-lifecycle-test-sandbox");
const TRANSCRIPT_FILE = path.join(SANDBOX, "conversation-transcript.json");
const LEGACY_FILE = path.join(SANDBOX, "legacy-chat-history.json");
const MEMORY_FILE = path.join(SANDBOX, "conversation-memory-index.json");
const ARCHIVE_DIR = path.join(SANDBOX, "conversation-archive");
const CHAT_HISTORY = path.join(SANDBOX, "chat-history.json");

process.env.LOCAL_AI_TRANSCRIPT_PATH = TRANSCRIPT_FILE;
process.env.LOCAL_AI_TRANSCRIPT_LEGACY_HISTORY_PATH = LEGACY_FILE;
process.env.LOCAL_AI_CONVERSATION_MEMORY_INDEX_PATH = MEMORY_FILE;
process.env.LOCAL_AI_CONVERSATION_ARCHIVE_DIR = ARCHIVE_DIR;

const {
    appendMessages,
    getTranscript,
    initializeTranscript,
    _resetTranscriptStateForTests,
} = await import("../lib/conversation-transcript.js");

const {
    archiveConversationPath,
    initializeArchive,
    listArchivedConversationMetadata,
    loadAllArchivedConversations,
    _resetArchiveStateForTests,
} = await import("../lib/conversation-archive.js");

const memoryMod = await import("../lib/conversation-memory.js");
const {
    buildConversationMemoryIndex,
    searchConversationMemory,
    _resetConversationMemoryStateForTests,
} = memoryMod;
const memoryTest = memoryMod._test;

const {
    forgetAllConversations,
    forgetConversation,
    startNewConversation,
    _resetLifecycleStateForTests,
    _setLifecycleFailAfterStageForTests,
} = await import("../lib/conversation-lifecycle.js");

const results = [];


function pass(name, detail = "") {
    results.push({ status: "pass", name, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}


function fail(name, detail) {
    results.push({ status: "fail", name, detail });
    console.error(`FAIL  ${name} — ${detail}`);
}


function stubEmbed(texts) {
    return texts.map((text) => {
        const vector = new Array(16).fill(0);
        const normalized = String(text).toLowerCase();
        for (let i = 0; i < normalized.length; i += 1) {
            const code = normalized.charCodeAt(i);
            vector[code % 16] += 1;
            vector[(code * 3) % 16] += 0.25;
        }
        if (normalized.includes("lantern")) {
            vector[0] += 8;
        }
        if (normalized.includes("landscap")) {
            vector[1] += 8;
        }
        const magnitude = Math.sqrt(
            vector.reduce((sum, value) => sum + value * value, 0),
        );
        if (magnitude === 0) {
            return vector;
        }
        return vector.map((value) => value / magnitude);
    });
}


async function resetSandbox() {
    _resetConversationMemoryStateForTests();
    _resetLifecycleStateForTests();
    _resetTranscriptStateForTests();
    _resetArchiveStateForTests();

    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            await fs.rm(SANDBOX, { recursive: true, force: true });
            break;
        } catch (error) {
            if (attempt === 7) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
    }

    await fs.mkdir(SANDBOX, { recursive: true });

    process.env.LOCAL_AI_TRANSCRIPT_PATH = TRANSCRIPT_FILE;
    process.env.LOCAL_AI_TRANSCRIPT_LEGACY_HISTORY_PATH = LEGACY_FILE;
    process.env.LOCAL_AI_CONVERSATION_MEMORY_INDEX_PATH = MEMORY_FILE;
    process.env.LOCAL_AI_CONVERSATION_ARCHIVE_DIR = ARCHIVE_DIR;

    _resetTranscriptStateForTests();
    _resetArchiveStateForTests();
    _resetConversationMemoryStateForTests();
    _resetLifecycleStateForTests();
    memoryTest.setEmbedTextsFn(stubEmbed);

    await initializeTranscript();
    await initializeArchive();
}


async function forgetOne(id) {
    const result = await forgetConversation(id);
    await flushMemory();
    return result;
}

async function forgetEverything() {
    const result = await forgetAllConversations();
    await flushMemory();
    return result;
}

async function newConversation() {
    const result = await startNewConversation();
    await flushMemory();
    return result;
}

async function flushMemory() {
    try {
        return await buildConversationMemoryIndex({ skipEnsureModel: true });
    } catch (error) {
        if (
            error.code === "MEMORY_TRANSCRIPT_CHANGED" ||
            error.code === "MEMORY_GENERATION_CHANGED"
        ) {
            return buildConversationMemoryIndex({ skipEnsureModel: true });
        }
        throw error;
    }
}


async function currentId() {
    return (await getTranscript()).conversationId;
}


async function append(messages) {
    return appendMessages(await currentId(), messages);
}


function msg(role, content, overrides = {}) {
    return {
        id: overrides.id ?? crypto.randomUUID(),
        role,
        content,
        createdAt: overrides.createdAt ?? new Date().toISOString(),
        contextMode: overrides.contextMode ?? "chat",
    };
}


async function testNewPreservesMemory() {
    await resetSandbox();
    await append([
        msg("user", "Lantern Table helps game stores match players.", {
            id: "u-lantern",
        }),
        msg("assistant", "Lantern Table sounds promising for independent stores.", {
            id: "a-lantern",
        }),
    ]);
    await buildConversationMemoryIndex({ skipEnsureModel: true });

    const beforeId = await currentId();
    await newConversation();
    await flushMemory();

    const current = await getTranscript();
    if (current.messages.length !== 0) {
        throw new Error("Current transcript should be empty.");
    }
    if (current.conversationId === beforeId) {
        throw new Error("Expected a new conversationId.");
    }

    const archived = await listArchivedConversationMetadata();
    if (!archived.conversations.some((item) => item.id === beforeId)) {
        throw new Error("Conversation A was not archived.");
    }

    await buildConversationMemoryIndex({ skipEnsureModel: true });
    const search = await searchConversationMemory("Lantern Table game stores", {
        skipEnsureModel: true,
    });
    if (search.results.length === 0) {
        throw new Error("Lantern Table should still be searchable.");
    }

    pass("A. New conversation preserves historical memory");
}


async function testMultipleBoundaries() {
    await resetSandbox();

    await append([msg("user", "Idea A lantern", { id: "u-a" })]);
    const idA = await currentId();
    await newConversation();

    await append([msg("user", "Idea B landscaping", { id: "u-b" })]);
    const idB = await currentId();
    await newConversation();

    await append([msg("user", "Idea C current", { id: "u-c" })]);
    const idC = await currentId();

    const archived = await listArchivedConversationMetadata();
    const archivedIds = archived.conversations.map((item) => item.id).sort();
    if (archivedIds.join(",") !== [idA, idB].sort().join(",")) {
        throw new Error(`Expected archive A+B, got ${archivedIds.join(",")}`);
    }
    if (idC === idA || idC === idB) {
        throw new Error("Current should be distinct C.");
    }

    await buildConversationMemoryIndex({ skipEnsureModel: true });
    const searchA = await searchConversationMemory("lantern", {
        skipEnsureModel: true,
    });
    const searchB = await searchConversationMemory("landscaping", {
        skipEnsureModel: true,
    });
    if (searchA.results.length === 0 || searchB.results.length === 0) {
        throw new Error("Memory should search across A and B.");
    }

    pass("B. multiple conversation boundaries");
}


async function testEmptySkip() {
    await resetSandbox();
    const before = await listArchivedConversationMetadata();
    await newConversation();
    await newConversation();
    const after = await listArchivedConversationMetadata();
    if (after.conversations.length !== before.conversations.length) {
        throw new Error("Empty conversations must not create archive records.");
    }
    pass("D. empty conversation skipped");
}


async function testLateResponseAfterNew() {
    await resetSandbox();
    const idA = await currentId();
    await append([
        msg("user", "Tell me about this idea.", { id: "u-late" }),
    ]);

    await newConversation();
    await flushMemory();
    const idB = await currentId();
    const current = await getTranscript();
    if (current.messages.length !== 0) {
        throw new Error("B should be empty.");
    }

    let rejected = false;
    try {
        await appendMessages(idA, [
            msg("assistant", "Late reply about the idea.", { id: "a-late" }),
        ]);
    } catch (error) {
        if (error.status === 409 || error.code === "CONVERSATION_CHANGED") {
            rejected = true;
        } else {
            throw error;
        }
    }

    if (!rejected) {
        throw new Error("Late append into A should return 409/closed.");
    }

    const stillB = await getTranscript();
    if (stillB.conversationId !== idB || stillB.messages.length !== 0) {
        throw new Error("B must remain empty and current.");
    }

    const archived = await loadAllArchivedConversations();
    const a = archived.conversations.find((item) => item.id === idA);
    if (!a) {
        throw new Error("A missing from archive.");
    }
    if (a.messages.some((item) => item.id === "a-late")) {
        throw new Error("A must not mutate after archival.");
    }
    if (!a.messages.some((item) => item.id === "u-late")) {
        throw new Error("A should contain the persisted user message.");
    }

    pass("O. late inference response after New");
}


async function testStaleTabWrite() {
    await resetSandbox();
    const idA = await currentId();
    await append([msg("user", "A content", { id: "u-a" })]);
    await newConversation();
    await flushMemory();
    const idB = await currentId();

    let rejected = false;
    try {
        await appendMessages(idA, [msg("user", "stale tab", { id: "u-stale" })]);
    } catch (error) {
        if (error.status === 409) {
            rejected = true;
        } else {
            throw error;
        }
    }
    if (!rejected) {
        throw new Error("Expected 409 for stale-tab write.");
    }

    const current = await getTranscript();
    if (current.conversationId !== idB || current.messages.length !== 0) {
        throw new Error("B must be unchanged.");
    }

    pass("Q. stale-tab write rejected");
}


async function testRetryAfterPartialFailure() {
    await resetSandbox();
    await append([msg("user", "Partial failure lantern", { id: "u-partial" })]);
    const idA = await currentId();

    _setLifecycleFailAfterStageForTests("after-archive");
    let failed = false;
    try {
        await newConversation();
    } catch (error) {
        if (error.code === "LIFECYCLE_INJECTED_FAILURE") {
            failed = true;
        } else {
            throw error;
        }
    }
    if (!failed) {
        throw new Error("Expected injected failure after archive.");
    }

    // A should already be archived once.
    const mid = await listArchivedConversationMetadata();
    if (mid.conversations.filter((item) => item.id === idA).length !== 1) {
        throw new Error("Expected exactly one archive entry after partial failure.");
    }

    _setLifecycleFailAfterStageForTests(null);
    await newConversation();

    const archived = await listArchivedConversationMetadata();
    if (archived.conversations.filter((item) => item.id === idA).length !== 1) {
        throw new Error("Retry must not duplicate archived A.");
    }

    const current = await getTranscript();
    if (current.conversationId === idA || current.messages.length !== 0) {
        throw new Error("Retry should finish with a fresh current conversation.");
    }

    const filePath = archiveConversationPath(idA);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.messages.some((item) => item.id === "u-partial")) {
        throw new Error("Canonical messages lost after retry.");
    }

    pass("P. New retry after partial failure");
}


async function testArchivePathSafety() {
    await resetSandbox();
    let rejected = false;
    try {
        archiveConversationPath("../evil");
    } catch (error) {
        if (error.code === "CONVERSATION_ID_INVALID" || error.status === 400) {
            rejected = true;
        } else {
            throw error;
        }
    }
    if (!rejected) {
        throw new Error("Path traversal id must be rejected.");
    }

    rejected = false;
    try {
        archiveConversationPath("not-a-uuid");
    } catch (error) {
        if (error.code === "CONVERSATION_ID_INVALID") {
            rejected = true;
        } else {
            throw error;
        }
    }
    if (!rejected) {
        throw new Error("Invalid UUID must be rejected.");
    }

    pass("R. archive path safety");
}


async function testArchiveAppendScale() {
    await resetSandbox();

    const hashes = [];
    for (let i = 0; i < 5; i += 1) {
        await append([
            msg("user", `Older conversation ${i}`, { id: `u-old-${i}` }),
        ]);
        const id = await currentId();
        await newConversation();
        const filePath = archiveConversationPath(id);
        const raw = await fs.readFile(filePath, "utf8");
        const stat = await fs.stat(filePath);
        hashes.push({
            id,
            hash: crypto.createHash("sha256").update(raw).digest("hex"),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
        });
    }

    await append([msg("user", "Brand new conversation", { id: "u-new" })]);
    const newId = await currentId();
    await newConversation();

    for (const prior of hashes) {
        const filePath = archiveConversationPath(prior.id);
        const raw = await fs.readFile(filePath, "utf8");
        const hash = crypto.createHash("sha256").update(raw).digest("hex");
        if (hash !== prior.hash) {
            throw new Error(`Older archive file rewritten: ${prior.id}`);
        }
    }

    await fs.access(archiveConversationPath(newId));
    const manifest = JSON.parse(
        await fs.readFile(path.join(ARCHIVE_DIR, "manifest.json"), "utf8"),
    );
    if (!manifest.conversations.some((item) => item.id === newId)) {
        throw new Error("Manifest missing new conversation.");
    }

    pass("S. archive append scale (older files unchanged)");
}


async function testForgetOnePhysical() {
    await resetSandbox();
    await append([msg("user", "Forget me lantern", { id: "u-del" })]);
    const idA = await currentId();
    await newConversation();
    await append([msg("user", "Keep me landscaping", { id: "u-keep" })]);
    await buildConversationMemoryIndex({ skipEnsureModel: true });

    await forgetOne(idA);

    let missing = false;
    try {
        await fs.access(archiveConversationPath(idA));
    } catch (error) {
        if (error.code === "ENOENT") {
            missing = true;
        } else {
            throw error;
        }
    }
    if (!missing) {
        throw new Error("Canonical archive file should be deleted.");
    }

    await buildConversationMemoryIndex({ skipEnsureModel: true });
    const search = await searchConversationMemory("Forget me lantern", {
        skipEnsureModel: true,
    });
    if (search.results.some((result) => result.preview.includes("Forget me"))) {
        throw new Error("Deleted conversation still reconstructable.");
    }

    const keepSearch = await searchConversationMemory("landscaping", {
        skipEnsureModel: true,
    });
    if (keepSearch.results.length === 0) {
        throw new Error("Other conversations must remain.");
    }

    pass("T. Forget one physical deletion");
}


async function testForgetAll() {
    await resetSandbox();
    await append([msg("user", "wipe lantern", { id: "u-wipe" })]);
    await newConversation();
    await append([msg("user", "wipe landscaping", { id: "u-wipe-2" })]);
    await buildConversationMemoryIndex({ skipEnsureModel: true });

    await forgetEverything();

    const current = await getTranscript();
    if (current.messages.length !== 0) {
        throw new Error("Current should be empty after forget all.");
    }

    const archived = await listArchivedConversationMetadata();
    if (archived.conversations.length !== 0) {
        throw new Error("Archive manifest should be empty.");
    }

    const entries = await fs.readdir(ARCHIVE_DIR);
    const conversationFiles = entries.filter(
        (name) => name.endsWith(".json") && name !== "manifest.json",
    );
    if (conversationFiles.length !== 0) {
        throw new Error("Canonical archive files remain after forget all.");
    }

    const search = await searchConversationMemory("lantern", {
        skipEnsureModel: true,
    });
    if (search.results.length !== 0) {
        throw new Error("Memory search should be empty after forget all.");
    }

    pass("F. Forget all");
}


async function testEmbeddingReuseOnArchive() {
    await resetSandbox();
    await append([
        msg("user", "Lantern Table reuse check", { id: "u-reuse" }),
        msg("assistant", "Reuse embeddings after archive.", { id: "a-reuse" }),
    ]);
    const first = await flushMemory();
    if (!first || first.chunks < 1) {
        throw new Error("Expected initial chunks before archive.");
    }

    await newConversation();
    const second = await flushMemory();

    if (!second || second.chunksReused < 1) {
        throw new Error(
            `Expected embedding reuse after archive; reused=${second?.chunksReused} firstChunks=${first.chunks}`,
        );
    }

    pass("H. archive transition embedding reuse", `reused=${second.chunksReused}`);
}


async function testMalformedArchive() {
    await resetSandbox();
    await append([msg("user", "ok", { id: "u-ok" })]);
    const id = await currentId();
    await newConversation();

    await fs.writeFile(
        archiveConversationPath(id),
        "{ not valid json",
        "utf8",
    );

    let failed = false;
    try {
        await loadAllArchivedConversations();
    } catch (error) {
        if (error.code === "ARCHIVE_MALFORMED") {
            failed = true;
        } else {
            throw error;
        }
    }
    if (!failed) {
        throw new Error("Malformed archive must fail loudly.");
    }

    // File still present — not silently erased.
    await fs.access(archiveConversationPath(id));
    pass("N. malformed archive fails loudly");
}


async function main() {
    const tests = [
        testNewPreservesMemory,
        testMultipleBoundaries,
        testEmptySkip,
        testLateResponseAfterNew,
        testStaleTabWrite,
        testRetryAfterPartialFailure,
        testArchivePathSafety,
        testArchiveAppendScale,
        testForgetOnePhysical,
        testForgetAll,
        testEmbeddingReuseOnArchive,
        testMalformedArchive,
    ];

    for (const test of tests) {
        try {
            await test();
        } catch (error) {
            fail(test.name, error.stack ?? error.message);
        }
    }

    const failed = results.filter((item) => item.status === "fail");
    console.log("");
    console.log(
        `Lifecycle verify: ${results.length - failed.length}/${results.length} passed`,
    );

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}


await main();
