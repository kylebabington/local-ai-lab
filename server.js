// =========================================================
// server.js
//
// Local HTTP API for the React UI.
//
// Binds only to 127.0.0.1. The browser talks to this server,
// never to Ollama directly.
//
// Shared logic:
//   lib/chat.js
//   lib/conversation-transcript.js
//   lib/conversation-memory.js
//   lib/rag.js
//   lib/ollama.js
//   lib/agent.js
//   lib/file-inventory.js
//   lib/file-content.js
//   lib/file-rag.js
//   lib/tools/*
// =========================================================


import http from "node:http";

import {
    CHAT_MODEL,
    EMBEDDING_MODEL,
    getInstalledModelNames,
} from "./lib/ollama.js";

import {
    initializeChat,
    sendChatMessage,
    getVisibleChatHistory,
    clearChatHistory,
} from "./lib/chat.js";

import { askProject } from "./lib/rag.js";

import {
    approveById,
    createStandaloneRemovalApproval,
    createStandaloneTransferApproval,
    listPendingApprovals,
    rejectById,
    runAgent,
} from "./lib/agent.js";

import {
    appendMessages,
    getTranscript,
    initializeTranscript,
    patchMessage,
} from "./lib/conversation-transcript.js";

import {
    buildConversationMemoryIndex,
    getConversationMemoryStatus,
    initializeConversationMemory,
    retrieveMemoryForChat,
    scheduleConversationMemorySync,
    searchConversationMemory,
} from "./lib/conversation-memory.js";

import {
    forgetAllConversations,
    forgetConversation,
    initializeConversationLifecycle,
    listConversations,
    startNewConversation,
} from "./lib/conversation-lifecycle.js";

import { readActivity } from "./lib/activity.js";
import {
    addRoot,
    getStatus,
    listRoots,
    removeRoot,
    scanInventory,
    searchInventory,
} from "./lib/file-inventory.js";
import {
    buildFileContentIndex,
    getFileContentIndexStatus,
    searchFileContent,
} from "./lib/file-content.js";
import { askFiles } from "./lib/file-rag.js";
import {
    describeAllowedRoots,
    listTools,
} from "./lib/tools/registry.js";
import {
    cancelSessionScan,
    ensureSession,
    forbiddenCrossOriginMessage,
    getLastDriveSnapshot,
    revokeAllSessionGrants,
    revokeSessionGrant,
    runWithSession,
} from "./lib/storage-session.js";
import {
    bootstrapTransferRuntime,
    getPublicTransfer,
    listPublicTransfers,
    requestCancelTransfer,
} from "./lib/tools/storage-transfer.js";
import {
    bootstrapReclaimRuntime,
    getPublicReclaimJob,
    listPublicReclaimJobs,
    requestCancelReclaimJob,
    startReclaimReview,
} from "./lib/tools/storage-reclaim.js";
import {
    bootstrapRemovalRuntime,
    getPublicReclaimManifest,
    getPublicRemovalJob,
    listPublicReclaimManifests,
    lockReclaimSelection,
    requestCancelRemovalJob,
} from "./lib/tools/storage-removal.js";
import {
    getManualGuidanceForJob,
    listManualReclamation,
    markManuallyHandled,
    observeManualCleanup,
    reverifyManualEntry,
} from "./lib/tools/storage-manual-reclaim.js";
import {
    describeStorageSession,
    grantScanFolder,
} from "./lib/tools/storage.js";
import {
    getPublicPlan,
    listPublicPlans,
    lockManifestFromSelection,
    planStorageOffload,
    refreshDriveSnapshot,
} from "./lib/tools/storage-offload.js";


const HOST = "127.0.0.1";
const PORT = 3001;
const MAX_BODY_BYTES = 32 * 1024;


function sendJson(response, status, body) {
    const json = JSON.stringify(body);
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(json),
    });
    response.end(json);
}


function sendError(response, status, message) {
    sendJson(response, status, {
        error: {
            message,
        },
    });
}


function isOllamaUnavailable(error) {
    const text = error?.message ?? "";
    return (
        text.includes("Could not reach Ollama") ||
        text.includes("Chat request failed") ||
        text.includes("Embedding request failed") ||
        text.includes("Ollama responded with an error")
    );
}


function errorStatus(error) {
    if (typeof error?.status === "number") {
        return error.status;
    }

    if (isOllamaUnavailable(error)) {
        return 503;
    }

    if (
        typeof error?.message === "string" &&
        error.message.includes("is not installed")
    ) {
        return 503;
    }

    return 500;
}


function clientErrorStatus(error, fallback = 400) {
    if (typeof error?.status === "number") {
        return error.status;
    }

    const message = error?.message ?? "";

    if (
        message.includes("required") ||
        message.includes("must be") ||
        message.includes("does not exist") ||
        message.includes("cannot be") ||
        message.includes("already") ||
        message.includes("inside") ||
        message.includes("Unknown") ||
        message.includes("Malformed") ||
        message.includes("malformed") ||
        message.includes("exceed") ||
        message.includes("invalid") ||
        message.includes("Add at least one") ||
        message.includes("not allowed") ||
        message.includes("too broad") ||
        message.includes("authorized") ||
        message.includes("grant")
    ) {
        return fallback;
    }

    return errorStatus(error);
}


function userSafeMessage(error, fallback) {
    if (typeof error?.message === "string" && error.message.trim()) {
        return error.message.split("\n")[0];
    }

    return fallback;
}


function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let tooLarge = false;

        request.on("data", (chunk) => {
            total += chunk.length;

            if (total > MAX_BODY_BYTES) {
                tooLarge = true;
                request.destroy();
                reject(Object.assign(new Error("Payload too large."), {
                    status: 413,
                }));
                return;
            }

            chunks.push(chunk);
        });

        request.on("end", () => {
            if (tooLarge) {
                return;
            }

            if (chunks.length === 0) {
                resolve({});
                return;
            }

            const raw = Buffer.concat(chunks).toString("utf8");

            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(Object.assign(new Error("Request body is not valid JSON."), {
                    status: 400,
                }));
            }
        });

        request.on("error", (error) => {
            reject(error);
        });
    });
}


function requireMethod(request, response, allowed) {
    if (allowed.includes(request.method)) {
        return true;
    }

    sendError(
        response,
        405,
        `Method ${request.method} is not allowed for this route.`,
    );
    return false;
}


async function handleHealth(response) {
    const payload = {
        ok: false,
        backend: "connected",
        ollama: "disconnected",
        ready: false,
        chatModel: {
            name: CHAT_MODEL,
            available: false,
        },
        embeddingModel: {
            name: EMBEDDING_MODEL,
            available: false,
        },
    };

    try {
        const names = await getInstalledModelNames();
        payload.ollama = "connected";
        payload.chatModel.available = names.includes(CHAT_MODEL);
        payload.embeddingModel.available = names.includes(EMBEDDING_MODEL);
        payload.ready =
            payload.chatModel.available && payload.embeddingModel.available;
        payload.ok = payload.ready;
    } catch {
        payload.ollama = "disconnected";
        payload.ready = false;
        payload.ok = false;
    }

    sendJson(response, 200, payload);
}


async function handleChatPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
        sendError(response, 400, "Message cannot be empty.");
        return;
    }

    const excludeMessageIds = Array.isArray(body.excludeMessageIds)
        ? body.excludeMessageIds
        : [];

    try {
        const memory = await retrieveMemoryForChat(message, {
            excludeMessageIds,
        });

        const result = await sendChatMessage(message, {
            temporarySystemMessages: memory.temporarySystemMessages,
        });

        const payload = {
            answer: result.answer,
        };

        if (memory.sources.length > 0) {
            payload.sources = memory.sources;
        }

        if (memory.warnings.length > 0) {
            payload.memoryWarning = memory.warnings.join(" ");
        }

        sendJson(response, 200, payload);
    } catch (error) {
        console.error("POST /api/chat failed:", error.message);
        sendError(
            response,
            errorStatus(error),
            userSafeMessage(error, "Chat request failed."),
        );
    }
}


function handleChatHistoryGet(response) {
    sendJson(response, 200, {
        messages: getVisibleChatHistory(),
    });
}


async function handleChatHistoryDelete(response) {
    try {
        await clearChatHistory();
        sendJson(response, 200, { ok: true });
    } catch (error) {
        console.error("DELETE /api/chat/history failed:", error.message);
        sendError(
            response,
            500,
            userSafeMessage(error, "Could not clear chat history."),
        );
    }
}


async function handleTranscriptGet(response) {
    try {
        const result = await getTranscript();
        sendJson(response, 200, {
            version: result.version,
            conversationId: result.conversationId,
            createdAt: result.createdAt,
            messages: result.messages,
        });
    } catch (error) {
        console.error("GET /api/transcript failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 500),
            userSafeMessage(error, "Could not load conversation transcript."),
        );
    }
}


async function handleTranscriptMessagesPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const result = await appendMessages(body.conversationId, body.messages);
        sendJson(response, 200, {
            ok: true,
            appended: result.appended,
            conversationId: result.conversationId,
            messages: result.messages,
        });
        if (result.appended > 0) {
            scheduleConversationMemorySync();
        }
    } catch (error) {
        console.error("POST /api/transcript/messages failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not save conversation messages."),
        );
    }
}


async function handleTranscriptMessagePatch(request, response, id) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const result = await patchMessage(body.conversationId, id, body);
        sendJson(response, 200, {
            ok: true,
            conversationId: result.conversationId,
            message: result.message,
            messages: result.messages,
        });

        if (typeof body.content === "string") {
            scheduleConversationMemorySync();
        }
    } catch (error) {
        console.error(
            `PATCH /api/transcript/messages/${id} failed:`,
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not update conversation message."),
        );
    }
}


async function handleTranscriptDelete(response) {
    try {
        // Backward compatible: Clear delegates to non-destructive New.
        const result = await startNewConversation();
        sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
        console.error("DELETE /api/transcript failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not start a new conversation."),
        );
    }
}


async function handleConversationsNewPost(response) {
    try {
        const result = await startNewConversation();
        sendJson(response, 200, result);
    } catch (error) {
        console.error("POST /api/conversations/new failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not start a new conversation."),
        );
    }
}


async function handleConversationsGet(response) {
    try {
        const result = await listConversations();
        sendJson(response, 200, result);
    } catch (error) {
        console.error("GET /api/conversations failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not list conversations."),
        );
    }
}


async function handleConversationsDeleteAll(response) {
    try {
        const result = await forgetAllConversations();
        sendJson(response, 200, result);
    } catch (error) {
        console.error("DELETE /api/conversations failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not forget conversation history."),
        );
    }
}


async function handleConversationDelete(response, conversationId) {
    try {
        const result = await forgetConversation(conversationId);
        sendJson(response, 200, result);
    } catch (error) {
        console.error(
            `DELETE /api/conversations/${conversationId} failed:`,
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not delete that conversation."),
        );
    }
}


async function handleMemoryStatusGet(response) {
    try {
        const status = await getConversationMemoryStatus();
        sendJson(response, 200, {
            indexExists: status.indexExists,
            indexedAt: status.indexedAt,
            transcriptMessages: status.transcriptMessages,
            currentConversationId: status.currentConversationId,
            currentMessages: status.currentMessages,
            archivedConversations: status.archivedConversations,
            totalConversations: status.totalConversations,
            memoryUnits: status.memoryUnits,
            chunks: status.chunks,
            stale: status.stale,
            embeddingModel: status.embeddingModel,
            syncRunning: status.syncRunning,
        });
    } catch (error) {
        console.error("GET /api/memory/status failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 500),
            userSafeMessage(error, "Could not load conversation memory status."),
        );
    }
}


async function handleMemoryIndexPost(response) {
    try {
        const result = await buildConversationMemoryIndex();
        const status = await getConversationMemoryStatus();
        sendJson(response, 200, {
            ok: true,
            ...result,
            status: {
                indexExists: status.indexExists,
                indexedAt: status.indexedAt,
                transcriptMessages: status.transcriptMessages,
                currentConversationId: status.currentConversationId,
                currentMessages: status.currentMessages,
                archivedConversations: status.archivedConversations,
                totalConversations: status.totalConversations,
                memoryUnits: status.memoryUnits,
                chunks: status.chunks,
                stale: status.stale,
                embeddingModel: status.embeddingModel,
            },
        });
    } catch (error) {
        console.error("POST /api/memory/index failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(
                error,
                "Could not rebuild conversation memory. Transcript was not changed.",
            ),
        );
    }
}


async function handleMemorySearchPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const query = typeof body.query === "string" ? body.query.trim() : "";

    if (!query) {
        sendError(response, 400, "Memory search query cannot be empty.");
        return;
    }

    try {
        const result = await searchConversationMemory(query, {
            topK: body.topK,
            excludeMessageIds: body.excludeMessageIds,
        });

        sendJson(response, 200, {
            results: result.results.map((item) => ({
                memoryId: item.memoryId,
                chunkId: item.chunkId,
                similarity: item.similarity,
                startedAt: item.startedAt,
                endedAt: item.endedAt,
                contextModes: item.contextModes,
                messages: item.messages,
                preview: item.preview,
            })),
            temporal: result.temporal,
        });
    } catch (error) {
        console.error("POST /api/memory/search failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Conversation memory search failed."),
        );
    }
}


async function handleRagPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const question =
        typeof body.question === "string" ? body.question.trim() : "";

    if (!question) {
        sendError(response, 400, "Question cannot be empty.");
        return;
    }

    try {
        const result = await askProject(question);
        sendJson(response, 200, {
            answer: result.answer,
            matches: result.matches.map((match) => ({
                filePath: match.filePath,
                startLine: match.startLine,
                endLine: match.endLine,
                similarity: match.similarity,
            })),
        });
    } catch (error) {
        console.error("POST /api/rag failed:", error.message);
        sendError(
            response,
            errorStatus(error),
            userSafeMessage(error, "Project question failed."),
        );
    }
}


function handleToolsGet(response) {
    sendJson(response, 200, {
        allowedRoots: describeAllowedRoots(),
        tools: listTools(),
    });
}


async function handleAgentPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
        sendError(response, 400, "Message cannot be empty.");
        return;
    }

    try {
        const result = await runAgent(message);
        sendJson(response, 200, result);
    } catch (error) {
        console.error("POST /api/agent failed:", error.message);
        sendError(
            response,
            errorStatus(error),
            userSafeMessage(error, "Computer request failed."),
        );
    }
}


function handleApprovalsGet(response) {
    sendJson(response, 200, {
        approvals: listPendingApprovals(),
    });
}


async function handleApprovalDecision(response, id, action, decision = {}) {
    try {
        const result =
            action === "approve"
                ? await approveById(id, decision)
                : await rejectById(id);
        sendJson(response, 200, result);
    } catch (error) {
        const message = userSafeMessage(error, "Approval update failed.");
        const status =
            message.includes("Unknown or expired")
                ? 404
                : clientErrorStatus(error, errorStatus(error));
        console.error(`POST /api/approvals/${id}/${action} failed:`, error.message);
        sendError(response, status, message);
    }
}


async function handleActivityGet(url, response) {
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(rawLimit) ? rawLimit : 50;

    try {
        const entries = await readActivity(limit);
        sendJson(response, 200, { entries });
    } catch (error) {
        console.error("GET /api/activity failed:", error.message);
        sendError(
            response,
            500,
            userSafeMessage(error, "Could not read activity."),
        );
    }
}


async function handleFilesStatusGet(response) {
    try {
        const status = await getStatus();
        sendJson(response, 200, status);
    } catch (error) {
        console.error("GET /api/files/status failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 500),
            userSafeMessage(error, "Could not read file inventory status."),
        );
    }
}


async function handleFilesRootsGet(response) {
    try {
        const roots = await listRoots();
        sendJson(response, 200, { roots });
    } catch (error) {
        console.error("GET /api/files/roots failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 500),
            userSafeMessage(error, "Could not list file roots."),
        );
    }
}


async function handleFilesRootsPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const folderPath = typeof body.path === "string" ? body.path : "";

    try {
        const root = await addRoot(folderPath);
        sendJson(response, 200, { root });
    } catch (error) {
        console.error("POST /api/files/roots failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not add file root."),
        );
    }
}


async function handleFilesRootsRemovePost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const id = typeof body.id === "string" ? body.id : "";

    try {
        const root = await removeRoot(id);
        sendJson(response, 200, { root });
    } catch (error) {
        console.error("POST /api/files/roots/remove failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not remove file root."),
        );
    }
}


async function handleFilesScanPost(response) {
    try {
        const summary = await scanInventory();
        sendJson(response, 200, { summary });
    } catch (error) {
        console.error("POST /api/files/scan failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "File inventory scan failed."),
        );
    }
}


async function handleFilesSearchGet(url, response) {
    try {
        const result = await searchInventory({
            query: url.searchParams.get("query") ?? "",
            rootId: url.searchParams.get("rootId") ?? "",
            extension: url.searchParams.get("extension") ?? "",
            limit: Number(url.searchParams.get("limit")),
            offset: Number(url.searchParams.get("offset")),
            sort: url.searchParams.get("sort") ?? "name",
            direction: url.searchParams.get("direction") ?? "asc",
        });
        sendJson(response, 200, result);
    } catch (error) {
        console.error("GET /api/files failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 500),
            userSafeMessage(error, "Could not search file inventory."),
        );
    }
}


async function handleFilesIndexStatusGet(response) {
    try {
        const status = await getFileContentIndexStatus();
        sendJson(response, 200, status);
    } catch (error) {
        console.error("GET /api/files/index/status failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 500),
            userSafeMessage(error, "Could not load File content index status."),
        );
    }
}


async function handleFilesIndexPost(response) {
    try {
        const summary = await buildFileContentIndex();
        sendJson(response, 200, { summary });
    } catch (error) {
        console.error("POST /api/files/index failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "File content indexing failed."),
        );
    }
}


async function handleFilesSemanticSearchPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const query = typeof body.query === "string" ? body.query.trim() : "";

    if (!query) {
        sendError(response, 400, "Query cannot be empty.");
        return;
    }

    try {
        const matches = await searchFileContent(query, {
            rootId: body.rootId,
            extension: body.extension,
            limit: body.limit,
        });

        sendJson(response, 200, {
            matches: matches.map((match) => ({
                sourceType: "file",
                filePath: match.filePath,
                name: match.name,
                rootId: match.rootId,
                chunkIndex: match.chunkIndex,
                similarity: match.similarity,
                pageStart: match.pageStart,
                pageEnd: match.pageEnd,
                preview: match.preview,
            })),
        });
    } catch (error) {
        console.error("POST /api/files/semantic-search failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "File semantic search failed."),
        );
    }
}


async function handleFilesAskPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const question =
        typeof body.question === "string" ? body.question.trim() : "";

    if (!question) {
        sendError(response, 400, "Question cannot be empty.");
        return;
    }

    try {
        const result = await askFiles(question, {
            rootId: body.rootId,
            extension: body.extension,
        });

        sendJson(response, 200, {
            answer: result.answer,
            matches: result.matches,
        });
    } catch (error) {
        console.error("POST /api/files/ask failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "File question failed."),
        );
    }
}


async function handleRequest(request, response) {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    const method = request.method ?? "GET";

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const forbidden = forbiddenCrossOriginMessage(request);
        if (forbidden) {
            sendError(response, 403, forbidden);
            return;
        }
    }

    const session = ensureSession(request, response);

    try {
        await runWithSession(session, () =>
            routeRequest(request, response, url),
        );
    } catch (error) {
        console.error("Unhandled request error:", error.message);
        sendError(response, 500, "Unexpected server error.");
    }
}


async function handleStorageSessionGet(response) {
    try {
        const payload = await describeStorageSession();
        sendJson(response, 200, payload);
    } catch (error) {
        console.error("GET /api/storage/session failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not load storage scan session."),
        );
    }
}


async function handleStorageGrantPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const folderPath = typeof body.path === "string" ? body.path : "";

    try {
        const grant = await grantScanFolder(folderPath);
        const payload = await describeStorageSession();
        sendJson(response, 200, { grant, ...payload });
    } catch (error) {
        console.error("POST /api/storage/grants failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not grant that scan folder."),
        );
    }
}


async function handleStorageGrantDelete(response, grantId) {
    try {
        revokeSessionGrant(grantId);
        const payload = await describeStorageSession();
        sendJson(response, 200, payload);
    } catch (error) {
        console.error("DELETE /api/storage/grants failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 404),
            userSafeMessage(error, "Could not revoke that scan folder."),
        );
    }
}


async function handleStorageRevokeAllPost(response) {
    try {
        revokeAllSessionGrants();
        const payload = await describeStorageSession();
        sendJson(response, 200, payload);
    } catch (error) {
        console.error("POST /api/storage/grants/revoke-all failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not end the scan session."),
        );
    }
}


async function handleStorageCancelPost(response) {
    try {
        const result = cancelSessionScan();
        const payload = await describeStorageSession();
        sendJson(response, 200, { ...result, ...payload });
    } catch (error) {
        console.error("POST /api/storage/cancel failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not cancel the scan."),
        );
    }
}


async function handleStorageDrivesGet(response) {
    try {
        const snapshot = getLastDriveSnapshot();
        if (snapshot?.volumes) {
            sendJson(response, 200, snapshot);
            return;
        }

        const result = await refreshDriveSnapshot();
        sendJson(response, 200, result);
    } catch (error) {
        console.error("GET /api/storage/drives failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not inspect drives."),
        );
    }
}


async function handleStorageDrivesRefreshPost(response) {
    try {
        const result = await refreshDriveSnapshot();
        sendJson(response, 200, result);
    } catch (error) {
        console.error("POST /api/storage/drives/refresh failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, errorStatus(error)),
            userSafeMessage(error, "Could not refresh drives."),
        );
    }
}


async function handleStoragePlansGet(response) {
    try {
        sendJson(response, 200, { plans: listPublicPlans() });
    } catch (error) {
        console.error("GET /api/storage/plans failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not list storage plans."),
        );
    }
}


async function handleStoragePlanGet(response, planId) {
    try {
        const plan = getPublicPlan(planId);
        if (!plan) {
            sendError(response, 404, "Unknown storage plan.");
            return;
        }
        sendJson(response, 200, { plan });
    } catch (error) {
        console.error("GET /api/storage/plans/:id failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 404),
            userSafeMessage(error, "Could not load that storage plan."),
        );
    }
}


async function handleStoragePlanPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const result = await planStorageOffload(body ?? {});
        sendJson(response, 200, result);
    } catch (error) {
        console.error("POST /api/storage/plans failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not create an offload plan."),
        );
    }
}


async function handleStoragePlanSelectionPost(request, response, planId) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const entryIds = Array.isArray(body.entryIds) ? body.entryIds : null;

    try {
        const result = lockManifestFromSelection(planId, entryIds);
        sendJson(response, 200, result);
    } catch (error) {
        console.error("POST /api/storage/plans/:id/selection failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not lock that file selection."),
        );
    }
}


async function handleStorageTransferRequestPost(request, response) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    const manifestId = typeof body.manifestId === "string" ? body.manifestId : "";
    const reason =
        typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : "Copy selected files to the external drive.";

    try {
        const approval = await createStandaloneTransferApproval({
            manifestId,
            reason,
            authorizeHydrateCloudFiles: body.authorizeHydrateCloudFiles === true,
        });
        sendJson(response, 200, { approval });
    } catch (error) {
        console.error("POST /api/storage/transfers/request failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not request that transfer."),
        );
    }
}


async function handleStorageTransfersGet(response) {
    try {
        sendJson(response, 200, { transfers: listPublicTransfers() });
    } catch (error) {
        console.error("GET /api/storage/transfers failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not list transfers."),
        );
    }
}


async function handleStorageTransferGet(response, transferId) {
    try {
        const transfer = getPublicTransfer(transferId);
        if (!transfer) {
            sendError(response, 404, "Unknown transfer.");
            return;
        }
        sendJson(response, 200, { transfer });
    } catch (error) {
        console.error("GET /api/storage/transfers/:id failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 404),
            userSafeMessage(error, "Could not load that transfer."),
        );
    }
}


async function handleStorageTransferCancelPost(response, transferId) {
    try {
        const transfer = requestCancelTransfer(transferId);
        sendJson(response, 200, { transfer });
    } catch (error) {
        console.error("POST /api/storage/transfers/:id/cancel failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not cancel that transfer."),
        );
    }
}


async function handleStorageReclaimReviewPost(request, response, transferId) {
    let body;

    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const job = await startReclaimReview({
            transferId,
            entryIds: Array.isArray(body.entryIds) ? body.entryIds : undefined,
            maxMs: Number.isInteger(body.maxMs) ? body.maxMs : undefined,
        });
        sendJson(response, 200, {
            job: getPublicReclaimJob(job.id),
        });
    } catch (error) {
        console.error(
            "POST /api/storage/transfers/:id/reclaim-review failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not start reclaim review."),
        );
    }
}


async function handleStorageReclaimJobsGet(response) {
    try {
        sendJson(response, 200, { jobs: listPublicReclaimJobs() });
    } catch (error) {
        console.error("GET /api/storage/reclaim-jobs failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not list reclaim jobs."),
        );
    }
}


async function handleStorageReclaimJobGet(response, jobId) {
    try {
        const job = getPublicReclaimJob(jobId);
        if (!job) {
            sendError(response, 404, "Unknown reclaim job.");
            return;
        }
        sendJson(response, 200, { job });
    } catch (error) {
        console.error("GET /api/storage/reclaim-jobs/:id failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 404),
            userSafeMessage(error, "Could not load that reclaim job."),
        );
    }
}


async function handleStorageReclaimJobCancelPost(response, jobId) {
    try {
        const job = requestCancelReclaimJob(jobId);
        sendJson(response, 200, { job });
    } catch (error) {
        console.error(
            "POST /api/storage/reclaim-jobs/:id/cancel failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not cancel that reclaim job."),
        );
    }
}


async function handleStorageReclaimSelectionPost(request, response, jobId) {
    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const manifest = lockReclaimSelection(jobId, body.entryIds);
        sendJson(response, 200, { manifest });
    } catch (error) {
        console.error(
            "POST /api/storage/reclaim-jobs/:id/selection failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not lock that reclaim selection."),
        );
    }
}


async function handleStorageRemovalRequestPost(request, response) {
    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const approval = await createStandaloneRemovalApproval({
            reclaimManifestId: body.reclaimManifestId,
            reason:
                typeof body.reason === "string" && body.reason.trim()
                    ? body.reason.trim()
                    : "Move selected verified originals to the Recycle Bin.",
        });
        sendJson(response, 200, { approval });
    } catch (error) {
        console.error(
            "POST /api/storage/removals/request failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not request that removal."),
        );
    }
}


async function handleStorageRemovalGet(response, removalId) {
    try {
        const removal = getPublicRemovalJob(removalId);
        if (!removal) {
            sendError(response, 404, "Unknown removal job.");
            return;
        }
        sendJson(response, 200, { removal });
    } catch (error) {
        console.error("GET /api/storage/removals/:id failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, 404),
            userSafeMessage(error, "Could not load that removal job."),
        );
    }
}


async function handleStorageRemovalCancelPost(response, removalId) {
    try {
        const removal = requestCancelRemovalJob(removalId);
        sendJson(response, 200, { removal });
    } catch (error) {
        console.error(
            "POST /api/storage/removals/:id/cancel failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not cancel that removal."),
        );
    }
}


async function handleStorageReclaimManifestsGet(response) {
    try {
        sendJson(response, 200, {
            manifests: listPublicReclaimManifests(),
        });
    } catch (error) {
        sendError(
            response,
            clientErrorStatus(error),
            userSafeMessage(error, "Could not list reclaim manifests."),
        );
    }
}


async function handleManualReclamationGet(request, response) {
    try {
        const url = new URL(request.url || "/", `http://${HOST}`);
        const transferId = url.searchParams.get("transferId");
        if (!transferId) {
            sendError(response, 400, "transferId query parameter is required.");
            return;
        }
        const result = await listManualReclamation(transferId);
        sendJson(response, 200, result);
    } catch (error) {
        console.error("GET /api/storage/manual-reclamation failed:", error.message);
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not load manual reclamation state."),
        );
    }
}


async function handleManualReclamationMarkHandledPost(request, response) {
    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const entry = await markManuallyHandled({
            transferId: body.transferId,
            entryId: body.entryId,
            note: body.note,
            reclaimJobId: body.reclaimJobId,
        });
        sendJson(response, 200, { entry });
    } catch (error) {
        console.error(
            "POST /api/storage/manual-reclamation/mark-handled failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not record manual handling."),
        );
    }
}


async function handleManualReverifyPost(response, reclaimJobId, entryId) {
    try {
        const result = await reverifyManualEntry(reclaimJobId, entryId);
        sendJson(response, 200, { observation: result });
    } catch (error) {
        console.error(
            "POST /api/storage/reclaim-jobs/:id/entries/:entryId/reverify failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not reverify that file."),
        );
    }
}


async function handleManualObservePost(request, response, reclaimJobId) {
    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendError(response, error.status ?? 400, error.message);
        return;
    }

    try {
        const result = await observeManualCleanup(
            reclaimJobId,
            body.entryIds,
            { priorFreeBytes: body.priorFreeBytes },
        );
        sendJson(response, 200, result);
    } catch (error) {
        console.error(
            "POST /api/storage/reclaim-jobs/:id/manual-observe failed:",
            error.message,
        );
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not observe manual cleanup status."),
        );
    }
}


async function handleManualGuidanceGet(response, reclaimJobId, entryId) {
    try {
        const result = getManualGuidanceForJob(reclaimJobId, entryId);
        sendJson(response, 200, result);
    } catch (error) {
        sendError(
            response,
            clientErrorStatus(error, error.status ?? 400),
            userSafeMessage(error, "Could not load recovery guidance."),
        );
    }
}


async function handleStorageReclaimManifestGet(response, manifestId) {
    try {
        const manifest = getPublicReclaimManifest(manifestId);
        if (!manifest) {
            sendError(response, 404, "Unknown reclaim manifest.");
            return;
        }
        sendJson(response, 200, { manifest });
    } catch (error) {
        sendError(
            response,
            clientErrorStatus(error, 404),
            userSafeMessage(error, "Could not load that reclaim manifest."),
        );
    }
}


async function routeRequest(request, response, url) {
    const pathname = url.pathname;

    try {
        if (pathname === "/api/health") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleHealth(response);
            return;
        }

        if (pathname === "/api/chat") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleChatPost(request, response);
            return;
        }

        if (pathname === "/api/chat/history") {
            if (request.method === "GET") {
                handleChatHistoryGet(response);
                return;
            }

            if (request.method === "DELETE") {
                await handleChatHistoryDelete(response);
                return;
            }

            sendError(
                response,
                405,
                `Method ${request.method} is not allowed for this route.`,
            );
            return;
        }

        if (pathname === "/api/transcript") {
            if (request.method === "GET") {
                await handleTranscriptGet(response);
                return;
            }

            if (request.method === "DELETE") {
                await handleTranscriptDelete(response);
                return;
            }

            sendError(
                response,
                405,
                `Method ${request.method} is not allowed for this route.`,
            );
            return;
        }

        if (pathname === "/api/transcript/messages") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleTranscriptMessagesPost(request, response);
            return;
        }

        if (pathname === "/api/conversations/new") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleConversationsNewPost(response);
            return;
        }

        if (pathname === "/api/conversations") {
            if (request.method === "GET") {
                await handleConversationsGet(response);
                return;
            }

            if (request.method === "DELETE") {
                await handleConversationsDeleteAll(response);
                return;
            }

            sendError(
                response,
                405,
                `Method ${request.method} is not allowed for this route.`,
            );
            return;
        }

        {
            const conversationDeleteMatch = pathname.match(
                /^\/api\/conversations\/([^/]+)$/,
            );

            if (conversationDeleteMatch) {
                if (!requireMethod(request, response, ["DELETE"])) {
                    return;
                }

                const conversationId = decodeURIComponent(
                    conversationDeleteMatch[1],
                );
                await handleConversationDelete(response, conversationId);
                return;
            }
        }

        {
            const transcriptPatchMatch = pathname.match(
                /^\/api\/transcript\/messages\/([^/]+)$/,
            );

            if (transcriptPatchMatch) {
                if (!requireMethod(request, response, ["PATCH"])) {
                    return;
                }

                const messageId = decodeURIComponent(transcriptPatchMatch[1]);
                await handleTranscriptMessagePatch(
                    request,
                    response,
                    messageId,
                );
                return;
            }
        }

        if (pathname === "/api/memory/status") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleMemoryStatusGet(response);
            return;
        }

        if (pathname === "/api/memory/index") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleMemoryIndexPost(response);
            return;
        }

        if (pathname === "/api/memory/search") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleMemorySearchPost(request, response);
            return;
        }

        if (pathname === "/api/rag") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleRagPost(request, response);
            return;
        }

        if (pathname === "/api/tools") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            handleToolsGet(response);
            return;
        }

        if (pathname === "/api/agent") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleAgentPost(request, response);
            return;
        }

        if (pathname === "/api/approvals") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            handleApprovalsGet(response);
            return;
        }

        const approvalMatch = pathname.match(
            /^\/api\/approvals\/([^/]+)\/(approve|reject)$/,
        );

        if (approvalMatch) {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            let decision = {};
            try {
                decision = await readJsonBody(request);
            } catch (error) {
                if (error.status === 413) {
                    sendError(response, 413, error.message);
                    return;
                }
                // Empty body is fine for non-transfer approvals.
                decision = {};
            }

            await handleApprovalDecision(
                response,
                decodeURIComponent(approvalMatch[1]),
                approvalMatch[2],
                decision,
            );
            return;
        }

        if (pathname === "/api/activity") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleActivityGet(url, response);
            return;
        }

        if (pathname === "/api/files/status") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleFilesStatusGet(response);
            return;
        }

        if (pathname === "/api/files/roots") {
            if (request.method === "GET") {
                await handleFilesRootsGet(response);
                return;
            }

            if (request.method === "POST") {
                await handleFilesRootsPost(request, response);
                return;
            }

            sendError(
                response,
                405,
                `Method ${request.method} is not allowed for this route.`,
            );
            return;
        }

        if (pathname === "/api/files/roots/remove") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleFilesRootsRemovePost(request, response);
            return;
        }

        if (pathname === "/api/files/scan") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleFilesScanPost(response);
            return;
        }

        if (pathname === "/api/files/index/status") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleFilesIndexStatusGet(response);
            return;
        }

        if (pathname === "/api/files/index") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleFilesIndexPost(response);
            return;
        }

        if (pathname === "/api/files/semantic-search") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleFilesSemanticSearchPost(request, response);
            return;
        }

        if (pathname === "/api/files/ask") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleFilesAskPost(request, response);
            return;
        }

        if (pathname === "/api/files") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleFilesSearchGet(url, response);
            return;
        }

        if (pathname === "/api/storage/session") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleStorageSessionGet(response);
            return;
        }

        if (pathname === "/api/storage/grants") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleStorageGrantPost(request, response);
            return;
        }

        if (pathname === "/api/storage/grants/revoke-all") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleStorageRevokeAllPost(response);
            return;
        }

        if (pathname === "/api/storage/cancel") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleStorageCancelPost(response);
            return;
        }

        {
            const grantDeleteMatch = pathname.match(
                /^\/api\/storage\/grants\/([^/]+)$/,
            );

            if (grantDeleteMatch) {
                if (!requireMethod(request, response, ["DELETE"])) {
                    return;
                }

                await handleStorageGrantDelete(
                    response,
                    decodeURIComponent(grantDeleteMatch[1]),
                );
                return;
            }
        }

        if (pathname === "/api/storage/drives") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleStorageDrivesGet(response);
            return;
        }

        if (pathname === "/api/storage/drives/refresh") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleStorageDrivesRefreshPost(response);
            return;
        }

        if (pathname === "/api/storage/plans") {
            if (request.method === "GET") {
                await handleStoragePlansGet(response);
                return;
            }

            if (request.method === "POST") {
                await handleStoragePlanPost(request, response);
                return;
            }

            sendError(
                response,
                405,
                `Method ${request.method} is not allowed for this route.`,
            );
            return;
        }

        {
            const planSelectionMatch = pathname.match(
                /^\/api\/storage\/plans\/([^/]+)\/selection$/,
            );

            if (planSelectionMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleStoragePlanSelectionPost(
                    request,
                    response,
                    decodeURIComponent(planSelectionMatch[1]),
                );
                return;
            }
        }

        {
            const planGetMatch = pathname.match(
                /^\/api\/storage\/plans\/([^/]+)$/,
            );

            if (planGetMatch) {
                if (!requireMethod(request, response, ["GET"])) {
                    return;
                }

                await handleStoragePlanGet(
                    response,
                    decodeURIComponent(planGetMatch[1]),
                );
                return;
            }
        }

        if (pathname === "/api/storage/transfers/request") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleStorageTransferRequestPost(request, response);
            return;
        }

        if (pathname === "/api/storage/transfers") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleStorageTransfersGet(response);
            return;
        }

        {
            const transferCancelMatch = pathname.match(
                /^\/api\/storage\/transfers\/([^/]+)\/cancel$/,
            );

            if (transferCancelMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleStorageTransferCancelPost(
                    response,
                    decodeURIComponent(transferCancelMatch[1]),
                );
                return;
            }
        }

        {
            const reclaimReviewMatch = pathname.match(
                /^\/api\/storage\/transfers\/([^/]+)\/reclaim-review$/,
            );

            if (reclaimReviewMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleStorageReclaimReviewPost(
                    request,
                    response,
                    decodeURIComponent(reclaimReviewMatch[1]),
                );
                return;
            }
        }

        {
            const transferGetMatch = pathname.match(
                /^\/api\/storage\/transfers\/([^/]+)$/,
            );

            if (transferGetMatch) {
                if (!requireMethod(request, response, ["GET"])) {
                    return;
                }

                await handleStorageTransferGet(
                    response,
                    decodeURIComponent(transferGetMatch[1]),
                );
                return;
            }
        }

        if (pathname === "/api/storage/reclaim-jobs") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleStorageReclaimJobsGet(response);
            return;
        }

        {
            const reclaimCancelMatch = pathname.match(
                /^\/api\/storage\/reclaim-jobs\/([^/]+)\/cancel$/,
            );

            if (reclaimCancelMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleStorageReclaimJobCancelPost(
                    response,
                    decodeURIComponent(reclaimCancelMatch[1]),
                );
                return;
            }
        }

        {
            const reclaimSelectionMatch = pathname.match(
                /^\/api\/storage\/reclaim-jobs\/([^/]+)\/selection$/,
            );

            if (reclaimSelectionMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleStorageReclaimSelectionPost(
                    request,
                    response,
                    decodeURIComponent(reclaimSelectionMatch[1]),
                );
                return;
            }
        }

        {
            const manualReverifyMatch = pathname.match(
                /^\/api\/storage\/reclaim-jobs\/([^/]+)\/entries\/([^/]+)\/reverify$/,
            );

            if (manualReverifyMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleManualReverifyPost(
                    response,
                    decodeURIComponent(manualReverifyMatch[1]),
                    decodeURIComponent(manualReverifyMatch[2]),
                );
                return;
            }
        }

        {
            const manualGuidanceMatch = pathname.match(
                /^\/api\/storage\/reclaim-jobs\/([^/]+)\/entries\/([^/]+)\/guidance$/,
            );

            if (manualGuidanceMatch) {
                if (!requireMethod(request, response, ["GET"])) {
                    return;
                }

                await handleManualGuidanceGet(
                    response,
                    decodeURIComponent(manualGuidanceMatch[1]),
                    decodeURIComponent(manualGuidanceMatch[2]),
                );
                return;
            }
        }

        {
            const manualObserveMatch = pathname.match(
                /^\/api\/storage\/reclaim-jobs\/([^/]+)\/manual-observe$/,
            );

            if (manualObserveMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleManualObservePost(
                    request,
                    response,
                    decodeURIComponent(manualObserveMatch[1]),
                );
                return;
            }
        }

        {
            const reclaimJobMatch = pathname.match(
                /^\/api\/storage\/reclaim-jobs\/([^/]+)$/,
            );

            if (reclaimJobMatch) {
                if (!requireMethod(request, response, ["GET"])) {
                    return;
                }

                await handleStorageReclaimJobGet(
                    response,
                    decodeURIComponent(reclaimJobMatch[1]),
                );
                return;
            }
        }

        if (pathname === "/api/storage/manual-reclamation") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleManualReclamationGet(request, response);
            return;
        }

        if (pathname === "/api/storage/manual-reclamation/mark-handled") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleManualReclamationMarkHandledPost(request, response);
            return;
        }

        if (pathname === "/api/storage/reclaim-manifests") {
            if (!requireMethod(request, response, ["GET"])) {
                return;
            }

            await handleStorageReclaimManifestsGet(response);
            return;
        }

        {
            const reclaimManifestMatch = pathname.match(
                /^\/api\/storage\/reclaim-manifests\/([^/]+)$/,
            );

            if (reclaimManifestMatch) {
                if (!requireMethod(request, response, ["GET"])) {
                    return;
                }

                await handleStorageReclaimManifestGet(
                    response,
                    decodeURIComponent(reclaimManifestMatch[1]),
                );
                return;
            }
        }

        if (pathname === "/api/storage/removals/request") {
            if (!requireMethod(request, response, ["POST"])) {
                return;
            }

            await handleStorageRemovalRequestPost(request, response);
            return;
        }

        {
            const removalCancelMatch = pathname.match(
                /^\/api\/storage\/removals\/([^/]+)\/cancel$/,
            );

            if (removalCancelMatch) {
                if (!requireMethod(request, response, ["POST"])) {
                    return;
                }

                await handleStorageRemovalCancelPost(
                    response,
                    decodeURIComponent(removalCancelMatch[1]),
                );
                return;
            }
        }

        {
            const removalGetMatch = pathname.match(
                /^\/api\/storage\/removals\/([^/]+)$/,
            );

            if (removalGetMatch) {
                if (!requireMethod(request, response, ["GET"])) {
                    return;
                }

                await handleStorageRemovalGet(
                    response,
                    decodeURIComponent(removalGetMatch[1]),
                );
                return;
            }
        }

        sendError(response, 404, "Route not found.");
    } catch (error) {
        console.error("Unhandled request error:", error.message);
        sendError(response, 500, "Unexpected server error.");
    }
}


async function main() {
    const { loaded } = await initializeChat();
    await initializeConversationLifecycle();
    const transcriptInit = await initializeTranscript();
    await initializeConversationMemory();
    await bootstrapTransferRuntime();
    bootstrapReclaimRuntime();
    await bootstrapRemovalRuntime();

    const server = http.createServer(handleRequest);

    server.listen(PORT, HOST, () => {
        console.log("Local AI API");
        console.log(`http://${HOST}:${PORT}`);
        console.log(
            loaded ? "Chat history loaded." : "No previous conversation found.",
        );
        if (transcriptInit.migrated) {
            console.log(
                `Transcript migrated (${transcriptInit.migratedCount ?? 0} messages).`,
            );
        } else {
            console.log("Conversation transcript ready.");
        }
        console.log("Conversation archive ready.");
        console.log("Conversation Memory ready.");
    });
}


main().catch((error) => {
    console.error("Could not start the API server:");
    console.error(error.message);
    process.exitCode = 1;
});
