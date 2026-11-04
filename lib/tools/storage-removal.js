// =========================================================
// lib/tools/storage-removal.js
//
// Milestone D2: approval-gated verified source removal.
// Synthetic test roots only. Recycle Bin only — never permanent
// deletion, never fs.unlink / Remove-Item fallback.
// =========================================================


import crypto, { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { appendActivity } from "../activity.js";
import {
    assertInsideLiveSyntheticRoot,
    isPathInsideSyntheticReclaimRoot,
} from "../synthetic-reclaim-roots.js";
import {
    findGrantForPath,
    getActiveSession,
    getSessionById,
    getSessionReclaimJob,
    runWithSession,
    storeSessionReclaimJob,
} from "../storage-session.js";
import {
    RECLAIM_ELIGIBLE,
    assessManifestTrust,
    _test as reclaimTest,
} from "./storage-reclaim.js";
import {
    loadTransferJournal,
    refreshAndMatchDestination,
} from "./storage-transfer.js";
import {
    assertHelperProvenance,
    assertRecycleCapableVolume,
    disableFurtherRemovals,
    getRemovalDisabledReason,
    proveRecycleOnlyForRoot,
    recycleFile,
    restoreRecycledFile,
} from "./windows-recycle.js";


export const REMOVAL_SCOPE = "synthetic_only";

const REMOVAL_JOURNAL_DIR = path.join(
    process.cwd(),
    "data",
    "removal-journal",
);

/** @type {Map<string, object>} */
const reclaimManifests = new Map();
/** @type {Map<string, object>} */
const liveRemovalJobs = new Map();
/** @type {Set<string>} */
const consumedApprovals = new Set();
/** @type {Set<string>} */
const inFlightEntryKeys = new Set();

let removalBootstrapped = false;


function removalError(message, code, status = 400) {
    return Object.assign(new Error(message), { code, status });
}


function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function rejectUnknownKeys(args, allowed) {
    const extra = Object.keys(args).filter((key) => !allowed.includes(key));
    if (extra.length > 0) {
        throw new Error(`Unexpected argument(s): ${extra.join(", ")}.`);
    }
}


function requireString(args, field, maxLength = 4096) {
    const value = args[field];
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`"${field}" must be a non-empty string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw new Error(`"${field}" is too long.`);
    }
    return trimmed;
}


function entryKey(transferId, entryId) {
    return `${transferId}::${entryId}`;
}


function canonicalReclaimManifestPayload(manifest) {
    return {
        reclaimJobId: manifest.reclaimJobId,
        transferId: manifest.transferId,
        sessionId: manifest.sessionId,
        disposal: "recycle_bin",
        scope: REMOVAL_SCOPE,
        entries: [...manifest.entries]
            .map((entry) => ({
                entryId: entry.entryId,
                sourcePath: entry.sourcePath,
                destinationPath: entry.destinationPath,
                sizeBytes: entry.sizeBytes,
                eligibility: entry.eligibility,
            }))
            .sort((a, b) => a.entryId.localeCompare(b.entryId)),
    };
}


export function recomputeReclaimManifestHash(manifest) {
    if (!manifest || !Array.isArray(manifest.entries)) {
        return null;
    }
    return createHash("sha256")
        .update(JSON.stringify(canonicalReclaimManifestPayload(manifest)))
        .digest("hex");
}


export function getSessionReclaimManifest(
    manifestId,
    session = getActiveSession(),
) {
    if (!session || typeof manifestId !== "string") {
        return null;
    }
    const manifest = reclaimManifests.get(manifestId) ?? null;
    if (!manifest || manifest.sessionId !== session.id) {
        return null;
    }
    return manifest;
}


export function listSessionReclaimManifests(session = getActiveSession()) {
    if (!session) {
        return [];
    }
    return [...reclaimManifests.values()].filter(
        (manifest) => manifest.sessionId === session.id,
    );
}


export function getPublicReclaimManifest(manifestId, session = getActiveSession()) {
    return publicReclaimManifest(getSessionReclaimManifest(manifestId, session));
}


export function listPublicReclaimManifests(session = getActiveSession()) {
    return listSessionReclaimManifests(session).map(publicReclaimManifest);
}


function publicReclaimManifest(manifest) {
    if (!manifest) {
        return null;
    }
    return {
        reclaimManifestId: manifest.id,
        hash: manifest.hash,
        reclaimJobId: manifest.reclaimJobId,
        transferId: manifest.transferId,
        entryCount: manifest.entries.length,
        logicalBytesSelected: manifest.logicalBytesSelected,
        disposal: "recycle_bin",
        scope: REMOVAL_SCOPE,
        invalidated: manifest.invalidated === true,
        invalidReason: manifest.invalidReason,
        consumed: manifest.consumed === true,
        entries: manifest.entries.map((entry) => ({
            entryId: entry.entryId,
            sourcePath: entry.sourcePath,
            destinationPath: entry.destinationPath,
            sizeBytes: entry.sizeBytes,
            eligibility: entry.eligibility,
        })),
        warnings: manifest.warnings,
        createdAt: manifest.createdAt,
        message:
            "Locked reclaim selection. Approval is required before any Recycle Bin operation. " +
            "Synthetic test roots only. Permanent deletion is unavailable.",
    };
}


/**
 * Lock exact eligible entry IDs from a finished reclaim job.
 * Never auto-selects all eligible files.
 */
export function lockReclaimSelection(reclaimJobId, entryIds) {
    const session = getActiveSession();
    if (!session) {
        throw removalError("No storage scan session is active.", "NO_SESSION", 401);
    }

    if (typeof reclaimJobId !== "string" || !reclaimJobId.trim()) {
        throw removalError("reclaimJobId is required.", "BAD_ARGS", 400);
    }
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
        throw removalError(
            "Select at least one eligible file. Nothing is selected by default.",
            "EMPTY_SELECTION",
            400,
        );
    }

    const job = getSessionReclaimJob(reclaimJobId.trim(), session);
    if (!job || job.sessionId !== session.id) {
        throw removalError("Unknown reclaim job.", "UNKNOWN_RECLAIM_JOB", 404);
    }
    if (
        job.status !== "completed" &&
        job.status !== "incomplete"
    ) {
        throw removalError(
            "Reclaim verification must finish before locking a removal selection.",
            "RECLAIM_NOT_READY",
            409,
        );
    }

    const disabled = getRemovalDisabledReason();
    if (disabled) {
        throw removalError(disabled, "REMOVAL_DISABLED", 409);
    }

    const byId = new Map(
        (job.candidates ?? []).map((candidate) => [candidate.entryId, candidate]),
    );
    const seen = new Set();
    const selected = [];

    for (const id of entryIds) {
        if (typeof id !== "string" || !id.trim()) {
            throw removalError("Invalid entry id.", "BAD_ENTRY", 400);
        }
        const trimmed = id.trim();
        if (seen.has(trimmed)) {
            throw removalError("Duplicate entry ids are not allowed.", "DUP_ENTRY", 400);
        }
        seen.add(trimmed);
        const candidate = byId.get(trimmed);
        if (!candidate) {
            throw removalError(
                `Unknown entry id for this reclaim job: ${trimmed}`,
                "UNKNOWN_ENTRY",
                400,
            );
        }
        if (candidate.eligibility !== RECLAIM_ELIGIBLE) {
            throw removalError(
                `Entry ${trimmed} is not eligible_for_review and cannot be selected for removal.`,
                "NOT_ELIGIBLE",
                400,
            );
        }
        if (!isPathInsideSyntheticReclaimRoot(candidate.sourcePath)) {
            throw removalError(
                "Selected source is outside registered synthetic reclaim test roots.",
                "NOT_SYNTHETIC_ROOT",
                403,
            );
        }
        selected.push({
            entryId: candidate.entryId,
            sourcePath: candidate.sourcePath,
            destinationPath: candidate.destinationPath,
            sizeBytes: candidate.sizeBytes,
            eligibility: candidate.eligibility,
        });
    }

    const logicalBytesSelected = selected.reduce(
        (sum, entry) => sum + (entry.sizeBytes ?? 0),
        0,
    );

    const manifest = {
        id: crypto.randomUUID(),
        reclaimJobId: job.id,
        transferId: job.transferId,
        sessionId: session.id,
        createdAt: new Date().toISOString(),
        disposal: "recycle_bin",
        scope: REMOVAL_SCOPE,
        entries: selected,
        logicalBytesSelected,
        invalidated: false,
        invalidReason: null,
        consumed: false,
        warnings: [
            "Removing originals sends them to the Recycle Bin when recycling can be proven.",
            "External verified copies are preserved.",
            "Synthetic test roots only — real user files cannot be removed in this milestone.",
            "A successful recycle does not guarantee additional free disk space.",
            "TOCTOU: a replacement race between final checks and the native helper remains a residual risk; real-user removal stays disabled.",
        ],
    };
    manifest.hash = recomputeReclaimManifestHash(manifest);
    reclaimManifests.set(manifest.id, manifest);

    if (!session.reclaimManifests) {
        session.reclaimManifests = new Map();
    }
    session.reclaimManifests.set(manifest.id, manifest);

    return publicReclaimManifest(manifest);
}


export function validateRequestReclaimRemoval(args) {
    if (!isPlainObject(args)) {
        throw new Error("Arguments must be an object.");
    }
    rejectUnknownKeys(args, ["reclaimManifestId", "reason"]);
    const reclaimManifestId = requireString(args, "reclaimManifestId", 64);
    if (!/^[0-9a-f-]{36}$/i.test(reclaimManifestId)) {
        throw new Error('"reclaimManifestId" must be a UUID.');
    }
    const reason = requireString(args, "reason", 500);
    return { reclaimManifestId, reason };
}


export async function precheckReclaimRemoval(args) {
    const validated = validateRequestReclaimRemoval(args);
    const session = getActiveSession();
    if (!session) {
        throw removalError("No storage scan session is active.", "NO_SESSION", 401);
    }

    const disabled = getRemovalDisabledReason();
    if (disabled) {
        throw removalError(disabled, "REMOVAL_DISABLED", 409);
    }

    try {
        await assertHelperProvenance();
    } catch (error) {
        throw removalError(
            error.message,
            error.code ?? "HELPER_NOT_READY",
            error.status ?? 503,
        );
    }

    const manifest = getSessionReclaimManifest(validated.reclaimManifestId, session);
    if (!manifest || manifest.invalidated) {
        throw removalError(
            "Unknown or invalidated reclaim manifest.",
            "UNKNOWN_RECLAIM_MANIFEST",
            404,
        );
    }
    if (manifest.consumed) {
        throw removalError(
            "That reclaim manifest was already consumed.",
            "MANIFEST_CONSUMED",
            409,
        );
    }

    const hash = recomputeReclaimManifestHash(manifest);
    if (!hash || hash !== manifest.hash) {
        throw removalError(
            "Reclaim manifest integrity check failed.",
            "MANIFEST_TAMPERED",
            409,
        );
    }

    for (const entry of manifest.entries) {
        const key = entryKey(manifest.transferId, entry.entryId);
        if (inFlightEntryKeys.has(key)) {
            throw removalError(
                "A removal job is already in progress for one of the selected entries.",
                "REMOVAL_IN_PROGRESS",
                409,
            );
        }
        const synthetic = await assertInsideLiveSyntheticRoot(entry.sourcePath);
        const grant = findGrantForPath(entry.sourcePath);
        if (!grant) {
            throw removalError(
                "A selected source is not covered by a current scan grant.",
                "GRANT_MISSING",
                409,
            );
        }
        await assertRecycleCapableVolume(entry.sourcePath);
        const proven = await proveRecycleOnlyForRoot(synthetic.match.realPath);
        if (!proven.ok) {
            throw removalError(
                proven.detail ||
                    "Recycle-only behavior could not be established for this synthetic root.",
                "RECYCLE_NOT_PROVEN",
                409,
            );
        }
    }

    const journal = await loadTransferJournal(manifest.transferId);
    if (!journal) {
        throw removalError("Transfer journal not found.", "UNKNOWN_TRANSFER", 404);
    }
    const trust = assessManifestTrust(journal, session);
    if (!trust.canBeRemovalEligible || trust.integrityFailed) {
        throw removalError(
            "Transfer provenance is insufficient for removal.",
            "PROVENANCE_INSUFFICIENT",
            409,
        );
    }

    return {
        validated,
        manifest,
        preview: {
            reclaimManifestId: manifest.id,
            manifestHash: manifest.hash,
            transferId: manifest.transferId,
            entryCount: manifest.entries.length,
            logicalBytesSelected: manifest.logicalBytesSelected,
            disposal: "recycle_bin",
            scope: REMOVAL_SCOPE,
            permanentDelete: false,
            originalsWillBeRemoved: true,
            warning:
                "Approved originals will be moved to the Recycle Bin only if recycling can be proven. " +
                "Permanent deletion is unavailable. External copies remain. Synthetic test roots only.",
            entries: manifest.entries.map((entry) => ({
                entryId: entry.entryId,
                sourcePath: entry.sourcePath,
                destinationPath: entry.destinationPath,
                sizeBytes: entry.sizeBytes,
            })),
        },
    };
}


async function persistRemovalJournal(job) {
    await fs.mkdir(REMOVAL_JOURNAL_DIR, { recursive: true });
    const target = path.join(REMOVAL_JOURNAL_DIR, `${job.id}.json`);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const record = {
        removalId: job.id,
        sessionId: job.sessionId,
        reclaimManifestId: job.reclaimManifestId,
        reclaimManifestHash: job.reclaimManifestHash,
        transferId: job.transferId,
        status: job.status,
        scope: REMOVAL_SCOPE,
        metrics: job.metrics,
        files: job.files,
        failureCode: job.failureCode,
        failureMessage: job.failureMessage,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
    };
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
}


async function measureFreeBytes(filePath) {
    try {
        const { spawnSync } = await import("node:child_process");
        const root = path.parse(path.resolve(filePath)).root;
        const ps = spawnSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-PSDrive -Name '${root[0]}').Free`,
            ],
            { encoding: "utf8", windowsHide: true, shell: false },
        );
        const value = Number.parseInt(String(ps.stdout || "").trim(), 10);
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}


async function revalidateEntryForRemoval(job, entry) {
    const session = getSessionById(job.sessionId);
    if (!session || session.ended) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: "Session expired.",
            code: "SESSION_EXPIRED",
        };
    }

    if (job.cancelRequested) {
        return {
            entryId: entry.entryId,
            outcome: "aborted",
            detail: "Removal cancelled.",
            code: "CANCELLED",
        };
    }

    if (getRemovalDisabledReason()) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: getRemovalDisabledReason(),
            code: "REMOVAL_DISABLED",
        };
    }

    const grant = findGrantForPath(entry.sourcePath);
    if (!grant) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: "Scan grant missing.",
            code: "GRANT_MISSING",
        };
    }

    try {
        await assertInsideLiveSyntheticRoot(entry.sourcePath);
        await assertRecycleCapableVolume(entry.sourcePath);
    } catch (error) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: error.message,
            code: error.code ?? "PRECHECK_FAILED",
        };
    }

    // Fresh D1-style verification using reclaim verifyOneFile against journal.
    const journal = await loadTransferJournal(job.transferId);
    if (!journal) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: "Journal missing.",
            code: "UNKNOWN_TRANSFER",
        };
    }

    const trust = assessManifestTrust(journal, session);
    if (!trust.canBeRemovalEligible || trust.integrityFailed) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: "Insufficient provenance for removal.",
            code: "PROVENANCE_INSUFFICIENT",
        };
    }

    const file = (journal.files ?? []).find((item) => item.entryId === entry.entryId);
    if (!file || file.state !== "verified") {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: "Journal entry is not verified.",
            code: "NOT_VERIFIED",
        };
    }

    if (!file.sourceIdentity) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail:
                "Original source identity metadata is missing; refusing removal under TOCTOU policy.",
            code: "IDENTITY_UNKNOWN",
        };
    }

    try {
        await refreshAndMatchDestination(
            trust.snapshot?.destination ?? journal.destination,
        );
    } catch (error) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: error.message,
            code: error.code ?? "DRIVE_GONE",
        };
    }

    const verifyJob = {
        sessionId: job.sessionId,
        journalDestination: journal.destination,
        cancelRequested: false,
    };
    const candidate = await reclaimTest.verifyOneFile(verifyJob, file, trust);
    if (candidate.eligibility !== RECLAIM_ELIGIBLE) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail:
                candidate.reasons.join(" ") ||
                `Revalidation classified as ${candidate.eligibility}.`,
            code: "REVALIDATION_FAILED",
            candidate,
        };
    }

    // Final identity snapshot for the native helper.
    const lstat = await fs.lstat(entry.sourcePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
        return {
            entryId: entry.entryId,
            outcome: "failed",
            detail: "Source is not a regular file at final check.",
            code: "UNSAFE_TYPE",
        };
    }

    return {
        entryId: entry.entryId,
        outcome: "ready",
        identity: {
            sizeBytes: lstat.size,
            mtimeMs: lstat.mtimeMs,
            ino: lstat.ino,
            dev: lstat.dev,
        },
        sourcePath: entry.sourcePath,
        destinationPath: entry.destinationPath,
        sizeBytes: entry.sizeBytes,
    };
}


async function runRemovalJob(job) {
    const session = getSessionById(job.sessionId);
    if (!session) {
        job.status = "failed";
        job.failureCode = "SESSION_EXPIRED";
        job.failureMessage = "Storage session expired.";
        job.finishedAt = new Date().toISOString();
        await persistRemovalJournal(job);
        return;
    }

    await runWithSession(session, async () => {
        job.status = "running";
        const freeBefore = await measureFreeBytes(job.files[0]?.sourcePath);
        job.metrics.freeBytesBefore = freeBefore;

        for (const file of job.files) {
            if (job.cancelRequested) {
                file.outcome = "aborted";
                file.detail = "Removal cancelled.";
                job.metrics.filesAborted += 1;
                continue;
            }

            const key = entryKey(job.transferId, file.entryId);
            inFlightEntryKeys.add(key);

            try {
                const ready = await revalidateEntryForRemoval(job, file);
                if (ready.outcome !== "ready") {
                    file.outcome = ready.outcome;
                    file.detail = ready.detail;
                    file.code = ready.code;
                    if (ready.outcome === "indeterminate") {
                        job.metrics.filesIndeterminate += 1;
                    } else if (ready.outcome === "aborted") {
                        job.metrics.filesAborted += 1;
                    } else {
                        job.metrics.filesFailed += 1;
                    }
                    continue;
                }

                const helperResult = await recycleFile(ready.sourcePath, ready.identity);
                file.helper = {
                    outcome: helperResult.outcome,
                    recycled: helperResult.recycled === true,
                    permanentlyRemoved: helperResult.permanentlyRemoved === true,
                    aborted: helperResult.aborted === true,
                    detail: helperResult.detail,
                    recyclePath: helperResult.recyclePath,
                };

                if (helperResult.permanentlyRemoved) {
                    file.outcome = "permanently_removed";
                    file.detail = helperResult.detail;
                    job.metrics.filesPermanentlyRemoved += 1;
                    job.criticalFailure = true;
                    job.failureCode = "PERMANENT_DELETE_EVIDENCE";
                    job.failureMessage = helperResult.detail;
                    disableFurtherRemovals(helperResult.detail);
                    break;
                }

                if (helperResult.recycled === true && helperResult.outcome === "recycled") {
                    // Confirm source gone; destination intact.
                    let sourceGone = false;
                    try {
                        await fs.lstat(ready.sourcePath);
                    } catch (error) {
                        sourceGone = error.code === "ENOENT";
                    }
                    let destOk = false;
                    try {
                        const destStat = await fs.lstat(ready.destinationPath);
                        destOk = destStat.isFile();
                    } catch {
                        destOk = false;
                    }

                    if (!sourceGone) {
                        file.outcome = "indeterminate";
                        file.detail =
                            "Helper reported recycled but source still exists.";
                        job.metrics.filesIndeterminate += 1;
                    } else if (!destOk) {
                        file.outcome = "indeterminate";
                        file.detail =
                            "Source recycled but external verified copy is missing.";
                        job.metrics.filesIndeterminate += 1;
                    } else {
                        file.outcome = "recycled";
                        file.detail = "Recycled with PostDeleteItem evidence.";
                        file.recyclePath = helperResult.recyclePath;
                        job.metrics.filesRecycled += 1;
                        job.metrics.logicalBytesRecycled += file.sizeBytes ?? 0;
                        job.metrics.filesRemovedFromSource += 1;
                    }
                } else if (helperResult.aborted || helperResult.outcome === "aborted") {
                    file.outcome = "aborted";
                    file.detail = helperResult.detail;
                    job.metrics.filesAborted += 1;
                } else if (helperResult.outcome === "indeterminate") {
                    file.outcome = "indeterminate";
                    file.detail = helperResult.detail;
                    job.metrics.filesIndeterminate += 1;
                } else {
                    file.outcome = "failed";
                    file.detail = helperResult.detail || "Recycle failed.";
                    job.metrics.filesFailed += 1;
                }
            } finally {
                inFlightEntryKeys.delete(key);
            }

            await persistRemovalJournal(job);
        }

        const freeAfter = await measureFreeBytes(job.files[0]?.sourcePath);
        job.metrics.freeBytesAfter = freeAfter;
        job.metrics.freeBytesDelta =
            freeBefore != null && freeAfter != null ? freeAfter - freeBefore : null;
        job.metrics.notes = [
            "freeBytesDelta is an observed snapshot, not proof this job alone caused the change.",
            "A successful recycle does not guarantee additional free disk space.",
            "filesPermanentlyRemoved must remain 0; any positive value is a critical failure.",
        ];

        if (job.criticalFailure) {
            job.status = "failed";
        } else if (job.cancelRequested) {
            job.status = "cancelled";
        } else {
            job.status = "completed";
        }
        job.finishedAt = new Date().toISOString();
        await persistRemovalJournal(job);
    });

    liveRemovalJobs.delete(job.id);

    try {
        await appendActivity({
            type: "storage_reclaim_removal",
            tool: "request_reclaim_removal",
            status: job.status,
            summary: `Removal job ${job.status} for transfer ${job.transferId}`,
            details: {
                removalId: job.id,
                metrics: job.metrics,
                criticalFailure: job.criticalFailure === true,
            },
        });
    } catch {
        // ignore
    }
}


export async function executeRequestReclaimRemoval(args) {
    const { validated, manifest } = await precheckReclaimRemoval(args);
    const session = getActiveSession();

    // Consume manifest atomically (single-use).
    if (manifest.consumed || manifest.invalidated) {
        throw removalError("Reclaim manifest is no longer usable.", "MANIFEST_CONSUMED", 409);
    }
    manifest.consumed = true;
    manifest.consumedAt = new Date().toISOString();

    for (const entry of manifest.entries) {
        const key = entryKey(manifest.transferId, entry.entryId);
        if (inFlightEntryKeys.has(key)) {
            throw removalError(
                "Removal already in progress for a selected entry.",
                "REMOVAL_IN_PROGRESS",
                409,
            );
        }
    }

    const job = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        reclaimManifestId: manifest.id,
        reclaimManifestHash: manifest.hash,
        transferId: manifest.transferId,
        status: "starting",
        cancelRequested: false,
        criticalFailure: false,
        failureCode: null,
        failureMessage: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        files: manifest.entries.map((entry) => ({
            entryId: entry.entryId,
            sourcePath: entry.sourcePath,
            destinationPath: entry.destinationPath,
            sizeBytes: entry.sizeBytes,
            outcome: "pending",
            detail: null,
            recyclePath: null,
            helper: null,
        })),
        metrics: {
            filesSelected: manifest.entries.length,
            logicalBytesSelected: manifest.logicalBytesSelected,
            filesRecycled: 0,
            filesFailed: 0,
            filesIndeterminate: 0,
            filesAborted: 0,
            filesPermanentlyRemoved: 0,
            filesRemovedFromSource: 0,
            logicalBytesRecycled: 0,
            freeBytesBefore: null,
            freeBytesAfter: null,
            freeBytesDelta: null,
            notes: [],
        },
        message:
            "Starting synthetic-only Recycle Bin removal. Permanent deletion is unavailable.",
    };

    await persistRemovalJournal(job);
    liveRemovalJobs.set(job.id, job);
    if (!session.removalJobs) {
        session.removalJobs = new Map();
    }
    session.removalJobs.set(job.id, job);

    setImmediate(() => {
        runRemovalJob(job).catch(async (error) => {
            job.status = "failed";
            job.failureCode = error.code ?? "IO_ERROR";
            job.failureMessage = error.message;
            job.finishedAt = new Date().toISOString();
            try {
                await persistRemovalJournal(job);
            } catch {
                // ignore
            }
            liveRemovalJobs.delete(job.id);
        });
    });

    return {
        untrusted: true,
        tool: "request_reclaim_removal",
        removalId: job.id,
        status: "running",
        scope: REMOVAL_SCOPE,
        transferId: job.transferId,
        entryCount: job.files.length,
        logicalBytesSelected: job.metrics.logicalBytesSelected,
        message: job.message,
        interpretationLimits: [
            "Synthetic test roots only.",
            "recycled requires PostDeleteItem evidence with a Recycle Bin item.",
            "Permanent deletion is unavailable; evidence of permanent deletion disables further removals.",
            "Free-space deltas are observed snapshots only.",
        ],
    };
}


export function getPublicRemovalJob(removalId, session = getActiveSession()) {
    if (!session?.removalJobs || typeof removalId !== "string") {
        return null;
    }
    const job = session.removalJobs.get(removalId);
    if (!job || job.sessionId !== session.id) {
        return null;
    }
    return {
        removalId: job.id,
        status: job.status,
        transferId: job.transferId,
        reclaimManifestId: job.reclaimManifestId,
        scope: REMOVAL_SCOPE,
        metrics: job.metrics,
        files: job.files.map((file) => ({
            entryId: file.entryId,
            sourcePath: file.sourcePath,
            destinationPath: file.destinationPath,
            sizeBytes: file.sizeBytes,
            outcome: file.outcome,
            detail: file.detail,
            recyclePath: file.recyclePath,
        })),
        failureCode: job.failureCode,
        failureMessage: job.failureMessage,
        criticalFailure: job.criticalFailure === true,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        message: job.message,
    };
}


export function requestCancelRemovalJob(removalId, session = getActiveSession()) {
    const job = session?.removalJobs?.get(removalId);
    if (!job || job.sessionId !== session.id) {
        throw removalError("Unknown removal job.", "UNKNOWN_REMOVAL", 404);
    }
    if (job.status === "starting" || job.status === "running") {
        job.cancelRequested = true;
        const live = liveRemovalJobs.get(job.id);
        if (live) {
            live.cancelRequested = true;
        }
        job.status = "cancelling";
    }
    return getPublicRemovalJob(removalId, session);
}


export function invalidateReclaimManifestsForSession(session) {
    for (const manifest of reclaimManifests.values()) {
        if (manifest.sessionId === session?.id) {
            manifest.invalidated = true;
            manifest.invalidReason = "Storage session ended.";
        }
    }
}


export function markApprovalConsumed(approvalId) {
    if (typeof approvalId === "string") {
        consumedApprovals.add(approvalId);
    }
}


export function wasApprovalConsumed(approvalId) {
    return consumedApprovals.has(approvalId);
}


function journalImpliesPermanentDeletion(record) {
    if (!record || typeof record !== "object") {
        return false;
    }
    if ((record.metrics?.filesPermanentlyRemoved ?? 0) > 0) {
        return true;
    }
    if (record.criticalFailure) {
        return true;
    }
    for (const file of record.files ?? []) {
        if (file?.outcome === "permanently_removed" || file?.permanentlyRemoved) {
            return true;
        }
        const detail = String(file?.detail || file?.helper?.detail || "").toLowerCase();
        if (
            detail.includes("psinewlycreated") &&
            (detail.includes("null") || detail.includes("fully deleted"))
        ) {
            return true;
        }
    }
    return false;
}


async function recoverRemovalJournalsOnBootstrap() {
    let entries;
    try {
        entries = await fs.readdir(REMOVAL_JOURNAL_DIR);
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }

    for (const name of entries) {
        if (!name.endsWith(".json")) {
            continue;
        }
        let record;
        try {
            const raw = await fs.readFile(
                path.join(REMOVAL_JOURNAL_DIR, name),
                "utf8",
            );
            record = JSON.parse(raw);
        } catch {
            continue;
        }

        if (journalImpliesPermanentDeletion(record)) {
            disableFurtherRemovals(
                "Historical removal journal contains permanent-deletion evidence; further removals disabled.",
            );
        }

        const status = String(record.status || "");
        if (
            status === "running" ||
            status === "starting" ||
            status === "cancelling"
        ) {
            record.status = "interrupted";
            record.finishedAt = record.finishedAt || new Date().toISOString();
            record.message =
                "Removal job was interrupted; automatic resume is not available.";
            try {
                await fs.writeFile(
                    path.join(REMOVAL_JOURNAL_DIR, name),
                    `${JSON.stringify(record, null, 2)}\n`,
                    "utf8",
                );
            } catch {
                // best-effort journal recovery
            }
        }
    }
}


export async function bootstrapRemovalRuntime() {
    if (removalBootstrapped) {
        return;
    }
    removalBootstrapped = true;
    await recoverRemovalJournalsOnBootstrap();
}


/** Test helpers */
export const _test = {
    reclaimManifests,
    liveRemovalJobs,
    inFlightEntryKeys,
    consumedApprovals,
    revalidateEntryForRemoval,
    persistRemovalJournal,
    REMOVAL_JOURNAL_DIR,
    restoreRecycledFile,
};
