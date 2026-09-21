// =========================================================
// scripts/verify-conversation-transcript.js
//
// Unified conversation transcript verification.
// Uses .transcript-test-sandbox/ only — never the real
// data/conversation-transcript.json or chat-history.json.
// =========================================================


import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, ".transcript-test-sandbox");
const TRANSCRIPT_FILE = path.join(SANDBOX, "conversation-transcript.json");
const LEGACY_HISTORY = path.join(SANDBOX, "legacy-chat-history.json");

process.env.LOCAL_AI_TRANSCRIPT_PATH = TRANSCRIPT_FILE;
process.env.LOCAL_AI_TRANSCRIPT_LEGACY_HISTORY_PATH = LEGACY_HISTORY;
process.env.LOCAL_AI_TRANSCRIPT_MAX_BYTES = String(8 * 1024);

const {
    appendMessages,
    clearTranscript,
    getTranscript,
    initializeTranscript,
    patchMessage,
    _resetTranscriptStateForTests,
    _test,
} = await import("../lib/conversation-transcript.js");


async function currentConversationId() {
    const transcript = await getTranscript();
    return transcript.conversationId;
}

async function appendToCurrent(messages) {
    return appendMessages(await currentConversationId(), messages);
}

async function patchCurrent(id, patch) {
    return patchMessage(await currentConversationId(), id, patch);
}

const results = [];


function pass(name, detail = "") {
    results.push({ status: "pass", name, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}


function fail(name, detail) {
    results.push({ status: "fail", name, detail });
    console.error(`FAIL  ${name} — ${detail}`);
}


async function expectThrow(fn, needle) {
    try {
        await fn();
    } catch (error) {
        if (needle && !String(error.message).includes(needle)) {
            throw new Error(
                `Expected error containing ${JSON.stringify(needle)}, got: ${error.message}`,
            );
        }
        return error;
    }

    throw new Error("Expected function to throw.");
}


async function resetSandbox() {
    await fs.rm(SANDBOX, { recursive: true, force: true });
    await fs.mkdir(SANDBOX, { recursive: true });
    _resetTranscriptStateForTests();
}


function sampleUser(overrides = {}) {
    return {
        id: "user-1",
        role: "user",
        content: "What does my resume say?",
        createdAt: "2026-09-20T12:00:00.000Z",
        contextMode: "file",
        ...overrides,
    };
}


function sampleAssistant(overrides = {}) {
    return {
        id: "assistant-1",
        role: "assistant",
        content: "It mentions TypeScript.",
        createdAt: "2026-09-20T12:00:01.000Z",
        contextMode: "file",
        ...overrides,
    };
}


async function testFailedTurnPersistence() {
    await resetSandbox();
    await initializeTranscript();

    await appendToCurrent([sampleUser()]);

    // Simulate File backend failure: no assistant append.
    _resetTranscriptStateForTests();
    const reloaded = await getTranscript();

    if (reloaded.messages.length !== 1) {
        throw new Error(`Expected 1 message, got ${reloaded.messages.length}`);
    }

    if (reloaded.messages[0].role !== "user") {
        throw new Error("Expected the user message to remain.");
    }

    if (reloaded.messages[0].content !== "What does my resume say?") {
        throw new Error("User content was not preserved.");
    }

    if (reloaded.messages.some((item) => item.role === "assistant")) {
        throw new Error("Unexpected assistant message after failed turn.");
    }

    pass("failed-turn persistence", "user File message survives reload without assistant");
}


async function testAppendIdempotent() {
    await resetSandbox();
    await initializeTranscript();

    await appendToCurrent([sampleUser(), sampleAssistant()]);
    const second = await appendToCurrent([sampleUser()]);

    if (second.appended !== 0) {
        throw new Error(`Expected 0 appended on duplicate, got ${second.appended}`);
    }

    const { messages } = await getTranscript();
    if (messages.length !== 2) {
        throw new Error(`Expected 2 messages after idempotent retry, got ${messages.length}`);
    }

    pass("append idempotent", "duplicate ids do not create duplicates");
}


async function testPatchApprovalStatus() {
    await resetSandbox();
    await initializeTranscript();

    await appendToCurrent([
        {
            id: "assistant-approval",
            role: "assistant",
            content: "",
            createdAt: "2026-09-20T12:00:00.000Z",
            contextMode: "computer",
            approval: {
                id: "appr-1",
                tool: "create_directory",
                permission: "approval",
                reason: "make folder",
                arguments: { path: "notes", secret: "nope" },
            },
            approvalStatus: "pending",
        },
    ]);

    const patched = await patchCurrent("assistant-approval", {
        approvalStatus: "expired",
    });

    if (patched.message.approvalStatus !== "expired") {
        throw new Error("Patch did not update approvalStatus.");
    }

    if (patched.message.contextMode !== "computer") {
        throw new Error("Patch must not change contextMode.");
    }

    if (patched.message.approval.arguments.secret !== undefined) {
        throw new Error("Approval arguments were not sanitized.");
    }

    await expectThrow(
        () => patchCurrent("assistant-approval", { contextMode: "chat" }),
        "immutable",
    );

    pass("patch approval status", "mutable fields only; args sanitized");
}


async function testDeepSanitize() {
    await resetSandbox();
    await initializeTranscript();

    const result = await appendToCurrent([
        sampleAssistant({
            id: "assistant-sanitize",
            sources: [
                {
                    filePath: "a.ts",
                    startLine: 1,
                    endLine: 2,
                    similarity: 0.9,
                    content: "SECRET CHUNK",
                },
            ],
            toolUses: [
                {
                    tool: "read_text_file",
                    summary: "read notes.txt",
                    rawResult: "SECRET",
                },
            ],
        }),
    ]);

    const message = result.messages.find((item) => item.id === "assistant-sanitize");
    const source = message.sources[0];
    if ("content" in source) {
        throw new Error("Chunk content leaked into transcript.");
    }

    if ("rawResult" in message.toolUses[0]) {
        throw new Error("Tool internals leaked into transcript.");
    }

    const fileResult = await appendToCurrent([
        sampleAssistant({
            id: "file-source-ok",
            sources: [
                {
                    sourceType: "file",
                    filePath: "docs/resume.pdf",
                    name: "resume.pdf",
                    rootId: "r1",
                    chunkIndex: 0,
                    similarity: 0.5,
                    preview: "should not persist",
                    text: "NO",
                },
            ],
        }),
    ]);

    const fileSource = fileResult.messages.find(
        (item) => item.id === "file-source-ok",
    ).sources[0];
    if ("preview" in fileSource || "text" in fileSource) {
        throw new Error("File chunk text leaked into transcript.");
    }

    pass("deep sanitize", "chunk text and unknown nested fields stripped");
}


async function testSizeGuard() {
    await resetSandbox();
    const previousMax = process.env.LOCAL_AI_TRANSCRIPT_MAX_BYTES;
    process.env.LOCAL_AI_TRANSCRIPT_MAX_BYTES = "400";
    _resetTranscriptStateForTests();

    try {
        await initializeTranscript();

        await appendToCurrent([
            sampleUser({
                id: "small-user",
                content: "hi",
            }),
        ]);

        await expectThrow(
            () =>
                appendToCurrent([
                    sampleAssistant({
                        id: "huge",
                        content: "x".repeat(2000),
                    }),
                ]),
            "exceed",
        );

        const { messages } = await getTranscript();
        if (messages.length !== 1) {
            throw new Error("Size guard must leave previous transcript untouched.");
        }

        if (!(await getTranscript()).conversationId) {
            throw new Error("conversationId must remain after rejected write.");
        }

        pass("size guard", "rejects oversized write without deleting history");
    } finally {
        process.env.LOCAL_AI_TRANSCRIPT_MAX_BYTES =
            previousMax ?? String(8 * 1024);
    }
}


async function testMigrationOnce() {
    await resetSandbox();

    await fs.writeFile(
        LEGACY_HISTORY,
        JSON.stringify(
            [
                { role: "system", content: "hidden" },
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Hi there" },
            ],
            null,
            2,
        ),
        "utf8",
    );

    const first = await initializeTranscript();
    if (!first.migrated) {
        throw new Error("Expected first-time migration.");
    }

    const { messages } = await getTranscript();
    if (messages.length !== 2) {
        throw new Error(`Expected 2 migrated messages, got ${messages.length}`);
    }

    if (messages.some((item) => item.role === "system")) {
        throw new Error("System messages must not migrate.");
    }

    if (!messages.every((item) => item.contextMode === "chat")) {
        throw new Error("Migrated messages must use contextMode chat.");
    }

    // Empty transcript file must not re-migrate.
    await clearTranscript();
    _resetTranscriptStateForTests();

    await fs.writeFile(
        LEGACY_HISTORY,
        JSON.stringify(
            [
                { role: "user", content: "Should not appear" },
                { role: "assistant", content: "Nope" },
            ],
            null,
            2,
        ),
        "utf8",
    );

    const second = await initializeTranscript();
    if (second.migrated) {
        throw new Error("Must not migrate when transcript file already exists.");
    }

    const after = await getTranscript();
    if (after.messages.length !== 0) {
        throw new Error("Empty existing transcript must stay empty.");
    }

    // Malformed transcript must fail closed — not re-import history.
    await fs.writeFile(TRANSCRIPT_FILE, "{not-json", "utf8");
    _resetTranscriptStateForTests();

    await expectThrow(() => initializeTranscript(), "malformed");

    pass("migration once + fail closed", "empty file skips migrate; bad JSON throws");
}


async function testClear() {
    await resetSandbox();
    await initializeTranscript();
    await appendToCurrent([sampleUser(), sampleAssistant()]);
    await clearTranscript();
    const { messages } = await getTranscript();
    if (messages.length !== 0) {
        throw new Error("Clear must empty the transcript.");
    }
    pass("clear transcript", "messages empty after clear");
}


async function testClearPendingApprovalsHelper() {
    const { clearPendingApprovals, listPendingApprovals } = await import(
        "../lib/agent.js"
    );

    // Ensure helper exists and returns a cleared count without throwing
    // when the map is empty. Full approve/reject loops are covered elsewhere.
    const result = await clearPendingApprovals();
    if (typeof result.cleared !== "number") {
        throw new Error("clearPendingApprovals must return { cleared }.");
    }

    if (listPendingApprovals().length !== 0) {
        throw new Error("Expected no pending approvals after clear.");
    }

    pass("clearPendingApprovals helper", `cleared=${result.cleared}`);
}


async function testRealPathsUntouched() {
    const realTranscript = path.join(ROOT, "data", "conversation-transcript.json");
    const realHistory = path.join(ROOT, "chat-history.json");

    let beforeTranscript = null;
    let beforeHistory = null;

    try {
        beforeTranscript = await fs.readFile(realTranscript, "utf8");
    } catch {
        beforeTranscript = null;
    }

    try {
        beforeHistory = await fs.readFile(realHistory, "utf8");
    } catch {
        beforeHistory = null;
    }

    await resetSandbox();
    await initializeTranscript();
    await appendToCurrent([sampleUser({ id: "sandbox-only" })]);
    await clearTranscript();

    let afterTranscript = null;
    let afterHistory = null;

    try {
        afterTranscript = await fs.readFile(realTranscript, "utf8");
    } catch {
        afterTranscript = null;
    }

    try {
        afterHistory = await fs.readFile(realHistory, "utf8");
    } catch {
        afterHistory = null;
    }

    if (beforeTranscript !== afterTranscript) {
        throw new Error("Verification mutated the real conversation transcript.");
    }

    if (beforeHistory !== afterHistory) {
        throw new Error("Verification mutated the real chat-history.json.");
    }

    pass("sandbox isolation", "real transcript and history untouched");
}


async function main() {
    console.log("Verifying conversation transcript (sandbox only)…\n");

    const tests = [
        testFailedTurnPersistence,
        testAppendIdempotent,
        testPatchApprovalStatus,
        testDeepSanitize,
        testSizeGuard,
        testMigrationOnce,
        testClear,
        testClearPendingApprovalsHelper,
        testRealPathsUntouched,
    ];

    for (const test of tests) {
        try {
            await test();
        } catch (error) {
            fail(test.name, error.message);
        }
    }

    // Restore default max for any later imports in this process.
    process.env.LOCAL_AI_TRANSCRIPT_MAX_BYTES = String(8 * 1024);

    const failed = results.filter((item) => item.status === "fail");
    console.log(
        `\n${results.length - failed.length} passed, ${failed.length} failed`,
    );

    // Sanity: _test export exists for allowlists.
    if (!_test.DEFAULT_MAX_TRANSCRIPT_BYTES) {
        fail("exports", "missing _test.DEFAULT_MAX_TRANSCRIPT_BYTES");
    }

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
