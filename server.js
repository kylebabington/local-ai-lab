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
//   lib/rag.js
//   lib/ollama.js
//   lib/agent.js
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
    listPendingApprovals,
    rejectById,
    runAgent,
} from "./lib/agent.js";

import { readActivity } from "./lib/activity.js";
import {
    describeAllowedRoots,
    listTools,
} from "./lib/tools/registry.js";


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

    try {
        const result = await sendChatMessage(message);
        sendJson(response, 200, { answer: result.answer });
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


async function handleApprovalDecision(response, id, action) {
    try {
        const result =
            action === "approve" ? await approveById(id) : await rejectById(id);
        sendJson(response, 200, result);
    } catch (error) {
        const message = userSafeMessage(error, "Approval update failed.");
        const status =
            message.includes("Unknown or expired") ? 404 : errorStatus(error);
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


async function handleRequest(request, response) {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
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

            // Body is ignored. Approval/rejection uses the stored id only.
            try {
                await readJsonBody(request);
            } catch (error) {
                if (error.status === 413) {
                    sendError(response, 413, error.message);
                    return;
                }
            }

            await handleApprovalDecision(
                response,
                decodeURIComponent(approvalMatch[1]),
                approvalMatch[2],
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

        sendError(response, 404, "Route not found.");
    } catch (error) {
        console.error("Unhandled request error:", error.message);
        sendError(response, 500, "Unexpected server error.");
    }
}


async function main() {
    const { loaded } = await initializeChat();

    const server = http.createServer(handleRequest);

    server.listen(PORT, HOST, () => {
        console.log("Local AI API");
        console.log(`http://${HOST}:${PORT}`);
        console.log(
            loaded ? "Chat history loaded." : "No previous conversation found.",
        );
    });
}


main().catch((error) => {
    console.error("Could not start the API server:");
    console.error(error.message);
    process.exitCode = 1;
});
