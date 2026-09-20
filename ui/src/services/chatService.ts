/**
 * Frontend adapter for the local Node API.
 *
 * React components must talk to this module only.
 * They must not call Ollama or localhost:11434.
 */

import type {
    ChatRequest,
    ChatResponse,
    ChatMessage,
    ChatSource,
    FileRagSource,
    RagSource,
    ToolActionStatus,
    PendingApproval,
    ToolUseLine,
} from "../types";
import { apiRequest } from "./http";

function createId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isFileRagSource(source: ChatSource): source is FileRagSource {
    return "sourceType" in source && source.sourceType === "file";
}

function mapFileMatches(
    matches: Array<Partial<FileRagSource> & { filePath?: string }> | undefined,
): FileRagSource[] {
    if (!matches) {
        return [];
    }

    return matches.map((match) => ({
        sourceType: "file" as const,
        filePath: match.filePath ?? "",
        name: match.name ?? match.filePath ?? "",
        rootId: match.rootId ?? "",
        chunkIndex: match.chunkIndex ?? 0,
        similarity: match.similarity ?? 0,
        pageStart: match.pageStart,
        pageEnd: match.pageEnd,
    }));
}

export function historyToMessages(
    items: Array<{ role: string; content: string; createdAt: string | null }>,
): ChatMessage[] {
    return items
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item, index) => ({
            id: `history-${index}`,
            role: item.role as "user" | "assistant",
            content: item.content,
            createdAt: item.createdAt,
            contextMode: "chat",
        }));
}

type TranscriptMessagePayload = {
    id: string;
    role: string;
    content: string;
    createdAt: string | null;
    contextMode?: ChatMessage["contextMode"];
    sources?: ChatSource[];
    toolUses?: ToolUseLine[];
    approval?: PendingApproval | null;
    approvalStatus?: ToolActionStatus;
};

function transcriptToMessages(items: TranscriptMessagePayload[]): ChatMessage[] {
    return items
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => ({
            id: item.id,
            role: item.role as "user" | "assistant",
            content: item.content,
            createdAt: item.createdAt,
            contextMode: item.contextMode,
            sources: item.sources,
            toolUses: item.toolUses,
            approval: item.approval,
            approvalStatus: item.approvalStatus,
        }));
}

function toTranscriptPayload(message: ChatMessage): TranscriptMessagePayload {
    if (!message.contextMode) {
        throw new Error("Transcript messages require contextMode.");
    }

    const payload: TranscriptMessagePayload = {
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        contextMode: message.contextMode,
    };

    if (message.sources !== undefined) {
        payload.sources = message.sources;
    }

    if (message.toolUses !== undefined) {
        payload.toolUses = message.toolUses;
    }

    if (message.approval !== undefined) {
        payload.approval = message.approval;
    }

    if (message.approvalStatus !== undefined) {
        payload.approvalStatus = message.approvalStatus;
    }

    return payload;
}

export async function loadTranscript(): Promise<ChatMessage[]> {
    const data = await apiRequest<{ messages: TranscriptMessagePayload[] }>(
        "/api/transcript",
    );

    return transcriptToMessages(data.messages ?? []);
}

export async function appendTranscriptMessages(
    messages: ChatMessage[],
): Promise<ChatMessage[]> {
    const data = await apiRequest<{
        ok: boolean;
        appended: number;
        messages: TranscriptMessagePayload[];
    }>("/api/transcript/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            messages: messages.map(toTranscriptPayload),
        }),
    });

    return transcriptToMessages(data.messages ?? []);
}

export async function patchTranscriptMessage(
    id: string,
    patch: {
        content?: string;
        sources?: ChatSource[];
        toolUses?: ToolUseLine[];
        approval?: PendingApproval | null;
        approvalStatus?: ToolActionStatus;
    },
): Promise<ChatMessage> {
    const data = await apiRequest<{
        ok: boolean;
        message: TranscriptMessagePayload;
    }>(`/api/transcript/messages/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
    });

    return transcriptToMessages([data.message])[0];
}

export async function clearTranscript(): Promise<void> {
    await apiRequest<{ ok: boolean }>("/api/transcript", {
        method: "DELETE",
    });
}

/** @deprecated Prefer loadTranscript for the unified Chat page. */
export async function loadChatHistory(): Promise<ChatMessage[]> {
    const data = await apiRequest<{
        messages: Array<{
            role: string;
            content: string;
            createdAt: string | null;
        }>;
    }>("/api/chat/history");

    return historyToMessages(data.messages ?? []);
}

/** @deprecated Prefer clearTranscript for the unified Chat page. */
export async function clearChatHistory(): Promise<void> {
    await apiRequest<{ ok: boolean }>("/api/chat/history", {
        method: "DELETE",
    });
}

export async function sendChatMessage(
    request: ChatRequest,
): Promise<ChatResponse> {
    const message = request.message.trim();

    if (!message) {
        throw new Error("Message cannot be empty.");
    }

    if (request.contextMode === "computer") {
        throw new Error("Computer mode must use the agent service.");
    }

    if (request.contextMode === "file") {
        const data = await apiRequest<{
            answer: string;
            matches?: Array<Partial<FileRagSource> & { filePath?: string }>;
        }>("/api/files/ask", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ question: message }),
        });

        return {
            answer: data.answer,
            sources: mapFileMatches(data.matches),
        };
    }

    if (request.contextMode === "project") {
        const data = await apiRequest<{
            answer: string;
            matches?: RagSource[];
        }>("/api/rag", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ question: message }),
        });

        return {
            answer: data.answer,
            sources: data.matches ?? [],
        };
    }

    const data = await apiRequest<{ answer: string }>("/api/chat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
    });

    return {
        answer: data.answer,
    };
}

export { createId, isFileRagSource, transcriptToMessages };
