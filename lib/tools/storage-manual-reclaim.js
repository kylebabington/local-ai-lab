// =========================================================
// lib/tools/storage-manual-reclaim.js
//
// Milestone D2.5: guided, read-only manual reclamation for
// real user files that already passed Milestones C and D1.
// Never deletes, recycles, moves, or calls the native helper
// for real paths. Explorer performs all filesystem mutations.
// =========================================================


import fs from "node:fs/promises";
import path from "node:path";

import { appendActivity } from "../activity.js";
import {
    findGrantForPath,
    getActiveSession,
    getSessionReclaimJob,
} from "../storage-session.js";
import { isPathInsideSyntheticReclaimRoot } from "../synthetic-reclaim-roots.js";
import {
    RECLAIM_ELIGIBLE,
    RECLAIM_EXCLUDED,
    _test as reclaimTest,
} from "./storage-reclaim.js";
import {
    loadTransferJournal,
    refreshAndMatchDestination,
} from "./storage-transfer.js";


const STATE_PATH = path.join(process.cwd(), "data", "manual-reclamation.json");

/** @type {Map<string, object>} */
const liveObserveJobs = new Map();
let stateCache = null;
let stateLoaded = false;


function manualError(message, code, status = 400) {
    return Object.assign(new Error(message), { code, status });
}


async function loadState() {
    if (stateLoaded && stateCache) {
        return stateCache;
    }
    try {
        const raw = await fs.readFile(STATE_PATH, "utf8");
        stateCache = JSON.parse(raw);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
        stateCache = { version: 1, entries: {} };
    }
    stateLoaded = true;
    return stateCache;
}


async function saveState() {
    const state = await loadState();
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}


function entryKey(transferId, entryId) {
    return `${transferId}::${entryId}`;
}


function publicHandledRecord(record) {
    if (!record) {
        return null;
    }
    return {
        transferId: record.transferId,
        entryId: record.entryId,
        sourcePath: record.sourcePath,
        userReportedStatus: record.userReportedStatus,
        note: record.note || null,
        markedAt: record.markedAt,
        actor: "user",
        label: "user_reported_manual_reclamation",
        machineRemoved: false,
    };
}


export function buildManualRecoveryGuidance(candidate) {
    const recommended =
        candidate.eligibility === RECLAIM_ELIGIBLE &&
        candidate.destinationHashVerified === true &&
        candidate.cloudReparseSafety?.status === "safe" &&
        candidate.sourceAuthorization?.status === "authorized";

    const excludedFromRecommendation =
        candidate.eligibility === RECLAIM_EXCLUDED ||
        candidate.cloudReparseSafety?.status === "unsafe" ||
        candidate.cloudReparseSafety?.status === "failed" ||
        /cloud|onedrive|placeholder/i.test(
            String(candidate.cloudReparseSafety?.reason || ""),
        ) ||
        /protected/i.test(
            [...(candidate.reasons || []), ...(candidate.warnings || [])].join(
                " ",
            ),
        );

    const warnings = [
        "Local AI will not delete, recycle, or move this file for you.",
        "A single external copy is not sufficient backup protection for irreplaceable files.",
        "Moving a file into the Recycle Bin may not immediately recover usable free disk space.",
        "This file is never represented as definitely unused or safe to delete.",
    ];

    if (candidate.dependencyConfidence?.status !== "clear") {
        warnings.push(
            "Dependency confidence is uncertain — applications or projects may still need this file.",
        );
    }
    if (excludedFromRecommendation) {
        warnings.push(
            "This file is excluded from recommended manual cleanup (cloud, protected, or policy reasons).",
        );
    }
    if (!candidate.destinationHashVerified) {
        warnings.push(
            "Destination copy is not currently verified — do not remove the original until re-verification succeeds.",
        );
    }

    return {
        recommendedForManualReview: recommended && !excludedFromRecommendation,
        excludedFromRecommendation,
        neverClaimsSafeToDelete: true,
        actorMustBeUserInExplorer: true,
        prerequisites: [
            "Destination copy must currently verify (SHA-256 match).",
            "External drive must be connected with matching volume identity.",
            "Review dependency and cloud warnings below.",
        ],
        explorerSteps: [
            "Copy the original path using the panel control.",
            "Open File Explorer and paste the path into the address bar (or locate the parent folder).",
            "Confirm the file name, size, and that you intend to act on this exact item.",
            "If you choose to reclaim space, use Explorer to move the original to the Recycle Bin yourself — Local AI will not do this.",
            "Return here and use Recheck source status / Mark as manually handled to record observations.",
        ],
        warnings,
        dependencyStatus: candidate.dependencyConfidence?.status ?? "unknown",
        cloudStatus: candidate.cloudReparseSafety?.status ?? "unknown",
        eligibility: candidate.eligibility,
    };
}


export async function listManualReclamation(transferId) {
    if (typeof transferId !== "string" || !transferId.trim()) {
        throw manualError("transferId is required.", "INVALID_ARGS");
    }
    const state = await loadState();
    const rows = Object.values(state.entries).filter(
        (row) => row.transferId === transferId,
    );
    return {
        transferId,
        entries: rows.map(publicHandledRecord),
        note: "User-reported actions only. Local AI did not remove these files.",
    };
}


export async function markManuallyHandled({
    transferId,
    entryId,
    note = "",
    reclaimJobId = null,
} = {}) {
    if (typeof transferId !== "string" || !transferId.trim()) {
        throw manualError("transferId is required.", "INVALID_ARGS");
    }
    if (typeof entryId !== "string" || !entryId.trim()) {
        throw manualError("entryId is required.", "INVALID_ARGS");
    }

    let sourcePath = null;
    if (reclaimJobId) {
        const job = getSessionReclaimJob(reclaimJobId, getActiveSession());
        const candidate = job?.candidates?.find((c) => c.entryId === entryId);
        if (candidate) {
            sourcePath = candidate.sourcePath;
        }
    }

    const state = await loadState();
    const key = entryKey(transferId, entryId);
    const record = {
        transferId,
        entryId,
        sourcePath,
        userReportedStatus: "manually_handled",
        note: typeof note === "string" ? note.slice(0, 500) : "",
        markedAt: new Date().toISOString(),
        actor: "user",
        machineRemoved: false,
    };
    state.entries[key] = record;
    await saveState();

    await appendActivity({
        tool: "manual_reclamation",
        action: "mark_handled",
        summary: "User reported manual reclamation handling",
        transferId,
        entryId,
        label: "user_reported_manual_reclamation",
        machineRemoved: false,
    });

    return publicHandledRecord(record);
}


function findCandidate(job, entryId) {
    return (job.candidates ?? []).find((c) => c.entryId === entryId) ?? null;
}


async function observeOneEntry(job, candidate, options = {}) {
    const observedAt = new Date().toISOString();
    const transferId = job.transferId;
    const journal = await loadTransferJournal(transferId);
    const destinationMeta =
        journal?.destination ??
        job.journalDestination ??
        job.trust?.snapshot?.destination ??
        null;

    let volume = null;
    let volumeIdentityMatch = false;
    let volumeError = null;
    let freeBytesObserved = null;
    try {
        if (!destinationMeta?.volumeId) {
            throw manualError(
                "Transfer destination identity is missing.",
                "DESTINATION_UNKNOWN",
                409,
            );
        }
        volume = await refreshAndMatchDestination(destinationMeta);
        volumeIdentityMatch = true;
        freeBytesObserved =
            typeof volume.freeBytes === "number" ? volume.freeBytes : null;
    } catch (error) {
        volumeError = error.message;
        volumeIdentityMatch = false;
    }

    let originalStatus = "outcome_uncertain";
    try {
        const st = await fs.lstat(candidate.sourcePath);
        if (st.isSymbolicLink() || st.isFile() || st.isDirectory()) {
            originalStatus = "original_still_present";
        }
    } catch (error) {
        if (error.code === "ENOENT") {
            originalStatus = "original_no_longer_found";
        } else {
            originalStatus = "outcome_uncertain";
        }
    }

    let destinationVerification = {
        status: "not_checked",
        hashMatched: false,
        detail: null,
    };

    if (!volumeIdentityMatch) {
        destinationVerification = {
            status: "recovery_unavailable",
            hashMatched: false,
            detail: volumeError || "Destination volume unavailable or mismatched.",
        };
    } else if (options.skipHash) {
        destinationVerification = {
            status: "skipped",
            hashMatched: false,
            detail: "Hash verification skipped for this observe pass.",
        };
    } else {
        try {
            if (!findGrantForPath(candidate.sourcePath) && originalStatus === "original_still_present") {
                // Grant needed only when we would also hash the source; destination
                // under offload root can still be hashed for independent verify.
            }
            const journalFile = journal?.files?.find(
                (f) => f.entryId === candidate.entryId,
            );
            const expectedHash =
                journalFile?.destinationHash ?? journalFile?.sourceHash ?? null;

            const destPath = candidate.destinationPath;
            const destHash = await reclaimTest.streamHashFile(destPath, {
                highWaterMark: reclaimTest.HASH_BUFFER_BYTES,
            });

            let matched = false;
            if (expectedHash) {
                matched = destHash === expectedHash;
            } else if (originalStatus === "original_still_present") {
                const srcHash = await reclaimTest.streamHashFile(
                    candidate.sourcePath,
                    { highWaterMark: reclaimTest.HASH_BUFFER_BYTES },
                );
                matched = destHash === srcHash;
            }

            destinationVerification = matched
                ? {
                      status: "external_copy_independently_verified",
                      hashMatched: true,
                      detail: "Destination SHA-256 verified independently.",
                  }
                : {
                      status: "destination_mismatch",
                      hashMatched: false,
                      detail: "Destination hash did not match expected value.",
                  };
        } catch (error) {
            destinationVerification = {
                status: "recovery_unavailable",
                hashMatched: false,
                detail: error.message,
            };
        }
    }

    const priorFree =
        typeof options.priorFreeBytes === "number"
            ? options.priorFreeBytes
            : null;
    let freeSpaceChangeObserved = null;
    let freeSpaceAttribution =
        "Free-space measurements are observed snapshots only; unrelated system activity may change free space.";
    if (
        priorFree != null &&
        freeBytesObserved != null &&
        Number.isFinite(priorFree) &&
        Number.isFinite(freeBytesObserved)
    ) {
        freeSpaceChangeObserved = freeBytesObserved - priorFree;
        if (freeSpaceChangeObserved !== 0) {
            freeSpaceAttribution =
                "A free-space change was observed but is not attributed to Local AI removal (none occurred). " +
                "It also cannot be proven to result solely from the user's Explorer action.";
        }
    }

    const state = await loadState();
    const handled = state.entries[entryKey(transferId, candidate.entryId)];

    const guidance = buildManualRecoveryGuidance(candidate);

    return {
        entryId: candidate.entryId,
        transferId,
        sourcePath: candidate.sourcePath,
        destinationPath: candidate.destinationPath,
        sizeBytes: candidate.sizeBytes,
        eligibility: candidate.eligibility,
        lastVerifiedAt: candidate.lastVerifiedAt ?? null,
        sourceHashVerified: candidate.sourceHashVerified === true,
        destinationHashVerified: candidate.destinationHashVerified === true,
        dependencyConfidence: candidate.dependencyConfidence,
        cloudReparseSafety: candidate.cloudReparseSafety,
        warnings: candidate.warnings ?? [],
        reasons: candidate.reasons ?? [],
        manualReviewNeeds: candidate.manualReviewNeeds ?? [],
        volumeIdentityMatch,
        volumeId: volume?.volumeId ?? destinationMeta?.volumeId ?? null,
        volumeMount: volume?.mount ?? null,
        freeBytesObserved,
        freeBytesPrior: priorFree,
        freeSpaceChangeObserved,
        freeSpaceAttribution,
        originalStatus,
        destinationVerification,
        userReported: publicHandledRecord(handled),
        machineClaim: {
            localAiRemovedFile: false,
            note: "Local AI does not remove real user files. Any absence of the original is user- or system-driven.",
        },
        guidance,
        observedAt,
        syntheticRemovalAuthorized: Boolean(
            isPathInsideSyntheticReclaimRoot(candidate.sourcePath),
        ),
    };
}


/**
 * Reverify one entry from a completed reclaim job (destination hash + source existence).
 */
export async function reverifyManualEntry(reclaimJobId, entryId) {
    const session = getActiveSession();
    const job = getSessionReclaimJob(reclaimJobId, session);
    if (!job || job.sessionId !== session?.id) {
        throw manualError("Unknown reclaim job.", "UNKNOWN_JOB", 404);
    }
    const candidate = findCandidate(job, entryId);
    if (!candidate) {
        throw manualError("Unknown reclaim entry.", "UNKNOWN_ENTRY", 404);
    }

    const observeId = `reverify-${reclaimJobId}-${entryId}`;
    if (liveObserveJobs.size >= 1) {
        throw manualError(
            "Another manual verification job is already running.",
            "MANUAL_BUSY",
            409,
        );
    }

    const handle = { cancelRequested: false, id: observeId };
    liveObserveJobs.set(observeId, handle);
    try {
        const result = await observeOneEntry(job, candidate, {});
        if (handle.cancelRequested) {
            return { ...result, cancelled: true, partial: true };
        }
        return result;
    } finally {
        liveObserveJobs.delete(observeId);
    }
}


/**
 * Observe one or more entries after the user may have cleaned up in Explorer.
 */
export async function observeManualCleanup(reclaimJobId, entryIds, options = {}) {
    const opts =
        options && typeof options === "object" && !Array.isArray(options)
            ? options
            : { priorFreeBytes: options ?? null };
    const session = getActiveSession();
    const job = getSessionReclaimJob(reclaimJobId, session);
    if (!job || job.sessionId !== session?.id) {
        throw manualError("Unknown reclaim job.", "UNKNOWN_JOB", 404);
    }
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
        throw manualError("entryIds must be a non-empty array.", "INVALID_ARGS");
    }
    if (entryIds.length > 25) {
        throw manualError("At most 25 entries per observe request.", "TOO_MANY");
    }

    const observeId = `observe-${reclaimJobId}-${Date.now()}`;
    if (liveObserveJobs.size >= 1) {
        throw manualError(
            "Another manual verification job is already running.",
            "MANUAL_BUSY",
            409,
        );
    }

    const handle = { cancelRequested: false, id: observeId };
    liveObserveJobs.set(observeId, handle);

    const results = [];
    try {
        for (const entryId of entryIds) {
            if (handle.cancelRequested) {
                break;
            }
            const candidate = findCandidate(job, entryId);
            if (!candidate) {
                results.push({
                    entryId,
                    originalStatus: "outcome_uncertain",
                    detail: "Unknown entry on reclaim job.",
                });
                continue;
            }
            results.push(
                await observeOneEntry(job, candidate, {
                    priorFreeBytes: opts.priorFreeBytes ?? null,
                }),
            );
        }
        return {
            reclaimJobId,
            transferId: job.transferId,
            cancelled: handle.cancelRequested === true,
            partial: handle.cancelRequested === true,
            results,
            machineClaim: {
                localAiRemovedFile: false,
                note: "Observations only. Local AI did not remove files.",
            },
        };
    } finally {
        liveObserveJobs.delete(observeId);
    }
}


export function cancelManualObserveJobs() {
    for (const job of liveObserveJobs.values()) {
        job.cancelRequested = true;
    }
    return { cancelled: liveObserveJobs.size };
}


export function getManualGuidanceForJob(reclaimJobId, entryId) {
    const session = getActiveSession();
    const job = getSessionReclaimJob(reclaimJobId, session);
    if (!job || job.sessionId !== session?.id) {
        throw manualError("Unknown reclaim job.", "UNKNOWN_JOB", 404);
    }
    const candidate = findCandidate(job, entryId);
    if (!candidate) {
        throw manualError("Unknown reclaim entry.", "UNKNOWN_ENTRY", 404);
    }
    return {
        entryId,
        transferId: job.transferId,
        sourcePath: candidate.sourcePath,
        destinationPath: candidate.destinationPath,
        guidance: buildManualRecoveryGuidance(candidate),
    };
}


export const _test = {
    STATE_PATH,
    loadState,
    saveState,
    buildManualRecoveryGuidance,
    entryKey,
    liveObserveJobs,
    resetStateForTests: async () => {
        stateCache = { version: 1, entries: {} };
        stateLoaded = true;
        await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
        await fs.writeFile(
            STATE_PATH,
            `${JSON.stringify(stateCache, null, 2)}\n`,
            "utf8",
        );
    },
};
