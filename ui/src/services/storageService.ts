import { apiRequest } from "./http";
import type {
    LockedManifest,
    OffloadPlan,
    StorageDriveSnapshot,
    StorageGrant,
    StorageSession,
} from "../types";

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

export async function fetchStorageDrives(): Promise<StorageDriveSnapshot> {
    return apiRequest<StorageDriveSnapshot>("/api/storage/drives");
}

export async function refreshStorageDrives(): Promise<StorageDriveSnapshot> {
    return apiRequest<StorageDriveSnapshot>("/api/storage/drives/refresh", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });
}

export async function fetchStoragePlans(): Promise<OffloadPlan[]> {
    const data = await apiRequest<{ plans: OffloadPlan[] }>("/api/storage/plans");
    return data.plans ?? [];
}

export async function fetchStoragePlan(planId: string): Promise<OffloadPlan> {
    const data = await apiRequest<{ plan: OffloadPlan }>(
        `/api/storage/plans/${encodeURIComponent(planId)}`,
    );
    return data.plan;
}

export async function createStoragePlan(body: {
    destinationVolumeId: string;
    destinationFolderName?: string;
    sources?: string[];
    minBytes?: number;
}): Promise<{ planId: string } & Record<string, unknown>> {
    return apiRequest("/api/storage/plans", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export async function lockStorageSelection(
    planId: string,
    entryIds: string[],
): Promise<LockedManifest> {
    return apiRequest<LockedManifest>(
        `/api/storage/plans/${encodeURIComponent(planId)}/selection`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ entryIds }),
        },
    );
}
