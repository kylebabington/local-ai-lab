/**
 * File Intelligence API — metadata inventory + content index.
 * Pages must not call fetch directly.
 */

import { apiRequest } from "./http";
import type {
    FileContentIndexStatus,
    FileInventoryStatus,
    FileInventorySummary,
    FileRoot,
    FileSearchParams,
    FileSearchResponse,
    FileSemanticMatch,
} from "../types";

export async function fetchFileStatus(): Promise<FileInventoryStatus> {
    return apiRequest<FileInventoryStatus>("/api/files/status");
}

export async function fetchFileRoots(): Promise<FileRoot[]> {
    const data = await apiRequest<{ roots?: FileRoot[] }>("/api/files/roots");
    return data.roots ?? [];
}

export async function addFileRoot(folderPath: string): Promise<FileRoot> {
    const trimmed = folderPath.trim();

    if (!trimmed) {
        throw new Error("Enter an absolute folder path.");
    }

    const data = await apiRequest<{ root: FileRoot }>("/api/files/roots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: trimmed }),
    });

    return data.root;
}

export async function removeFileRoot(id: string): Promise<FileRoot> {
    const data = await apiRequest<{ root: FileRoot }>(
        "/api/files/roots/remove",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
        },
    );

    return data.root;
}

export async function scanFileInventory(): Promise<FileInventorySummary> {
    const data = await apiRequest<{ summary: FileInventorySummary }>(
        "/api/files/scan",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        },
    );

    return data.summary;
}

export async function searchFiles(
    params: FileSearchParams = {},
): Promise<FileSearchResponse> {
    const search = new URLSearchParams();

    if (params.query?.trim()) {
        search.set("query", params.query.trim());
    }

    if (params.rootId?.trim()) {
        search.set("rootId", params.rootId.trim());
    }

    if (params.extension?.trim()) {
        search.set("extension", params.extension.trim());
    }

    if (params.limit != null) {
        search.set("limit", String(params.limit));
    }

    if (params.offset != null) {
        search.set("offset", String(params.offset));
    }

    if (params.sort) {
        search.set("sort", params.sort);
    }

    if (params.direction) {
        search.set("direction", params.direction);
    }

    const query = search.toString();
    const path = query ? `/api/files?${query}` : "/api/files";

    return apiRequest<FileSearchResponse>(path);
}

export async function fetchFileContentIndexStatus(): Promise<FileContentIndexStatus> {
    return apiRequest<FileContentIndexStatus>("/api/files/index/status");
}

export async function indexFileContents(): Promise<{
    summary: Record<string, number>;
}> {
    return apiRequest<{ summary: Record<string, number> }>("/api/files/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
}

export async function semanticSearchFiles(params: {
    query: string;
    rootId?: string;
    extension?: string;
    limit?: number;
}): Promise<FileSemanticMatch[]> {
    const trimmed = params.query.trim();

    if (!trimmed) {
        throw new Error("Enter a semantic search query.");
    }

    const data = await apiRequest<{ matches?: FileSemanticMatch[] }>(
        "/api/files/semantic-search",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: trimmed,
                rootId: params.rootId,
                extension: params.extension,
                limit: params.limit,
            }),
        },
    );

    return data.matches ?? [];
}
