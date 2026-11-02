import { apiRequest } from "./http";
import type { StorageGrant, StorageSession } from "../types";

export async function fetchStorageSession(): Promise<StorageSession> {
    return apiRequest<StorageSession>("/api/storage/session");
}

export async function grantStorageFolder(folderPath: string): Promise<StorageSession & { grant: StorageGrant }> {
    return apiRequest<StorageSession & { grant: StorageGrant }>(
        "/api/storage/grants",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ path: folderPath }),
        },
    );
}

export async function revokeStorageGrant(id: string): Promise<StorageSession> {
    return apiRequest<StorageSession>(
        `/api/storage/grants/${encodeURIComponent(id)}`,
        { method: "DELETE" },
    );
}

export async function revokeAllStorageGrants(): Promise<StorageSession> {
    return apiRequest<StorageSession>("/api/storage/grants/revoke-all", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });
}

export async function cancelStorageScan(): Promise<StorageSession> {
    return apiRequest<StorageSession>("/api/storage/cancel", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });
}
