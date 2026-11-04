// =========================================================
// lib/tools/storage-reclaim.js
//
// Milestone D1: read-only reclaim candidate analysis.
// Never deletes, recycles, modifies sources, or hydrates cloud
// placeholders. Resolves files only from transfer journals.
// =========================================================


import crypto, { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { appendActivity } from "../activity.js";
import {
    getActiveSession,
    findGrantForPath,
    getGrantRoots,
    getSessionById,
    getSessionManifest,
    getSessionReclaimJob,
    getSessionTransfer,
    listSessionReclaimJobs,
    runWithSession,
    setReclaimSessionHooks,
    storeSessionReclaimJob,
} from "../storage-session.js";
import {
    JOURNAL_SCHEMA_VERSION,
    JOURNAL_SCHEMA_VERSION_LEGACY,
} from "../transfer-journal.js";
import { isPathInsideSyntheticReclaimRoot } from "../synthetic-reclaim-roots.js";
import {
    assertPathHasNoSymlinkComponents,
    isPathInsideRoot,
    resolveExistingPath,
} from "./path-safety.js";
import {
    recomputeManifestHash,
} from "./storage-offload.js";
import { describeProtectedReason } from "./storage.js";
import {
    classifySourcePlaceholder,
    loadTransferJournal,
    looksLikeCloudPath,
    offloadRootFor,
    refreshAndMatchDestination,
} from "./storage-transfer.js";


export const RECLAIM_ELIGIBLE = "eligible_for_review";
export const RECLAIM_MANUAL = "requires_manual_review";
export const RECLAIM_EXCLUDED = "excluded";
export const RECLAIM_FAILED = "verification_failed";

export const DEFAULT_RECLAIM_MAX_MS = 120_000;
export const MAX_RECLAIM_MAX_MS = 600_000;
export const HASH_BUFFER_BYTES = 64 * 1024;

const DEV_PROJECT_MARKERS = Object.freeze([
    ".git",
    "package.json",
    "node_modules",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "CMakeLists.txt",
]);

const SENSITIVE_BASENAMES = new Set([
    ".env",
    ".pem",
    ".key",
    "id_rsa",
    "id_ed25519",
    "credentials.json",
    "secrets.json",
]);

/** @type {Map<string, object>} */
const liveReclaimJobs = new Map();

let reclaimBootstrapped = false;


function reclaimError(message, code, status = 400) {
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


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


function emptyIntegrity(status = "not_checked", reason = null) {
    return { status, reason };
}


function publicCandidate(candidate) {
    const syntheticRemovalAuthorized = Boolean(
        isPathInsideSyntheticReclaimRoot(candidate.sourcePath),
    );
    return {
        entryId: candidate.entryId,
        sourcePath: candidate.sourcePath,
        destinationPath: candidate.destinationPath,
        sizeBytes: candidate.sizeBytes,
        eligibility: candidate.eligibility,
        copyIntegrity: candidate.copyIntegrity,
        sourceIntegrity: candidate.sourceIntegrity,
        destinationIntegrity: candidate.destinationIntegrity,
        sourceAuthorization: candidate.sourceAuthorization,
        dependencyConfidence: candidate.dependencyConfidence,
        cloudReparseSafety: candidate.cloudReparseSafety,
        reasons: candidate.reasons,
        manualReviewNeeds: candidate.manualReviewNeeds,
        warnings: candidate.warnings,
        estimatedRecoverableLogicalBytes:
            candidate.estimatedRecoverableLogicalBytes,
        estimatedRecoverablePhysicalBytes:
            candidate.estimatedRecoverablePhysicalBytes,
        estimateConfidence: candidate.estimateConfidence,
        journalState: candidate.journalState,
        // Hashes intentionally omitted from public/API/tool surfaces.
        sourceHashVerified: candidate.sourceHashVerified,
        destinationHashVerified: candidate.destinationHashVerified,
        // Automated Recycle Bin is synthetic-root only; UI must gate on this.
        syntheticRemovalAuthorized,
        lastVerifiedAt: candidate.lastVerifiedAt ?? null,
    };
}


function publicReclaimJob(job) {
    return {
        jobId: job.id,
        transferId: job.transferId,
        status: job.status,
        transferStatus: job.transferStatus,
        transferComplete: job.transferComplete,
        schemaVersion: job.schemaVersion,
        manifestTrust: job.manifestTrust,
        trustLimitations: job.trustLimitations,
        entryCount: job.entryCount,
        processedFiles: job.processedFiles,
        currentFile: job.currentFile,
        currentEntryId: job.currentEntryId,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        failureCode: job.failureCode,
        failureMessage: job.failureMessage,
        cancelRequested: job.cancelRequested === true,
        progress: {
            completed: job.processedFiles,
            total: job.entryCount,
            percent:
                job.entryCount > 0
                    ? Math.round((job.processedFiles / job.entryCount) * 100)
                    : 100,
        },
        estimates: job.estimates,
        counts: job.counts,
        message: job.message,
        interpretationLimits: job.interpretationLimits,
        candidates: (job.candidates ?? []).map(publicCandidate),
        bytesActuallyReclaimed: 0,
    };
}


function toolCompactSummary(job) {
    return {
        untrusted: true,
        tool: "inspect_reclaim_candidates",
        jobId: job.id,
        transferId: job.transferId,
        status: job.status,
        transferStatus: job.transferStatus,
        transferComplete: job.transferComplete,
        manifestTrust: job.manifestTrust,
        counts: job.counts,
        estimates: {
            ...job.estimates,
            bytesActuallyReclaimed: 0,
        },
        eligibleEntryIds: (job.candidates ?? [])
            .filter((c) => c.eligibility === RECLAIM_ELIGIBLE)
            .map((c) => c.entryId),
        manualReviewEntryIds: (job.candidates ?? [])
            .filter((c) => c.eligibility === RECLAIM_MANUAL)
            .map((c) => c.entryId),
        excludedEntryIds: (job.candidates ?? [])
            .filter((c) => c.eligibility === RECLAIM_EXCLUDED)
            .map((c) => c.entryId),
        failedEntryIds: (job.candidates ?? [])
            .filter((c) => c.eligibility === RECLAIM_FAILED)
            .map((c) => c.entryId),
        message: job.message,
        interpretationLimits: job.interpretationLimits,
        // Omit per-file paths/hashes from model context; UI uses the job API.
    };
}


export function validateInspectReclaimCandidates(args) {
    if (!isPlainObject(args)) {
        throw new Error("Arguments must be an object.");
    }
    rejectUnknownKeys(args, ["transferId", "entryIds", "maxMs"]);
    const transferId = requireString(args, "transferId", 64);
    if (!/^[0-9a-f-]{36}$/i.test(transferId)) {
        throw new Error('"transferId" must be a UUID.');
    }

    let entryIds = null;
    if (args.entryIds !== undefined) {
        if (!Array.isArray(args.entryIds)) {
            throw new Error('"entryIds" must be an array of strings.');
        }
        const seen = new Set();
        entryIds = [];
        for (const id of args.entryIds) {
            if (typeof id !== "string" || !id.trim()) {
                throw new Error("Invalid entry id.");
            }
            const trimmed = id.trim();
            if (seen.has(trimmed)) {
                throw new Error("Duplicate entry ids are not allowed.");
            }
            seen.add(trimmed);
            entryIds.push(trimmed);
        }
    }

    let maxMs = DEFAULT_RECLAIM_MAX_MS;
    if (args.maxMs !== undefined) {
        if (
            !Number.isInteger(args.maxMs) ||
            args.maxMs < 1_000 ||
            args.maxMs > MAX_RECLAIM_MAX_MS
        ) {
            throw new Error(
                `"maxMs" must be an integer between 1000 and ${MAX_RECLAIM_MAX_MS}.`,
            );
        }
        maxMs = args.maxMs;
    }

    return { transferId, entryIds, maxMs };
}


/**
 * Assess journal + snapshot trust. Never fabricates snapshots.
 */
export function assessManifestTrust(journal, session) {
    const trustLimitations = [];
    const schemaVersion =
        journal.schemaVersion ?? JOURNAL_SCHEMA_VERSION_LEGACY;

    if (!journal.hasManifestSnapshot) {
        trustLimitations.push(
            "Legacy journal has no frozen manifestSnapshot. " +
                "An unkeyed hash beside editable journal data is not treated as proof of authenticity.",
        );
        return {
            schemaVersion,
            manifestTrust: "legacy_untrusted_manifest",
            trustLimitations,
            snapshot: null,
            canBeRemovalEligible: false,
            canInspect: true,
        };
    }

    const snapshot = journal.manifestSnapshot;
    const recomputed = recomputeManifestHash({
        planId: snapshot.planId,
        complete: snapshot.complete,
        incomplete: snapshot.incomplete,
        destination: snapshot.destination,
        entries: snapshot.entries,
    });

    if (!recomputed || recomputed !== journal.manifestHash) {
        return {
            schemaVersion,
            manifestTrust: "snapshot_hash_mismatch",
            trustLimitations: [
                "Frozen manifestSnapshot does not recompute to journal.manifestHash.",
            ],
            snapshot,
            canBeRemovalEligible: false,
            canInspect: true,
            integrityFailed: true,
        };
    }

    if (snapshot.hash && snapshot.hash !== journal.manifestHash) {
        return {
            schemaVersion,
            manifestTrust: "snapshot_internal_hash_mismatch",
            trustLimitations: [
                "manifestSnapshot.hash does not match journal.manifestHash.",
            ],
            snapshot,
            canBeRemovalEligible: false,
            canInspect: true,
            integrityFailed: true,
        };
    }

    const sessionManifest = session
        ? getSessionManifest(journal.manifestId)
        : null;
    const sessionTransfer = session
        ? getSessionTransfer(journal.transferId)
        : null;

    let manifestTrust = "journal_snapshot_only";
    let canBeRemovalEligible = false;

    if (
        sessionManifest &&
        sessionManifest.hash === journal.manifestHash &&
        !sessionManifest.invalidated
    ) {
        const liveHash = recomputeManifestHash(sessionManifest);
        if (liveHash === journal.manifestHash) {
            manifestTrust = "session_manifest_and_snapshot";
            canBeRemovalEligible = true;
        } else {
            trustLimitations.push(
                "Session manifest failed live hash recompute; falling back to snapshot trust limits.",
            );
        }
    } else if (
        sessionTransfer &&
        sessionTransfer.manifestHash === journal.manifestHash &&
        sessionTransfer.sessionId === session?.id
    ) {
        manifestTrust = "session_transfer_provenance";
        canBeRemovalEligible = true;
        trustLimitations.push(
            "Trusted via same-session transfer provenance plus recomputed snapshot hash. " +
                "An unkeyed hash alone does not prove authenticity.",
        );
    } else {
        trustLimitations.push(
            "No independently trusted session manifest or transfer provenance is available. " +
                "Inspection is allowed; removal-eligible classification is blocked.",
        );
        canBeRemovalEligible = false;
    }

    return {
        schemaVersion,
        manifestTrust,
        trustLimitations,
        snapshot,
        canBeRemovalEligible,
        canInspect: true,
        integrityFailed: false,
    };
}


async function streamHashFile(filePath, options = {}) {
    const onChunk = options.onChunk;
    const shouldCancel = options.shouldCancel;
    const hash = createHash("sha256");
    const stream = createReadStream(filePath, {
        highWaterMark: HASH_BUFFER_BYTES,
    });

    try {
        for await (const chunk of stream) {
            if (typeof shouldCancel === "function" && shouldCancel()) {
                stream.destroy();
                throw reclaimError(
                    "Verification cancelled.",
                    "CANCELLED",
                    409,
                );
            }
            hash.update(chunk);
            if (typeof onChunk === "function") {
                onChunk(chunk.length);
            }
        }
    } catch (error) {
        stream.destroy();
        throw error;
    }

    return hash.digest("hex");
}


async function probeAllocation(filePath, stats) {
    const logical = stats.size ?? 0;
    let physical = null;
    let confidence = "logical_only";
    const notes = [];

    if ((stats.nlink ?? 1) > 1) {
        notes.push(
            `Hard link detected (nlink=${stats.nlink}). Logical size is not guaranteed recoverable space.`,
        );
        confidence = "uncertain_hardlink";
        physical = 0;
    }

    if (process.platform === "win32") {
        try {
            // Best-effort: compressed/sparse size via PowerShell is intentionally
            // not opened here before safety checks; allocation uses Node stats only.
            if (typeof stats.blocks === "number" && stats.blocks >= 0) {
                physical = stats.blocks * 512;
                confidence =
                    confidence === "uncertain_hardlink"
                        ? "uncertain_hardlink"
                        : "blocks_estimate";
            }
        } catch {
            // ignore
        }
    } else if (typeof stats.blocks === "number" && stats.blocks >= 0) {
        physical = stats.blocks * 512;
        confidence =
            confidence === "uncertain_hardlink"
                ? "uncertain_hardlink"
                : "blocks_estimate";
    }

    if (stats.size === 0) {
        notes.push("Zero-length file.");
    }

    return {
        logicalBytes: logical,
        physicalBytes: physical,
        confidence,
        notes,
        nlink: stats.nlink ?? 1,
    };
}


async function detectDevProject(sourcePath, grantRoot) {
    const markers = [];
    let current = path.dirname(sourcePath);
    const rootNorm = normalizeCompare(grantRoot);
    const maxHops = 24;

    for (let hop = 0; hop < maxHops; hop += 1) {
        const currentNorm = normalizeCompare(current);
        if (
            currentNorm !== rootNorm &&
            !isPathInsideRoot(current, grantRoot)
        ) {
            break;
        }

        for (const marker of DEV_PROJECT_MARKERS) {
            const candidate = path.join(current, marker);
            try {
                await fs.lstat(candidate);
                markers.push(marker);
            } catch {
                // absent
            }
        }

        if (currentNorm === rootNorm) {
            break;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return [...new Set(markers)];
}


async function detectActiveUse(sourcePath) {
    // Synthetic reclaim test roots are harness-owned and have no real app
    // dependency surface; treat them as clear so D2 can exercise removal.
    if (isPathInsideSyntheticReclaimRoot(sourcePath)) {
        return {
            confidence: "clear",
            inUse: false,
            reason:
                "Source is inside an explicitly registered synthetic reclaim test root.",
        };
    }

    // Conservative: without a reliable open-handle enumerator, report unknown.
    // Do not open the file for writing or exclusive locks.
    return {
        confidence: "unknown",
        inUse: null,
        reason:
            "Active file usage could not be established conclusively. " +
            "Unknown usage is treated conservatively.",
    };
}


function remapDestination(journalDestination, relativePath, liveMount) {
    const dest = {
        ...journalDestination,
        mount: liveMount,
    };
    const root = offloadRootFor(dest);
    return path.join(root, ...String(relativePath).split(/[\\/]/).filter(Boolean));
}


function baseCandidate(file) {
    return {
        entryId: file.entryId,
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
        sizeBytes: file.sizeBytes ?? 0,
        journalState: file.state,
        eligibility: RECLAIM_FAILED,
        copyIntegrity: emptyIntegrity(),
        sourceIntegrity: emptyIntegrity(),
        destinationIntegrity: emptyIntegrity(),
        sourceAuthorization: emptyIntegrity(),
        dependencyConfidence: emptyIntegrity("unknown"),
        cloudReparseSafety: emptyIntegrity(),
        reasons: [],
        manualReviewNeeds: [],
        warnings: [],
        estimatedRecoverableLogicalBytes: 0,
        estimatedRecoverablePhysicalBytes: null,
        estimateConfidence: "none",
        sourceHashVerified: false,
        destinationHashVerified: false,
    };
}


function finalizeEligibility(candidate, { canBeRemovalEligible }) {
    candidate.lastVerifiedAt = new Date().toISOString();

    const hardFail =
        candidate.copyIntegrity.status === "failed" ||
        candidate.sourceIntegrity.status === "failed" ||
        candidate.destinationIntegrity.status === "failed" ||
        candidate.sourceAuthorization.status === "failed" ||
        candidate.cloudReparseSafety.status === "failed" ||
        candidate.cloudReparseSafety.status === "unsafe";

    if (hardFail) {
        if (
            candidate.eligibility !== RECLAIM_EXCLUDED &&
            candidate.eligibility !== RECLAIM_FAILED
        ) {
            candidate.eligibility = RECLAIM_FAILED;
        }
        candidate.estimatedRecoverableLogicalBytes = 0;
        candidate.estimatedRecoverablePhysicalBytes = null;
        return candidate;
    }

    if (candidate.eligibility === RECLAIM_EXCLUDED) {
        candidate.estimatedRecoverableLogicalBytes = 0;
        candidate.estimatedRecoverablePhysicalBytes = null;
        return candidate;
    }

    const dependencyUncertain =
        candidate.dependencyConfidence.status !== "clear";
    const integrityOk =
        candidate.copyIntegrity.status === "verified" &&
        candidate.sourceIntegrity.status === "verified" &&
        candidate.destinationIntegrity.status === "verified" &&
        candidate.sourceAuthorization.status === "authorized" &&
        candidate.cloudReparseSafety.status === "safe";

    if (!integrityOk) {
        candidate.eligibility = RECLAIM_FAILED;
        candidate.reasons.push("Integrity or authorization checks incomplete.");
        return candidate;
    }

    if (!canBeRemovalEligible) {
        candidate.eligibility = RECLAIM_MANUAL;
        candidate.manualReviewNeeds.push(
            "Independently trusted manifest provenance is missing. " +
                "Confirm the transfer report against the external copy manually; " +
                "do not treat this file as removal-eligible from journal data alone.",
        );
        candidate.reasons.push("Insufficient independently verified provenance.");
        return candidate;
    }

    if (dependencyUncertain) {
        candidate.eligibility = RECLAIM_MANUAL;
        if (candidate.manualReviewNeeds.length === 0) {
            candidate.manualReviewNeeds.push(
                "Investigate whether applications, projects, or services still depend on this file " +
                    "before considering removal in a future approved workflow.",
            );
        }
        return candidate;
    }

    candidate.eligibility = RECLAIM_ELIGIBLE;
    return candidate;
}


async function precheckPathSafety(filePath, options = {}) {
    const roots = options.roots ?? null;
    const role = options.role ?? "path";

    try {
        const lstat = await fs.lstat(filePath);
        if (lstat.isSymbolicLink()) {
            return {
                ok: false,
                reason: `${role} is a symbolic link or junction.`,
                code: "REPARSE",
                lstat,
            };
        }

        try {
            const link = await fs.readlink(filePath);
            if (link) {
                return {
                    ok: false,
                    reason: `${role} resolves as a reparse point.`,
                    code: "REPARSE",
                    lstat,
                };
            }
        } catch {
            // not a readable link
        }

        if (looksLikeCloudPath(filePath)) {
            return {
                ok: false,
                reason: `${role} appears to be inside a cloud-synchronized location.`,
                code: "CLOUD_PATH",
                lstat,
            };
        }

        const placeholder = await classifySourcePlaceholder(filePath, {
            authorizeHydrateCloudFiles: false,
        });
        if (placeholder.skip || placeholder.safe === false) {
            return {
                ok: false,
                reason:
                    placeholder.reason ||
                    `${role} failed cloud/reparse safety checks.`,
                code: placeholder.kind === "cloud_placeholder" ? "CLOUD" : "UNSAFE",
                lstat,
                placeholder,
            };
        }

        if (roots) {
            await assertPathHasNoSymlinkComponents(filePath);
            const resolved = await resolveExistingPath(filePath, {
                roots,
                outsideMessage: `${role} is outside authorized roots.`,
            });
            return { ok: true, lstat, resolved, placeholder };
        }

        return { ok: true, lstat, placeholder };
    } catch (error) {
        return {
            ok: false,
            reason: error.message,
            code: error.code ?? "IO_ERROR",
            lstat: null,
        };
    }
}


async function verifyOneFile(job, file, trust) {
    const candidate = baseCandidate(file);
    const session = getSessionById(job.sessionId);

    if (!session || session.ended) {
        candidate.sourceAuthorization = emptyIntegrity(
            "failed",
            "Storage session expired.",
        );
        candidate.reasons.push("Session expired during verification.");
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    if (file.state !== "verified") {
        candidate.copyIntegrity = emptyIntegrity(
            "failed",
            `Journal state is "${file.state}", not verified.`,
        );
        candidate.reasons.push(
            "File lacks a successful verification record in the transfer journal.",
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    if (!file.sourceHash || !file.destinationHash) {
        candidate.copyIntegrity = emptyIntegrity(
            "failed",
            "Journal is missing source or destination hash.",
        );
        candidate.reasons.push("Incomplete verification record.");
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    if (file.sourceHash !== file.destinationHash) {
        candidate.copyIntegrity = emptyIntegrity(
            "failed",
            "Journal source and destination hashes disagree.",
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    candidate.copyIntegrity = emptyIntegrity(
        "recorded",
        "Journal records matching source and destination hashes from the original transfer.",
    );

    if (trust.integrityFailed) {
        candidate.copyIntegrity = emptyIntegrity(
            "failed",
            "Manifest snapshot integrity failed.",
        );
        candidate.reasons.push(...trust.trustLimitations);
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    // Destination volume identity before any content open.
    let volume;
    try {
        const destinationMeta =
            trust.snapshot?.destination ?? job.journalDestination;
        const matched = await refreshAndMatchDestination(destinationMeta);
        volume = matched.volume;
    } catch (error) {
        candidate.destinationIntegrity = emptyIntegrity(
            "failed",
            error.message,
        );
        candidate.reasons.push(error.message);
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    const liveDest = remapDestination(
        {
            ...(trust.snapshot?.destination ?? job.journalDestination),
            mount: volume.mount,
        },
        file.relativePath,
        volume.mount,
    );
    candidate.destinationPath = liveDest;

    // Source authorization + grant before opening.
    const grant = findGrantForPath(file.sourcePath);
    if (!grant) {
        candidate.sourceAuthorization = emptyIntegrity(
            "failed",
            "Source is not covered by a current scan grant. Grant access again to inspect.",
        );
        candidate.reasons.push("Scan grant missing or expired for this source.");
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    if (file.grantId && grant.id !== file.grantId) {
        candidate.warnings.push(
            "Current grant id differs from the grant recorded at transfer time. " +
                "Inspection uses the live grant only and does not authorize removal.",
        );
    }

    const grantRoots = getGrantRoots();
    const sourceSafety = await precheckPathSafety(file.sourcePath, {
        roots: grantRoots,
        role: "Source",
    });

    if (!sourceSafety.ok) {
        if (sourceSafety.code === "CLOUD" || sourceSafety.code === "CLOUD_PATH") {
            candidate.cloudReparseSafety = emptyIntegrity(
                "unsafe",
                sourceSafety.reason,
            );
            candidate.eligibility = RECLAIM_EXCLUDED;
            candidate.reasons.push(sourceSafety.reason);
            return finalizeEligibility(candidate, trust);
        }
        if (sourceSafety.code === "REPARSE") {
            candidate.cloudReparseSafety = emptyIntegrity(
                "unsafe",
                sourceSafety.reason,
            );
            candidate.eligibility = RECLAIM_EXCLUDED;
            candidate.reasons.push(sourceSafety.reason);
            return finalizeEligibility(candidate, trust);
        }
        candidate.sourceAuthorization = emptyIntegrity(
            "failed",
            sourceSafety.reason,
        );
        candidate.reasons.push(sourceSafety.reason);
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    candidate.sourceAuthorization = emptyIntegrity(
        "authorized",
        "Source is inside a current scan grant.",
    );
    candidate.cloudReparseSafety = emptyIntegrity(
        "safe",
        "No cloud placeholder or unsafe reparse point detected before open.",
    );

    const protectedReason = describeProtectedReason(
        sourceSafety.resolved?.real ?? file.sourcePath,
    );
    if (protectedReason) {
        candidate.eligibility = RECLAIM_EXCLUDED;
        candidate.reasons.push(protectedReason);
        return finalizeEligibility(candidate, trust);
    }

    const labRoot = normalizeCompare(process.cwd());
    const sourceNorm = normalizeCompare(
        sourceSafety.resolved?.real ?? file.sourcePath,
    );
    if (
        sourceNorm === labRoot ||
        sourceNorm.startsWith(`${labRoot}${path.sep}`)
    ) {
        candidate.eligibility = RECLAIM_EXCLUDED;
        candidate.reasons.push(
            "Files inside the Local AI Lab application directory are excluded.",
        );
        return finalizeEligibility(candidate, trust);
    }

    const basename = path.basename(file.sourcePath).toLowerCase();
    if (
        SENSITIVE_BASENAMES.has(basename) ||
        basename.endsWith(".pem") ||
        basename.endsWith(".key") ||
        basename.startsWith(".env")
    ) {
        candidate.eligibility = RECLAIM_EXCLUDED;
        candidate.reasons.push("Sensitive filename excluded from reclaim review.");
        return finalizeEligibility(candidate, trust);
    }

    // Destination safety before open.
    const destSafety = await precheckPathSafety(liveDest, {
        roots: [volume.mount],
        role: "Destination",
    });
    if (!destSafety.ok) {
        if (destSafety.code === "ENOENT" || /not found|ENOENT/i.test(destSafety.reason)) {
            candidate.destinationIntegrity = emptyIntegrity(
                "failed",
                "Verified destination is missing.",
            );
        } else {
            candidate.destinationIntegrity = emptyIntegrity(
                "failed",
                destSafety.reason,
            );
            if (
                destSafety.code === "CLOUD" ||
                destSafety.code === "CLOUD_PATH" ||
                destSafety.code === "REPARSE"
            ) {
                candidate.cloudReparseSafety = emptyIntegrity(
                    "unsafe",
                    destSafety.reason,
                );
            }
        }
        candidate.reasons.push(destSafety.reason);
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    if (!destSafety.lstat?.isFile()) {
        candidate.destinationIntegrity = emptyIntegrity(
            "failed",
            "Destination is not a regular file.",
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    const offloadRoot = offloadRootFor({
        mount: volume.mount,
        folderName:
            trust.snapshot?.destination?.folderName ??
            job.journalDestination.folderName,
    });
    // Compare real paths so subst/mapped drives still validate (same as transfer).
    try {
        const destReal = destSafety.resolved?.real ?? (await fs.realpath(liveDest));
        const offloadReal = await fs.realpath(offloadRoot);
        if (!isPathInsideRoot(destReal, offloadReal)) {
            candidate.destinationIntegrity = emptyIntegrity(
                "failed",
                "Destination escaped the approved LocalAI-Offload tree.",
            );
            candidate.eligibility = RECLAIM_FAILED;
            return candidate;
        }
    } catch (error) {
        candidate.destinationIntegrity = emptyIntegrity(
            "failed",
            error.message,
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    // Re-check grant still valid immediately before hashing.
    if (!findGrantForPath(file.sourcePath)) {
        candidate.sourceAuthorization = emptyIntegrity(
            "failed",
            "Scan grant expired before hashing.",
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    const sourceStats = sourceSafety.lstat;
    const recordedIdentity = file.sourceIdentity ?? null;

    if (recordedIdentity) {
        if (
            sourceStats.size !== recordedIdentity.size ||
            (recordedIdentity.mtimeMs != null &&
                Math.abs(sourceStats.mtimeMs - recordedIdentity.mtimeMs) > 1) ||
            (recordedIdentity.ino != null &&
                sourceStats.ino !== recordedIdentity.ino) ||
            (recordedIdentity.dev != null &&
                sourceStats.dev !== recordedIdentity.dev)
        ) {
            candidate.sourceIntegrity = emptyIntegrity(
                "failed",
                "Source identity metadata changed since the verified transfer.",
            );
            candidate.reasons.push("Source identity changed.");
            candidate.eligibility = RECLAIM_FAILED;
            return candidate;
        }
    } else {
        candidate.warnings.push(
            "Original source identity metadata was not recorded in this journal. " +
                "A matching hash alone is not treated as proof that the original identity was preserved.",
        );
    }

    // Hash destination then source (streaming, cancellable).
    let destHash;
    let sourceHash;
    try {
        destHash = await streamHashFile(liveDest, {
            shouldCancel: () => job.cancelRequested === true,
        });
        if (!findGrantForPath(file.sourcePath)) {
            throw reclaimError(
                "Scan grant expired during hashing.",
                "GRANT_EXPIRED",
                409,
            );
        }
        sourceHash = await streamHashFile(
            sourceSafety.resolved?.real ?? file.sourcePath,
            {
                shouldCancel: () => job.cancelRequested === true,
            },
        );
    } catch (error) {
        candidate.eligibility = RECLAIM_FAILED;
        if (error.code === "CANCELLED") {
            candidate.reasons.push("Verification cancelled.");
            candidate.sourceIntegrity = emptyIntegrity("incomplete", "Cancelled.");
            candidate.destinationIntegrity = emptyIntegrity(
                "incomplete",
                "Cancelled.",
            );
            return candidate;
        }
        candidate.reasons.push(error.message);
        candidate.sourceIntegrity = emptyIntegrity("failed", error.message);
        return candidate;
    }

    candidate.destinationHashVerified = destHash === file.destinationHash;
    candidate.sourceHashVerified = sourceHash === file.sourceHash;

    if (!candidate.destinationHashVerified) {
        candidate.destinationIntegrity = emptyIntegrity(
            "failed",
            "Destination SHA-256 does not match the journal.",
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    if (!candidate.sourceHashVerified) {
        candidate.sourceIntegrity = emptyIntegrity(
            "failed",
            "Source SHA-256 does not match the journal.",
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    if (sourceHash !== destHash) {
        candidate.sourceIntegrity = emptyIntegrity(
            "failed",
            "Live source and destination hashes do not match.",
        );
        candidate.destinationIntegrity = emptyIntegrity(
            "failed",
            "Live source and destination hashes do not match.",
        );
        candidate.eligibility = RECLAIM_FAILED;
        return candidate;
    }

    candidate.destinationIntegrity = emptyIntegrity(
        "verified",
        "Destination exists on the matched volume and SHA-256 matches.",
    );
    candidate.sourceIntegrity = emptyIntegrity(
        "verified",
        recordedIdentity
            ? "Source identity metadata and SHA-256 match the verified transfer."
            : "Source SHA-256 matches, but original identity metadata was not recorded.",
    );
    candidate.copyIntegrity = emptyIntegrity(
        "verified",
        "Journal copy record independently revalidated against live source and destination.",
    );

    if (!recordedIdentity) {
        candidate.dependencyConfidence = emptyIntegrity(
            "uncertain",
            "Source identity provenance incomplete.",
        );
        candidate.manualReviewNeeds.push(
            "Confirm this is still the same original file (not a replaced file with identical contents) " +
                "before any future removal workflow.",
        );
    }

    const allocation = await probeAllocation(
        sourceSafety.resolved?.real ?? file.sourcePath,
        sourceStats,
    );
    candidate.warnings.push(...allocation.notes);

    const projectMarkers = await detectDevProject(
        sourceSafety.resolved?.real ?? file.sourcePath,
        grant.realPath,
    );
    if (projectMarkers.length > 0) {
        candidate.eligibility = RECLAIM_EXCLUDED;
        candidate.dependencyConfidence = emptyIntegrity(
            "blocked",
            `Development project markers near source: ${projectMarkers.join(", ")}.`,
        );
        candidate.reasons.push(
            "Active development project indicators were found within the granted folder tree.",
        );
        return finalizeEligibility(candidate, trust);
    }

    const usage = await detectActiveUse(
        sourceSafety.resolved?.real ?? file.sourcePath,
    );
    if (usage.inUse === true) {
        candidate.dependencyConfidence = emptyIntegrity(
            "uncertain",
            usage.reason,
        );
        candidate.manualReviewNeeds.push(
            "A process appears to reference this path. Confirm the file is unused before any future removal.",
        );
    } else if (usage.confidence === "unknown") {
        candidate.dependencyConfidence = emptyIntegrity(
            "uncertain",
            usage.reason,
        );
        candidate.manualReviewNeeds.push(
            "Could not prove the file is unused. Manually confirm no apps, services, or scheduled tasks depend on it.",
        );
    } else if (candidate.dependencyConfidence.status === "unknown") {
        candidate.dependencyConfidence = emptyIntegrity(
            "clear",
            "No project markers and no detected active use signals.",
        );
    }

    if ((allocation.nlink ?? 1) > 1) {
        candidate.dependencyConfidence = emptyIntegrity(
            "uncertain",
            "Hard-linked file; reclaiming may not free the expected space and may affect other paths.",
        );
        candidate.manualReviewNeeds.push(
            "Inspect other hard-link paths before considering removal.",
        );
        candidate.estimateConfidence = "uncertain_hardlink";
        candidate.estimatedRecoverableLogicalBytes = 0;
        candidate.estimatedRecoverablePhysicalBytes = 0;
    } else {
        candidate.estimateConfidence = allocation.confidence;
        candidate.estimatedRecoverableLogicalBytes = allocation.logicalBytes;
        candidate.estimatedRecoverablePhysicalBytes = allocation.physicalBytes;
    }

    return finalizeEligibility(candidate, trust);
}


function summarizeEstimates(candidates, journal) {
    const verifiedInJournal = (journal.files ?? []).filter(
        (file) => file.state === "verified",
    );
    const logicalCopied = verifiedInJournal.reduce(
        (sum, file) => sum + (file.sizeBytes ?? 0),
        0,
    );

    let logicalReverified = 0;
    let potentialLogical = 0;
    let potentialPhysical = 0;
    let physicalKnown = true;
    let estimateConfidence = "exact";

    for (const candidate of candidates) {
        if (
            candidate.sourceIntegrity.status === "verified" &&
            candidate.destinationIntegrity.status === "verified"
        ) {
            logicalReverified += candidate.sizeBytes ?? 0;
        }

        if (candidate.eligibility === RECLAIM_ELIGIBLE) {
            potentialLogical += candidate.estimatedRecoverableLogicalBytes ?? 0;
            if (
                candidate.estimatedRecoverablePhysicalBytes == null ||
                candidate.estimateConfidence === "logical_only" ||
                candidate.estimateConfidence === "uncertain_hardlink"
            ) {
                physicalKnown = false;
                if (candidate.estimateConfidence === "uncertain_hardlink") {
                    estimateConfidence = "uncertain_hardlink";
                } else if (estimateConfidence === "exact") {
                    estimateConfidence = "logical_only";
                }
            } else {
                potentialPhysical += candidate.estimatedRecoverablePhysicalBytes;
                if (
                    candidate.estimateConfidence === "blocks_estimate" &&
                    estimateConfidence === "exact"
                ) {
                    estimateConfidence = "blocks_estimate";
                }
            }
        }
    }

    return {
        logicalBytesCopiedAndVerifiedInJournal: logicalCopied,
        logicalBytesIndependentlyReverified: logicalReverified,
        potentiallyRemovableLogicalBytes: potentialLogical,
        estimatedPhysicallyRecoverableBytes: physicalKnown
            ? potentialPhysical
            : null,
        estimateConfidence,
        bytesActuallyReclaimed: 0,
        notes: [
            "Logical size is not guaranteed recoverable disk space.",
            "bytesActuallyReclaimed is always 0 in Milestone D1.",
            "Incomplete or interrupted transfers are never treated as entirely successful.",
        ],
    };
}


function countCandidates(candidates) {
    const counts = {
        eligible_for_review: 0,
        requires_manual_review: 0,
        excluded: 0,
        verification_failed: 0,
        reverified: 0,
    };

    for (const candidate of candidates) {
        counts[candidate.eligibility] =
            (counts[candidate.eligibility] ?? 0) + 1;
        if (
            candidate.sourceIntegrity.status === "verified" &&
            candidate.destinationIntegrity.status === "verified"
        ) {
            counts.reverified += 1;
        }
    }

    return counts;
}


async function runReclaimJob(job) {
    const session = getSessionById(job.sessionId);
    if (!session) {
        job.status = "failed";
        job.failureCode = "SESSION_EXPIRED";
        job.failureMessage = "Storage session expired.";
        job.finishedAt = new Date().toISOString();
        return;
    }

    await runWithSession(session, async () => {
        job.status = "running";
        job.message = "Independently verifying reclaim candidates.";

        for (const file of job.files) {
            if (job.cancelRequested) {
                job.status = "cancelled";
                job.failureCode = "CANCELLED";
                job.failureMessage = "Verification cancelled.";
                break;
            }

            if (Date.now() - job.startedAtMs > job.maxMs) {
                job.status = "incomplete";
                job.failureCode = "TIME_BUDGET";
                job.failureMessage =
                    "Verification time budget exhausted. Partial results preserved.";
                break;
            }

            job.currentFile = path.basename(file.sourcePath);
            job.currentEntryId = file.entryId;

            const candidate = await verifyOneFile(job, file, job.trust);
            job.candidates.push(candidate);
            job.processedFiles += 1;
        }

        if (
            job.status === "running" &&
            job.processedFiles >= job.entryCount
        ) {
            job.status = "completed";
            job.message =
                "Reclaim review finished. No original files were deleted or modified.";
        } else if (job.status === "running") {
            job.status = "incomplete";
            job.message =
                "Reclaim review ended before all files were verified. Partial results preserved.";
        }

        job.counts = countCandidates(job.candidates);
        job.estimates = summarizeEstimates(job.candidates, job.journal);
        job.currentFile = null;
        job.currentEntryId = null;
        job.finishedAt = new Date().toISOString();
    });

    liveReclaimJobs.delete(job.id);

    try {
        await appendActivity({
            type: "storage_reclaim_review",
            tool: "inspect_reclaim_candidates",
            status: job.status,
            summary: `Reclaim review ${job.status} for transfer ${job.transferId}`,
            details: {
                transferId: job.transferId,
                jobId: job.id,
                counts: job.counts,
                potentiallyRemovableLogicalBytes:
                    job.estimates?.potentiallyRemovableLogicalBytes ?? 0,
                bytesActuallyReclaimed: 0,
            },
        });
    } catch {
        // ignore audit failures
    }
}


export async function startReclaimReview(args) {
    const validated = validateInspectReclaimCandidates(args);
    const session = getActiveSession();
    if (!session) {
        throw reclaimError(
            "No storage scan session is active.",
            "NO_SESSION",
            401,
        );
    }

    const journal = await loadTransferJournal(validated.transferId);
    if (!journal) {
        throw reclaimError("Unknown transfer journal.", "UNKNOWN_TRANSFER", 404);
    }

    if (journal.sessionId && journal.sessionId !== session.id) {
        // Allow read-only inspection of finished journals after the original
        // session ends so users need not recopy to view a report. Block only
        // when another live session still owns the transfer.
        const owningSession = getSessionById(journal.sessionId);
        if (
            owningSession &&
            getSessionTransfer(validated.transferId, owningSession)
        ) {
            throw reclaimError(
                "That transfer belongs to another active storage session.",
                "FOREIGN_SESSION",
                403,
            );
        }
    }

    for (const existing of listSessionReclaimJobs(session)) {
        if (
            existing.transferId === validated.transferId &&
            (existing.status === "starting" || existing.status === "running")
        ) {
            throw reclaimError(
                "A reclaim verification job is already running for this transfer.",
                "RECLAIM_IN_PROGRESS",
                409,
            );
        }
    }

    const trust = assessManifestTrust(journal, session);
    if (!trust.canInspect) {
        throw reclaimError(
            "Transfer journal cannot be inspected.",
            "JOURNAL_UNREADABLE",
            409,
        );
    }

    let files = [...(journal.files ?? [])];
    if (validated.entryIds) {
        const byId = new Map(files.map((file) => [file.entryId, file]));
        files = validated.entryIds.map((id) => {
            const file = byId.get(id);
            if (!file) {
                throw reclaimError(
                    `Unknown entry id for this transfer: ${id}`,
                    "UNKNOWN_ENTRY",
                    400,
                );
            }
            return file;
        });
    }

    const transferComplete = journal.status === "completed";
    const interpretationLimits = [
        "D1 is read-only. No originals were deleted or modified.",
        "eligible_for_review is not permission to delete.",
        "Logical file size is not guaranteed recoverable disk space.",
        "bytesActuallyReclaimed is always 0 in this milestone.",
        "Incomplete transfers are never treated as entirely successful.",
        "Cloud placeholders are never silently hydrated.",
        ...trust.trustLimitations,
    ];

    if (!transferComplete) {
        interpretationLimits.push(
            `Original transfer status remains "${journal.status}". ` +
                "Individually verified files may still be reviewed; the transfer as a whole did not succeed.",
        );
    }

    const job = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        transferId: journal.transferId,
        status: "starting",
        transferStatus: journal.status,
        transferComplete,
        schemaVersion: trust.schemaVersion,
        manifestTrust: trust.manifestTrust,
        trustLimitations: trust.trustLimitations,
        trust,
        journal,
        journalDestination: journal.destination,
        files,
        entryCount: files.length,
        processedFiles: 0,
        candidates: [],
        currentFile: null,
        currentEntryId: null,
        cancelRequested: false,
        maxMs: validated.maxMs,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        finishedAt: null,
        failureCode: null,
        failureMessage: null,
        counts: {
            eligible_for_review: 0,
            requires_manual_review: 0,
            excluded: 0,
            verification_failed: 0,
            reverified: 0,
        },
        estimates: {
            logicalBytesCopiedAndVerifiedInJournal: 0,
            logicalBytesIndependentlyReverified: 0,
            potentiallyRemovableLogicalBytes: 0,
            estimatedPhysicallyRecoverableBytes: null,
            estimateConfidence: "none",
            bytesActuallyReclaimed: 0,
            notes: [],
        },
        message: "Starting reclaim verification.",
        interpretationLimits,
    };

    storeSessionReclaimJob(job, session);
    liveReclaimJobs.set(job.id, job);

    setImmediate(() => {
        runReclaimJob(job).catch(async (error) => {
            job.status = "failed";
            job.failureCode = error.code ?? "IO_ERROR";
            job.failureMessage = error.message;
            job.finishedAt = new Date().toISOString();
            job.counts = countCandidates(job.candidates);
            job.estimates = summarizeEstimates(job.candidates, job.journal);
            liveReclaimJobs.delete(job.id);
        });
    });

    return job;
}


/**
 * Tool entry: start a bounded reclaim job and wait briefly for completion
 * so simple cases return a compact summary without dumping hashes/paths.
 */
export async function executeInspectReclaimCandidates(args) {
    const job = await startReclaimReview(args);
    const waitBudget = Math.min(15_000, job.maxMs);
    const started = Date.now();

    while (Date.now() - started < waitBudget) {
        if (
            job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled" ||
            job.status === "incomplete"
        ) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (
        job.status === "starting" ||
        job.status === "running"
    ) {
        return {
            ...toolCompactSummary(job),
            status: job.status,
            message:
                "Reclaim verification is still running. Poll the reclaim job API for progress. " +
                "Full file lists and hashes are withheld from the model context.",
        };
    }

    return toolCompactSummary(job);
}


export function getPublicReclaimJob(jobId, session = getActiveSession()) {
    const job = getSessionReclaimJob(jobId, session);
    if (!job || job.sessionId !== session?.id) {
        return null;
    }
    return publicReclaimJob(job);
}


export function listPublicReclaimJobs(session = getActiveSession()) {
    return listSessionReclaimJobs(session)
        .filter((job) => job.sessionId === session?.id)
        .map(publicReclaimJob);
}


export function requestCancelReclaimJob(jobId, session = getActiveSession()) {
    const job = getSessionReclaimJob(jobId, session);
    if (!job || job.sessionId !== session?.id) {
        throw reclaimError("Unknown reclaim job.", "UNKNOWN_RECLAIM_JOB", 404);
    }

    if (
        job.status !== "starting" &&
        job.status !== "running"
    ) {
        return publicReclaimJob(job);
    }

    job.cancelRequested = true;
    const live = liveReclaimJobs.get(job.id);
    if (live) {
        live.cancelRequested = true;
    }
    job.status = "cancelling";
    job.message = "Cancellation requested.";
    return publicReclaimJob(job);
}


function endAllSessionReclaimJobs(session) {
    if (!session?.reclaimJobs) {
        return;
    }

    for (const job of session.reclaimJobs.values()) {
        if (job.status === "starting" || job.status === "running") {
            job.cancelRequested = true;
            job.status = "cancelled";
            job.failureCode = "SESSION_EXPIRED";
            job.failureMessage = "Storage session expired.";
            job.finishedAt = new Date().toISOString();
            liveReclaimJobs.delete(job.id);
        }
    }
}


export function bootstrapReclaimRuntime() {
    if (reclaimBootstrapped) {
        return;
    }
    reclaimBootstrapped = true;
    setReclaimSessionHooks({
        endSessionReclaimJobs: endAllSessionReclaimJobs,
    });
}


export const _test = {
    assessManifestTrust,
    streamHashFile,
    detectDevProject,
    precheckPathSafety,
    verifyOneFile,
    summarizeEstimates,
    publicCandidate,
    publicReclaimJob,
    toolCompactSummary,
    liveReclaimJobs,
    HASH_BUFFER_BYTES,
    JOURNAL_SCHEMA_VERSION,
    JOURNAL_SCHEMA_VERSION_LEGACY,
    fsConstants,
};
