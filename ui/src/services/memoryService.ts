/**
 * Conversation Memory API adapter.
 */

import type { ConversationMemoryStatus, MemorySource } from "../types";
import { apiRequest } from "./http";

export async function fetchMemoryStatus(): Promise<ConversationMemoryStatus> {
    return apiRequest<ConversationMemoryStatus>("/api/memory/status");
}

export async function rebuildMemoryIndex(): Promise<{
    ok: boolean;
    status: ConversationMemoryStatus;
}> {
    return apiRequest("/api/memory/index", {
        method: "POST",
    });
}

export async function searchMemory(
    query: string,
    topK?: number,
): Promise<{ results: MemorySource[] }> {
    const data = await apiRequest<{
        results: Array<Partial<MemorySource> & { preview?: string }>;
    }>("/api/memory/search", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, topK }),
    });

    return {
        results: (data.results ?? []).map((item) => ({
            sourceType: "memory" as const,
            memoryId: item.memoryId ?? "",
            chunkId: item.chunkId ?? "",
            similarity: item.similarity ?? 0,
            startedAt: item.startedAt ?? null,
            endedAt: item.endedAt ?? null,
            contextModes: item.contextModes ?? [],
            preview: item.preview ?? "",
        })),
    };
}
