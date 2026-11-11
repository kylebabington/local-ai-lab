import { apiRequest } from "./http";
import type {
    LockedManifest,
    OffloadPlan,
    PendingApproval,
    ReclaimJob,
    ReclaimManifest,
    RemovalJob,
    StorageDriveSnapshot,
    StorageGrant,
    StorageSession,
    StorageTransfer,
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

export async function requestStorageTransfer(body: {
    manifestId: string;
    reason?: string;
    authorizeHydrateCloudFiles?: boolean;
}): Promise<{ approval: PendingApproval }> {
    return apiRequest<{ approval: PendingApproval }>(
        "/api/storage/transfers/request",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        },
    );
}

export async function fetchStorageTransfers(): Promise<StorageTransfer[]> {
    const data = await apiRequest<{ transfers: StorageTransfer[] }>(
        "/api/storage/transfers",
    );
    return data.transfers ?? [];
}

export async function fetchStorageTransfer(
    transferId: string,
): Promise<StorageTransfer> {
    const data = await apiRequest<{ transfer: StorageTransfer }>(
        `/api/storage/transfers/${encodeURIComponent(transferId)}`,
    );
    return data.transfer;
}

export async function cancelStorageTransfer(
    transferId: string,
): Promise<StorageTransfer> {
    const data = await apiRequest<{ transfer: StorageTransfer }>(
        `/api/storage/transfers/${encodeURIComponent(transferId)}/cancel`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        },
    );
    return data.transfer;
}

export async function startStorageReclaimReview(
    transferId: string,
    body: { entryIds?: string[]; maxMs?: number } = {},
): Promise<ReclaimJob> {
    const data = await apiRequest<{ job: ReclaimJob }>(
        `/api/storage/transfers/${encodeURIComponent(transferId)}/reclaim-review`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        },
    );
    return data.job;
}

export async function fetchStorageReclaimJobs(): Promise<ReclaimJob[]> {
    const data = await apiRequest<{ jobs?: ReclaimJob[] }>(
        "/api/storage/reclaim-jobs",
    );
    return data.jobs ?? [];
}

export async function fetchStorageReclaimJob(jobId: string): Promise<ReclaimJob> {
    const data = await apiRequest<{ job: ReclaimJob }>(
        `/api/storage/reclaim-jobs/${encodeURIComponent(jobId)}`,
    );
    return data.job;
}

export async function cancelStorageReclaimJob(jobId: string): Promise<ReclaimJob> {
    const data = await apiRequest<{ job: ReclaimJob }>(
        `/api/storage/reclaim-jobs/${encodeURIComponent(jobId)}/cancel`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        },
    );
    return data.job;
}

export async function lockReclaimSelection(
    jobId: string,
    entryIds: string[],
): Promise<ReclaimManifest> {
    const data = await apiRequest<{ manifest: ReclaimManifest }>(
        `/api/storage/reclaim-jobs/${encodeURIComponent(jobId)}/selection`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ entryIds }),
        },
    );
    return data.manifest;
}

export async function requestStorageRemoval(body: {
    reclaimManifestId: string;
    reason?: string;
}): Promise<{ approval: PendingApproval }> {
    return apiRequest<{ approval: PendingApproval }>(
        "/api/storage/removals/request",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        },
    );
}

export async function fetchStorageRemoval(removalId: string): Promise<RemovalJob> {
    const data = await apiRequest<{ removal: RemovalJob }>(
        `/api/storage/removals/${encodeURIComponent(removalId)}`,
    );
    return data.removal;
}

export async function cancelStorageRemoval(removalId: string): Promise<RemovalJob> {
    const data = await apiRequest<{ removal: RemovalJob }>(
        `/api/storage/removals/${encodeURIComponent(removalId)}/cancel`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        },
    );
    return data.removal;
}

export interface ManualObservation {
    entryId: string;
    transferId: string;
    sourcePath: string;
    destinationPath: string;
    sizeBytes: number;
    eligibility: string;
    lastVerifiedAt: string | null;
    sourceHashVerified: boolean;
    destinationHashVerified: boolean;
    volumeIdentityMatch: boolean;
    volumeId: string | null;
    volumeMount: string | null;
    freeBytesObserved: number | null;
    freeBytesPrior: number | null;
    freeSpaceChangeObserved: number | null;
    freeSpaceAttribution: string;
    originalStatus: string;
    destinationVerification: {
        status: string;
        hashMatched: boolean;
        detail: string | null;
    };
    userReported: {
        userReportedStatus: string;
        note: string | null;
        markedAt: string;
        label: string;
        machineRemoved: boolean;
    } | null;
    machineClaim: {
        localAiRemovedFile: boolean;
        note: string;
    };
    guidance: {
        recommendedForManualReview: boolean;
        excludedFromRecommendation: boolean;
        explorerSteps: string[];
        warnings: string[];
        prerequisites: string[];
    };
    observedAt: string;
}

export async function reverifyManualEntry(
    reclaimJobId: string,
    entryId: string,
): Promise<ManualObservation> {
    const data = await apiRequest<{ observation: ManualObservation }>(
        `/api/storage/reclaim-jobs/${encodeURIComponent(reclaimJobId)}/entries/${encodeURIComponent(entryId)}/reverify`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        },
    );
    return data.observation;
}

export async function observeManualCleanup(
    reclaimJobId: string,
    entryIds: string[],
    priorFreeBytes?: number | null,
): Promise<{ results: ManualObservation[]; machineClaim: { localAiRemovedFile: boolean; note: string } }> {
    return apiRequest(
        `/api/storage/reclaim-jobs/${encodeURIComponent(reclaimJobId)}/manual-observe`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ entryIds, priorFreeBytes }),
        },
    );
}

export async function markManualReclamationHandled(body: {
    transferId: string;
    entryId: string;
    reclaimJobId?: string;
    note?: string;
}): Promise<{ entry: { userReportedStatus: string; markedAt: string; label: string } }> {
    return apiRequest("/api/storage/manual-reclamation/mark-handled", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export async function fetchManualGuidance(
    reclaimJobId: string,
    entryId: string,
): Promise<{
    guidance: {
        recommendedForManualReview: boolean;
        excludedFromRecommendation: boolean;
        explorerSteps: string[];
        warnings: string[];
        prerequisites: string[];
    };
}> {
    return apiRequest(
        `/api/storage/reclaim-jobs/${encodeURIComponent(reclaimJobId)}/entries/${encodeURIComponent(entryId)}/guidance`,
    );
}
