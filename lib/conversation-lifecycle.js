// =========================================================
// lib/conversation-lifecycle.js
//
// Owns multi-store conversation operations on one lifecycle
// mutation queue:
//   - New conversation (non-destructive archive + fresh current)
//   - Forget one archived conversation
//   - Forget all conversation history
//
// Lock / order rule (avoid deadlocks):
//   1. Only the lifecycle queue serializes New / Forget-one / Forget-all.
//   2. Lifecycle awaits store APIs that use their OWN queues
//      (transcript, archive, chat, memory) — never holds a store's
//      private queue while waiting on another store's queue from
//      inside that same store.
//   3. Closing the current transcript happens BEFORE archive write so
//      late append/patch for the outgoing id fail with 409.
//   4. Each lifecycle step is idempotent for safe retries.
// =========================================================


import { clearPendingApprovals } from "./agent.js";
import { clearChatHistory } from "./chat.js";
import {
    archiveConversation,
    clearArchive,
    deleteArchivedConversation,
    initializeArchive,
    listArchivedConversationMetadata,
} from "./conversation-archive.js";
import { assertValidConversationId } from "./conversation-id.js";
import {
    beginCloseCurrentConversation,
    getTranscript,
    initializeTranscript,
    installNewConversation,
    resetCurrentTranscript,
} from "./conversation-transcript.js";
import {
    clearConversationMemory,
    scheduleConversationMemorySync,
} from "./conversation-memory.js";


let lifecycleQueue = Promise.resolve();

/** Test hook: throw after a named stage during startNewConversation. */
let testFailAfterStage = null;


function enqueueLifecycle(work) {
    const run = lifecycleQueue.then(work);

    lifecycleQueue = run.then(
        () => undefined,
        () => undefined,
    );

    return run;
}


function maybeFail(stage) {
    if (testFailAfterStage && testFailAfterStage === stage) {
        const error = new Error(
            `Injected lifecycle failure after stage: ${stage}`,
        );
        error.code = "LIFECYCLE_INJECTED_FAILURE";
        throw error;
    }
}


export function initializeConversationLifecycle() {
    return enqueueLifecycle(async () => {
        await initializeTranscript();
        await initializeArchive();
        return { ok: true };
    });
}


/**
 * Non-destructive: archive current (if non-empty), reset Chat,
 * install fresh current conversation, sync memory.
 */
export function startNewConversation() {
    return enqueueLifecycle(async () => {
        const closed = await beginCloseCurrentConversation();
        maybeFail("after-close");

        await clearPendingApprovals();
        maybeFail("after-approvals");

        let archived = null;

        if (closed.messages.length > 0) {
            const result = await archiveConversation({
                id: closed.conversationId,
                createdAt: closed.createdAt,
                endedAt: new Date().toISOString(),
                messages: closed.messages,
            });
            archived = result.conversation;
        }

        maybeFail("after-archive");

        await clearChatHistory();
        maybeFail("after-chat-reset");

        const next = await installNewConversation();
        maybeFail("after-install");

        scheduleConversationMemorySync();

        return {
            ok: true,
            archived,
            conversation: {
                version: next.version,
                conversationId: next.conversationId,
                createdAt: next.createdAt,
                messages: next.messages,
            },
        };
    });
}


export function listConversations() {
    return enqueueLifecycle(async () => {
        const current = await getTranscript();
        const archived = await listArchivedConversationMetadata();

        const conversations = [
            {
                id: current.conversationId,
                createdAt: current.createdAt,
                endedAt: null,
                messageCount: current.messages.length,
                current: true,
            },
            ...archived.conversations.map((item) => ({
                ...item,
                current: false,
            })),
        ];

        return { conversations };
    });
}


/**
 * Permanently delete one archived conversation. Rejects if id is current.
 */
export function forgetConversation(conversationId) {
    return enqueueLifecycle(async () => {
        assertValidConversationId(conversationId);
        const current = await getTranscript();

        if (conversationId === current.conversationId) {
            const error = new Error(
                "Cannot delete the current conversation. Start a new conversation first.",
            );
            error.code = "CONVERSATION_IS_CURRENT";
            error.status = 400;
            throw error;
        }

        await deleteArchivedConversation(conversationId);
        scheduleConversationMemorySync();

        return { ok: true, deleted: conversationId };
    });
}


/**
 * Explicitly destructive: wipe approvals, chat, current, archive files,
 * and memory index; install a fresh current conversation.
 */
export function forgetAllConversations() {
    return enqueueLifecycle(async () => {
        await clearPendingApprovals();
        await clearChatHistory();
        await clearArchive();
        await resetCurrentTranscript();
        await clearConversationMemory();

        const next = await getTranscript();

        return {
            ok: true,
            conversation: {
                version: next.version,
                conversationId: next.conversationId,
                createdAt: next.createdAt,
                messages: next.messages,
            },
        };
    });
}


export function _resetLifecycleStateForTests() {
    testFailAfterStage = null;
}


export function _setLifecycleFailAfterStageForTests(stage) {
    testFailAfterStage = stage;
}
