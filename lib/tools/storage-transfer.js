// =========================================================
// lib/tools/storage-transfer.js
//
// Approval-gated copy + SHA-256 verify from locked manifests.
// Never deletes or modifies sources. No overwrite of destinations.
// =========================================================


import crypto, { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
    assertPathHasNoSymlinkComponents,
    isPathInsideRoot,
    resolveExistingPath,
    resolveNewPath,
} from "./path-safety.js";
import {
    getPublicManifest,
    recomputeManifestHash,
    refreshDriveSnapshot,
} from "./storage-offload.js";
import { isFilesystemRoot } from "./storage.js";
import {
    findActiveTransferForManifest,
    findGrantForPath,
    getActiveSession,
    getGrantRoots,
    getSessionById,
    getSessionManifest,
    getSessionTransfer,
    listSessionTransfers,
    runWithSession,
    setTransferSessionHooks,
    storeSessionTransfer,
} from "../storage-session.js";
import {
    markUnfinishedJournalsInterrupted,
    readTransferJournal,
    writeTransferJournal,
} from "../transfer-journal.js";


export const CAPACITY_MARGIN_FLOOR_BYTES = 64 * 1024 * 1024;
export const CAPACITY_MARGIN_RATIO = 0.05;

const NTFS_LIKE = new Set(["ntfs"]);
const EXCL_COPY_FS = new Set(["exfat", "fat32", "fat"]);
const SUPPORTED_FS = new Set(["ntfs", "exfat", "fat32", "fat"]);

const CLOUD_PATH_MARKERS = [
    `${path.sep}onedrive${path.sep}`,
    `${path.sep}icloud drive${path.sep}`,
    `${path.sep}iclouddrive${path.sep}`,
    `${path.sep}dropbox${path.sep}`,
    `${path.sep}google drive${path.sep}`,
];

/** @type {Map<string, object>} */
const liveJobs = new Map();

let bootstrapped = false;


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


function transferError(message, code, status = 400) {
    return Object.assign(new Error(message), { code, status });
}


function capacityMargin(remainingBytes) {
    return Math.max(
        CAPACITY_MARGIN_FLOOR_BYTES,
        Math.ceil((remainingBytes ?? 0) * CAPACITY_MARGIN_RATIO),
    );
}


function finalizationStrategy(fileSystem) {
    const fsName = String(fileSystem ?? "").trim().toLowerCase();
    if (NTFS_LIKE.has(fsName)) {
        return "ntfs_hardlink";
    }
    if (EXCL_COPY_FS.has(fsName)) {
        return "excl_copy";
    }
    return null;
}


function offloadRootFor(destination) {
    const mount = destination.mount.endsWith("\\") || destination.mount.endsWith("/")
        ? destination.mount
        : `${destination.mount}\\`;
    return path.join(mount, "LocalAI-Offload", destination.folderName);
}


function looksLikeCloudPath(filePath) {
    const norm = `${path.sep}${normalizeCompare(filePath)}${path.sep}`;
    return CLOUD_PATH_MARKERS.some((marker) => norm.includes(marker));
}


/**
 * Best-effort Windows attribute probe via fixed PowerShell.
 * Path is passed only through an environment variable.
 */
async function probeWindowsFileAttributes(filePath) {
    if (process.platform !== "win32") {
        return null;
    }

    const script =
        "$p = $env:LOCAL_AI_XFER_PATH; " +
        "if (-not $p) { exit 2 }; " +
        "$item = Get-Item -LiteralPath $p -Force -ErrorAction Stop; " +
        "$attrs = [string]$item.Attributes; " +
        "$reparse = $attrs -match 'ReparsePoint'; " +
        "$offline = $attrs -match 'Offline'; " +
        "$recall = $false; " +
        "try { " +
        "$fi = [System.IO.File]::GetAttributes($p); " +
        "$recall = (($fi -band 0x400000) -ne 0) -or (($fi -band 0x40000) -ne 0); " +
        "} catch {}; " +
        "[pscustomobject]@{ Attributes=$attrs; ReparsePoint=$reparse; " +
        "Offline=$offline; RecallOnAccess=$recall } | ConvertTo-Json -Compress";

    return new Promise((resolve) => {
        const child = spawn(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            {
                env: {
                    ...process.env,
                    LOCAL_AI_XFER_PATH: filePath,
                },
                windowsHide: true,
            },
        );

        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            resolve(null);
        }, 8_000);

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", () => {
            clearTimeout(timer);
            resolve(null);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim() || "null"));
            } catch {
                resolve(null);
            }
        });
    });
}


export async function classifySourcePlaceholder(filePath, options = {}) {
    const authorizeHydrate = options.authorizeHydrateCloudFiles === true;
    const lstat = await fs.lstat(filePath);

    if (lstat.isSymbolicLink()) {
        return {
            kind: "symlink",
            safe: false,
            skip: true,
            reason: "Source is a symbolic link or junction and cannot be copied safely.",
        };
    }

    if (!lstat.isFile()) {
        return {
            kind: "unsupported",
            safe: false,
            skip: true,
            reason: "Source is not a regular file.",
        };
    }

    try {
        const link = await fs.readlink(filePath);
        if (link) {
            return {
                kind: "reparse",
                safe: false,
                skip: true,
                reason: "Source resolves as a reparse point and cannot be verified safely.",
            };
        }
    } catch {
        // not a readable link — continue
    }

    const attrs = await probeWindowsFileAttributes(filePath);
    const cloudish =
        attrs?.ReparsePoint === true ||
        attrs?.Offline === true ||
        attrs?.RecallOnAccess === true ||
        looksLikeCloudPath(filePath);

    if (cloudish && !authorizeHydrate) {
        return {
            kind: "cloud_placeholder",
            safe: false,
            skip: true,
            reason:
                "Source appears to be a cloud-only or reparse-point placeholder. " +
                "It was skipped because hydrating cloud content was not authorized.",
        };
    }

    if (cloudish && authorizeHydrate) {
        return {
            kind: "cloud_hydrate_authorized",
            safe: true,
            skip: false,
            reason: "User authorized hydrating cloud content for this transfer.",
        };
    }

    return { kind: "regular", safe: true, skip: false, reason: null };
}


async function hashFile(filePath) {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}


async function ensureParents(destPath, offloadRoot, volumeMount) {
    const dest = await resolveNewPath(destPath, {
        roots: [volumeMount],
        outsideMessage:
            "Destination path is outside the approved destination volume.",
    });

    if (!isPathInsideRoot(dest.resolved, offloadRoot)) {
        throw transferError(
            "Destination path is outside the approved LocalAI-Offload tree.",
            "DEST_ESCAPE",
            400,
        );
    }

    await fs.mkdir(path.dirname(dest.resolved), { recursive: true });
    await assertPathHasNoSymlinkComponents(path.dirname(dest.resolved));

    const parentReal = await fs.realpath(path.dirname(dest.resolved));
    const mountReal = await fs.realpath(path.resolve(volumeMount));
    // Compare against the mount's real path so subst/mapped drives still validate.
    if (
        !isPathInsideRoot(parentReal, mountReal) &&
        !isPathInsideRoot(parentReal, path.resolve(volumeMount))
    ) {
        throw transferError(
            "Destination parent escaped the destination volume.",
            "DEST_ESCAPE",
            400,
        );
    }

    return dest;
}


/**
 * Race-safe finalization that cannot overwrite an existing destination.
 */
export async function finalizeExclusive(tempPath, finalPath, strategy) {
    if (strategy === "ntfs_hardlink") {
        try {
            await fs.link(tempPath, finalPath);
        } catch (error) {
            if (error.code === "EEXIST") {
                throw transferError(
                    "Destination already exists; refusing to overwrite.",
                    "DEST_EXISTS",
                    409,
                );
            }
            throw error;
        }

        try {
            await fs.unlink(tempPath);
        } catch {
            // Final name exists; temp leftover is recoverable.
        }
        return { method: "ntfs_hardlink" };
    }

    if (strategy === "excl_copy") {
        try {
            await fs.copyFile(tempPath, finalPath, fsConstants.COPYFILE_EXCL);
        } catch (error) {
            if (error.code === "EEXIST") {
                throw transferError(
                    "Destination already exists; refusing to overwrite.",
                    "DEST_EXISTS",
                    409,
                );
            }
            throw error;
        }

        const tempHash = await hashFile(tempPath);
        const finalHash = await hashFile(finalPath);
        if (tempHash !== finalHash) {
            try {
                await fs.unlink(finalPath);
            } catch {
                // leave for manual recovery if unlink fails
            }
            throw transferError(
                "Exclusive copy verification failed.",
                "HASH_MISMATCH",
                500,
            );
        }

        try {
            await fs.unlink(tempPath);
        } catch {
            // ignore
        }
        return { method: "excl_copy" };
    }

    throw transferError(
        `Unsupported destination filesystem for exclusive finalization (${strategy}).`,
        "UNSUPPORTED_FS",
        400,
    );
}


export async function refreshAndMatchDestination(manifestDestination) {
    const snapshot = await refreshDriveSnapshot();
    const volumes = snapshot.volumes ?? [];
    const match = volumes.find(
        (volume) => volume.volumeId === manifestDestination.volumeId,
    );

    if (!match) {
        throw transferError(
            "Destination volume is not connected or its identity changed.",
            "DRIVE_GONE",
            409,
        );
    }

    if (
        match.identityConfidence === "low" ||
        !match.volumeId ||
        match.volumeId !== manifestDestination.volumeId
    ) {
        throw transferError(
            "Destination volume identity is ambiguous or changed.",
            "IDENTITY_CHANGED",
            409,
        );
    }

    if (
        manifestDestination.volumeSerialNumber &&
        match.volumeSerialNumber &&
        String(match.volumeSerialNumber) !==
            String(manifestDestination.volumeSerialNumber)
    ) {
        throw transferError(
            "Destination volume serial number changed.",
            "IDENTITY_CHANGED",
            409,
        );
    }

    if (
        manifestDestination.diskUniqueId &&
        match.diskUniqueId &&
        String(match.diskUniqueId) !== String(manifestDestination.diskUniqueId)
    ) {
        throw transferError(
            "Destination disk unique id changed.",
            "IDENTITY_CHANGED",
            409,
        );
    }

    if (!isFilesystemRoot(match.mount)) {
        throw transferError(
            "Destination mount must be a volume root.",
            "INVALID_MOUNT",
            400,
        );
    }

    const fsName = String(match.fileSystem ?? "").trim().toLowerCase();
    if (!SUPPORTED_FS.has(fsName)) {
        throw transferError(
            `Unsupported destination filesystem: ${match.fileSystem ?? "unknown"}.`,
            "UNSUPPORTED_FS",
            400,
        );
    }

    const strategy = finalizationStrategy(match.fileSystem);
    if (!strategy) {
        throw transferError(
            `No exclusive finalization strategy for ${match.fileSystem}.`,
            "UNSUPPORTED_FS",
            400,
        );
    }

    return { volume: match, strategy, snapshot };
}


function assertManifestIntegrity(manifest) {
    if (!manifest) {
        throw transferError("Unknown transfer manifest.", "UNKNOWN_MANIFEST", 404);
    }

    if (manifest.invalidated) {
        throw transferError(
            manifest.invalidReason || "That manifest is no longer valid.",
            "MANIFEST_INVALID",
            409,
        );
    }

    const expected = recomputeManifestHash(manifest);
    if (!expected || expected !== manifest.hash) {
        throw transferError(
            "Manifest integrity check failed.",
            "MANIFEST_TAMPERED",
            409,
        );
    }
}


async function assertSourceAuthorized(entry, authorizeHydrateCloudFiles) {
    const grant = findGrantForPath(entry.sourcePath);
    if (!grant || grant.id !== entry.grantId) {
        throw transferError(
            "A selected source is no longer authorized by a scan grant.",
            "GRANT_REVOKED",
            409,
        );
    }

    const grantRoots = getGrantRoots();
    const resolved = await resolveExistingPath(entry.sourcePath, {
        roots: grantRoots,
        outsideMessage: "Source path is outside authorized scan grants.",
    });

    if (!resolved.stats.isFile() || resolved.stats.isSymbolicLink()) {
        throw transferError(
            "Source is not a regular file.",
            "UNSUPPORTED_SOURCE",
            400,
        );
    }

    if (resolved.stats.size !== entry.sizeBytes) {
        throw transferError(
            "Source size changed since planning.",
            "SOURCE_CHANGED",
            409,
        );
    }

    if (
        entry.mtimeMs != null &&
        Number.isFinite(entry.mtimeMs) &&
        Math.abs(resolved.stats.mtimeMs - entry.mtimeMs) > 1
    ) {
        throw transferError(
            "Source modification time changed since planning.",
            "SOURCE_CHANGED",
            409,
        );
    } else if (
        (entry.mtimeMs == null || !Number.isFinite(entry.mtimeMs)) &&
        resolved.stats.mtime.toISOString() !== entry.mtime
    ) {
        throw transferError(
            "Source modification time changed since planning.",
            "SOURCE_CHANGED",
            409,
        );
    }

    const placeholder = await classifySourcePlaceholder(resolved.real, {
        authorizeHydrateCloudFiles,
    });
    if (placeholder.skip) {
        return {
            resolved,
            grant,
            skip: true,
            skipReason: placeholder.reason,
            placeholder,
        };
    }

    return {
        resolved,
        grant,
        skip: false,
        skipReason: null,
        placeholder,
        identity: {
            size: resolved.stats.size,
            mtimeMs: resolved.stats.mtimeMs,
            ino: resolved.stats.ino,
            dev: resolved.stats.dev,
        },
    };
}


function assertNoOverlap(sourcePath, destPath) {
    const sourceNorm = normalizeCompare(sourcePath);
    const destNorm = normalizeCompare(destPath);
    if (
        sourceNorm === destNorm ||
        isPathInsideRoot(destPath, sourcePath) ||
        isPathInsideRoot(sourcePath, destPath)
    ) {
        throw transferError(
            "Source and destination paths overlap.",
            "PATH_OVERLAP",
            400,
        );
    }
}


export function buildTransferPreview(manifest, volumeHint = null) {
    const freeBytes = volumeHint?.freeBytes ?? manifest.destination.freeBytes ?? null;
    const remainingAfter =
        freeBytes == null
            ? null
            : Math.max(0, freeBytes - (manifest.estimatedTransferBytes ?? 0));

    return {
        manifestId: manifest.id,
        manifestHash: manifest.hash,
        destination: {
            volumeId: manifest.destination.volumeId,
            mount: manifest.destination.mount,
            label: manifest.destination.label,
            folderName: manifest.destination.folderName,
            fileSystem: manifest.destination.fileSystem,
            freeBytes,
        },
        entryCount: manifest.entries.length,
        estimatedTransferBytes: manifest.estimatedTransferBytes,
        estimatedFreeBytesRemaining: remainingAfter,
        complete: manifest.complete === true,
        incomplete: manifest.incomplete,
        requiresIncompleteAck: manifest.complete !== true,
        originalsUntouched:
            "Originals will remain untouched on your computer. Copying does not free internal storage.",
        entries: manifest.entries.map((entry) => ({
            id: entry.id,
            sourcePath: entry.sourcePath,
            destinationPath: entry.destinationPath,
            sizeBytes: entry.sizeBytes,
            safety: entry.safety,
            concerns: [
                ...(entry.dependencyConcerns ?? []),
                ...(entry.concerns ?? []),
            ],
        })),
        dependencyWarnings: manifest.entries.flatMap((entry) =>
            [...(entry.dependencyConcerns ?? []), ...(entry.concerns ?? [])].map(
                (text) => ({ entryId: entry.id, text }),
            ),
        ),
    };
}


export function validateCopyAndVerifyFiles(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, [
        "manifestId",
        "reason",
        "authorizeHydrateCloudFiles",
    ]);

    return {
        manifestId: requireString(args, "manifestId", 80),
        reason: requireString(args, "reason", 500),
        authorizeHydrateCloudFiles: args.authorizeHydrateCloudFiles === true,
    };
}


export async function precheckCopyAndVerifyFiles(args) {
    const validated = validateCopyAndVerifyFiles(args);
    const session = getActiveSession();
    if (!session) {
        throw transferError("No storage scan session is active.", "NO_SESSION", 401);
    }

    const manifest = getSessionManifest(validated.manifestId);
    assertManifestIntegrity(manifest);

    if (manifest.sessionId && manifest.sessionId !== session.id) {
        throw transferError("Unknown transfer manifest.", "UNKNOWN_MANIFEST", 404);
    }

    if (findActiveTransferForManifest(manifest.id, session)) {
        throw transferError(
            "A transfer for this manifest is already in progress.",
            "TRANSFER_IN_PROGRESS",
            409,
        );
    }

    for (const entry of manifest.entries) {
        const grant = findGrantForPath(entry.sourcePath);
        if (!grant || grant.id !== entry.grantId) {
            throw transferError(
                "A selected source is no longer authorized by a scan grant.",
                "GRANT_REVOKED",
                409,
            );
        }
    }

    const { volume, strategy } = await refreshAndMatchDestination(
        manifest.destination,
    );
    const preview = buildTransferPreview(manifest, volume);
    preview.finalizationStrategy = strategy;
    preview.requiresIncompleteAck = manifest.complete !== true;

    return { validated, manifest, preview, volume, strategy };
}


function publicTransfer(job) {
    return {
        transferId: job.id,
        status: job.status,
        manifestId: job.manifestId,
        manifestHash: job.manifestHash,
        entryCount: job.entryCount,
        completedFiles: job.completedFiles,
        failedFiles: job.failedFiles,
        skippedFiles: job.skippedFiles,
        bytesTransferred: job.bytesTransferred,
        bytesTotal: job.bytesTotal,
        verifiedBytes: job.verifiedBytes,
        currentFile: job.currentFile,
        bytesPerSecond: job.bytesPerSecond,
        estimatedSecondsRemaining: job.estimatedSecondsRemaining,
        destination: job.destinationPublic,
        completeScan: job.completeScan,
        message: job.message,
        failureCode: job.failureCode ?? null,
        failureMessage: job.failureMessage ?? null,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt ?? null,
        files: (job.files ?? []).map((file) => ({
            entryId: file.entryId,
            state: file.state,
            sizeBytes: file.sizeBytes,
            relativePath: file.relativePath,
            failureCode: file.failureCode ?? null,
            failureMessage: file.failureMessage ?? null,
            // hashes intentionally omitted from public API
        })),
    };
}


async function persistJob(job) {
    const record = {
        transferId: job.id,
        sessionId: job.sessionId,
        manifestId: job.manifestId,
        manifestHash: job.manifestHash,
        status: job.status,
        finalizationStrategy: job.strategy,
        destination: job.destination,
        authorizeHydrateCloudFiles: job.authorizeHydrateCloudFiles,
        bytesTransferred: job.bytesTransferred,
        bytesTotal: job.bytesTotal,
        verifiedBytes: job.verifiedBytes,
        completedFiles: job.completedFiles,
        failedFiles: job.failedFiles,
        skippedFiles: job.skippedFiles,
        failureCode: job.failureCode ?? null,
        failureMessage: job.failureMessage ?? null,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt ?? null,
        files: job.files.map((file) => ({
            entryId: file.entryId,
            sourcePath: file.sourcePath,
            destinationPath: file.destinationPath,
            tempPath: file.tempPath ?? null,
            relativePath: file.relativePath,
            sizeBytes: file.sizeBytes,
            state: file.state,
            sourceHash: file.sourceHash ?? null,
            destinationHash: file.destinationHash ?? null,
            failureCode: file.failureCode ?? null,
            failureMessage: file.failureMessage ?? null,
            updatedAt: file.updatedAt ?? null,
        })),
    };

    await writeTransferJournal(job.id, record);
    return record;
}


function updateSpeed(job, bytesJustWritten) {
    const now = Date.now();
    if (!job._speedWindow) {
        job._speedWindow = [];
    }
    job._speedWindow.push({ at: now, bytes: bytesJustWritten });
    job._speedWindow = job._speedWindow.filter((item) => now - item.at < 5_000);
    const total = job._speedWindow.reduce((sum, item) => sum + item.bytes, 0);
    const elapsed = Math.max(
        1,
        (now - (job._speedWindow[0]?.at ?? now)) / 1000,
    );
    job.bytesPerSecond = Math.round(total / elapsed);
    const remaining = Math.max(0, job.bytesTotal - job.bytesTransferred);
    job.estimatedSecondsRemaining =
        job.bytesPerSecond > 0
            ? Math.ceil(remaining / job.bytesPerSecond)
            : null;
}


async function copyOneFile(job, file, session) {
    file.state = "copying";
    file.updatedAt = new Date().toISOString();
    job.currentFile = path.basename(file.sourcePath);
    await persistJob(job);

    if (job.cancelRequested) {
        throw transferError("Transfer cancelled.", "CANCELLED", 409);
    }

    const liveSession = getSessionById(job.sessionId);
    if (!liveSession || liveSession.ended) {
        throw transferError("Storage session expired.", "SESSION_EXPIRED", 401);
    }

    const manifest = getSessionManifest(job.manifestId);
    assertManifestIntegrity(manifest);

    const { volume, strategy } = await refreshAndMatchDestination(
        manifest.destination,
    );
    job.strategy = strategy;
    job.destination = {
        ...manifest.destination,
        mount: volume.mount,
        freeBytes: volume.freeBytes,
        fileSystem: volume.fileSystem,
    };

    const sourceInfo = await runWithSession(liveSession, () =>
        assertSourceAuthorized(file, job.authorizeHydrateCloudFiles),
    );

    if (sourceInfo.skip) {
        file.state = "skipped";
        file.failureCode = "CLOUD_PLACEHOLDER";
        file.failureMessage = sourceInfo.skipReason;
        file.updatedAt = new Date().toISOString();
        job.skippedFiles += 1;
        await persistJob(job);
        return;
    }

    const offloadRoot = offloadRootFor(job.destination);
    assertNoOverlap(sourceInfo.resolved.real, file.destinationPath);

    // Remap destination onto the live mount while preserving relative structure.
    const relative = file.relativePath;
    const liveDest = path.join(offloadRoot, ...relative.split(/[\\/]/).filter(Boolean));
    file.destinationPath = liveDest;

    const remainingBytes = Math.max(
        0,
        job.bytesTotal - job.bytesTransferred,
    );
    const needed =
        remainingBytes +
        capacityMargin(remainingBytes) +
        (strategy === "excl_copy" ? file.sizeBytes : 0);

    if (volume.freeBytes != null && volume.freeBytes < needed) {
        throw transferError(
            "Insufficient free space on the destination volume.",
            "NOSPC",
            409,
        );
    }

    await ensureParents(liveDest, offloadRoot, volume.mount);

    try {
        await fs.lstat(liveDest);
        throw transferError(
            "Destination already exists; refusing to overwrite.",
            "DEST_EXISTS",
            409,
        );
    } catch (error) {
        if (error.code === "DEST_EXISTS") {
            throw error;
        }
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    const tempPath = path.join(
        path.dirname(liveDest),
        `.localai-xfer-${job.id}-${file.entryId}.partial`,
    );
    file.tempPath = tempPath;

    try {
        await fs.lstat(tempPath);
        throw transferError(
            "A partial transfer file already exists for this entry.",
            "PARTIAL_EXISTS",
            409,
        );
    } catch (error) {
        if (error.code === "PARTIAL_EXISTS") {
            throw error;
        }
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    const sourceHandle = await fs.open(sourceInfo.resolved.real, "r");
    let tempHandle = null;
    const hash = createHash("sha256");

    try {
        const preStat = await sourceHandle.stat();
        if (
            preStat.size !== sourceInfo.identity.size ||
            preStat.mtimeMs !== sourceInfo.identity.mtimeMs ||
            preStat.ino !== sourceInfo.identity.ino ||
            preStat.dev !== sourceInfo.identity.dev
        ) {
            throw transferError(
                "Source identity changed before copy.",
                "SOURCE_CHANGED",
                409,
            );
        }

        tempHandle = await fs.open(tempPath, "wx");
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0;

        while (true) {
            if (job.cancelRequested) {
                throw transferError("Transfer cancelled.", "CANCELLED", 409);
            }

            const { bytesRead } = await sourceHandle.read(
                buffer,
                0,
                buffer.length,
                position,
            );
            if (bytesRead === 0) {
                break;
            }

            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await tempHandle.write(chunk, 0, bytesRead);
            position += bytesRead;
            job.bytesTransferred += bytesRead;
            updateSpeed(job, bytesRead);
        }

        await tempHandle.sync();

        const postStat = await sourceHandle.stat();
        if (
            postStat.size !== sourceInfo.identity.size ||
            postStat.mtimeMs !== sourceInfo.identity.mtimeMs ||
            postStat.ino !== sourceInfo.identity.ino ||
            postStat.dev !== sourceInfo.identity.dev
        ) {
            throw transferError(
                "Source changed during copy.",
                "SOURCE_CHANGED",
                409,
            );
        }

        await tempHandle.close();
        tempHandle = null;
        await sourceHandle.close();

        file.state = "copied";
        file.sourceHash = hash.digest("hex");
        file.updatedAt = new Date().toISOString();
        await persistJob(job);

        file.state = "verifying";
        file.updatedAt = new Date().toISOString();
        await persistJob(job);

        const destHash = await hashFile(tempPath);
        if (destHash !== file.sourceHash) {
            throw transferError(
                "Hash mismatch between source stream and temporary destination.",
                "HASH_MISMATCH",
                500,
            );
        }

        // Recheck final absence immediately before exclusive finalization.
        try {
            await fs.lstat(liveDest);
            throw transferError(
                "Destination appeared before finalization; refusing to overwrite.",
                "DEST_EXISTS",
                409,
            );
        } catch (error) {
            if (error.code === "DEST_EXISTS") {
                throw error;
            }
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        await finalizeExclusive(tempPath, liveDest, strategy);

        const finalHash = await hashFile(liveDest);
        if (finalHash !== file.sourceHash) {
            throw transferError(
                "Hash mismatch after finalization.",
                "HASH_MISMATCH",
                500,
            );
        }

        file.destinationHash = finalHash;
        file.state = "verified";
        file.tempPath = null;
        file.updatedAt = new Date().toISOString();
        job.completedFiles += 1;
        job.verifiedBytes += file.sizeBytes;
        await persistJob(job);
    } catch (error) {
        if (tempHandle) {
            try {
                await tempHandle.close();
            } catch {
                // ignore
            }
        }
        try {
            await sourceHandle.close();
        } catch {
            // ignore
        }

        file.state = job.cancelRequested ? "interrupted" : "failed";
        file.failureCode = error.code ?? "IO_ERROR";
        file.failureMessage = error.message;
        file.updatedAt = new Date().toISOString();
        job.failedFiles += 1;
        await persistJob(job);

        if (
            error.code === "CANCELLED" ||
            error.code === "SESSION_EXPIRED" ||
            error.code === "GRANT_REVOKED" ||
            error.code === "DRIVE_GONE" ||
            error.code === "IDENTITY_CHANGED" ||
            error.code === "MANIFEST_INVALID" ||
            error.code === "MANIFEST_TAMPERED" ||
            error.code === "NOSPC"
        ) {
            throw error;
        }
    }
}


async function runTransferJob(job) {
    const session = getSessionById(job.sessionId);
    if (!session) {
        job.status = "failed";
        job.failureCode = "SESSION_EXPIRED";
        job.failureMessage = "Storage session expired before transfer started.";
        job.finishedAt = new Date().toISOString();
        await persistJob(job);
        liveJobs.delete(job.id);
        return;
    }

    await runWithSession(session, async () => {
        try {
            job.status = "running";
            await persistJob(job);

            for (const file of job.files) {
                if (job.cancelRequested) {
                    throw transferError("Transfer cancelled.", "CANCELLED", 409);
                }

                if (file.state === "verified" || file.state === "skipped") {
                    // Never trust prior verified without re-hash in a new authorization.
                    // In-progress job may continue only for not-yet-started files.
                    if (file.state === "verified") {
                        continue;
                    }
                }

                await copyOneFile(job, file, session);
            }

            job.status = job.cancelRequested
                ? "cancelled"
                : job.failedFiles > 0
                  ? "failed"
                  : "completed";
            job.finishedAt = new Date().toISOString();
            job.currentFile = null;
            job.message =
                job.status === "completed"
                    ? "Files copied and verified. Originals remain on your computer. No internal storage has been freed."
                    : job.status === "cancelled"
                      ? "Transfer cancelled. Originals remain untouched."
                      : "Transfer finished with failures. Originals remain untouched.";
            await persistJob(job);
        } catch (error) {
            job.status =
                error.code === "CANCELLED"
                    ? "cancelled"
                    : error.code === "SESSION_EXPIRED" ||
                        error.code === "GRANT_REVOKED"
                      ? "failed"
                      : "failed";
            job.failureCode = error.code ?? "IO_ERROR";
            job.failureMessage = error.message;
            job.finishedAt = new Date().toISOString();
            job.currentFile = null;
            for (const file of job.files) {
                if (
                    file.state === "pending" ||
                    file.state === "copying" ||
                    file.state === "copied" ||
                    file.state === "verifying"
                ) {
                    file.state = "interrupted";
                    file.failureCode = file.failureCode ?? error.code ?? "INTERRUPTED";
                }
            }
            await persistJob(job);
        } finally {
            liveJobs.delete(job.id);
        }
    });
}


/**
 * Start transfer after approval. Returns quickly with transferId.
 */
export async function executeCopyAndVerifyFiles(args) {
    const { validated, manifest, preview, volume, strategy } =
        await precheckCopyAndVerifyFiles(args);

    const session = getActiveSession();
    if (!session) {
        throw transferError("No storage scan session is active.", "NO_SESSION", 401);
    }

    if (findActiveTransferForManifest(manifest.id, session)) {
        throw transferError(
            "A transfer for this manifest is already in progress.",
            "TRANSFER_IN_PROGRESS",
            409,
        );
    }

    const offloadRoot = offloadRootFor({
        ...manifest.destination,
        mount: volume.mount,
    });

    const remainingBytes = manifest.estimatedTransferBytes ?? 0;
    const dualCopyExtra = strategy === "excl_copy" ? remainingBytes : 0;
    const needed =
        remainingBytes + capacityMargin(remainingBytes) + dualCopyExtra;
    if (volume.freeBytes != null && volume.freeBytes < needed) {
        throw transferError(
            "Insufficient free space on the destination volume for this finalization strategy.",
            "NOSPC",
            409,
        );
    }

    const transferId = cryptoRandomId();
    const startedAt = new Date().toISOString();

    const job = {
        id: transferId,
        sessionId: session.id,
        manifestId: manifest.id,
        manifestHash: manifest.hash,
        status: "starting",
        strategy,
        authorizeHydrateCloudFiles: validated.authorizeHydrateCloudFiles,
        destination: {
            ...manifest.destination,
            mount: volume.mount,
            freeBytes: volume.freeBytes,
            fileSystem: volume.fileSystem,
        },
        destinationPublic: {
            volumeId: manifest.destination.volumeId,
            mount: volume.mount,
            folderName: manifest.destination.folderName,
            offloadRoot,
        },
        entryCount: manifest.entries.length,
        completedFiles: 0,
        failedFiles: 0,
        skippedFiles: 0,
        bytesTransferred: 0,
        bytesTotal: remainingBytes,
        verifiedBytes: 0,
        currentFile: null,
        bytesPerSecond: 0,
        estimatedSecondsRemaining: null,
        completeScan: manifest.complete === true,
        message: "Transfer starting.",
        cancelRequested: false,
        startedAt,
        finishedAt: null,
        files: manifest.entries.map((entry) => ({
            entryId: entry.id,
            sourcePath: entry.sourcePath,
            destinationPath: entry.destinationPath,
            relativePath: entry.relativePath,
            sizeBytes: entry.sizeBytes,
            mtime: entry.mtime,
            mtimeMs: entry.mtimeMs ?? null,
            grantId: entry.grantId,
            state: "pending",
            updatedAt: startedAt,
        })),
    };

    // Persist before any filesystem mutation.
    await persistJob(job);
    storeSessionTransfer(job, session);
    liveJobs.set(job.id, job);

    // Fire and forget; ALS context re-bound inside runner via session id.
    setImmediate(() => {
        runTransferJob(job).catch(async (error) => {
            job.status = "failed";
            job.failureCode = error.code ?? "IO_ERROR";
            job.failureMessage = error.message;
            job.finishedAt = new Date().toISOString();
            try {
                await persistJob(job);
            } catch {
                // ignore
            }
            liveJobs.delete(job.id);
        });
    });

    return {
        untrusted: true,
        tool: "copy_and_verify_files",
        transferId: job.id,
        status: "running",
        entryCount: job.entryCount,
        estimatedTransferBytes: job.bytesTotal,
        destination: job.destinationPublic,
        complete: job.completeScan,
        preview,
        message:
            "Transfer started. Originals remain untouched. Progress is available in the offload panel.",
        interpretationLimits: [
            "Preparing or copying files does not free internal storage.",
            "Verified means destination content matched the source SHA-256 for that file.",
            "Interrupted or failed files are never treated as verified.",
        ],
    };
}


function cryptoRandomId() {
    return crypto.randomUUID();
}


export function requestCancelTransfer(transferId, session = getActiveSession()) {
    const job = getSessionTransfer(transferId, session);
    if (!job) {
        throw transferError("Unknown transfer.", "UNKNOWN_TRANSFER", 404);
    }

    if (job.sessionId !== session?.id) {
        throw transferError("Unknown transfer.", "UNKNOWN_TRANSFER", 404);
    }

    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "cancelled" ||
        job.status === "interrupted"
    ) {
        return publicTransfer(job);
    }

    job.cancelRequested = true;
    job.status = "cancelling";
    const live = liveJobs.get(job.id);
    if (live) {
        live.cancelRequested = true;
        live.status = "cancelling";
    }

    return publicTransfer(job);
}


export function getPublicTransfer(transferId, session = getActiveSession()) {
    const job = getSessionTransfer(transferId, session);
    if (!job || job.sessionId !== session?.id) {
        return null;
    }
    return publicTransfer(job);
}


export function listPublicTransfers(session = getActiveSession()) {
    return listSessionTransfers(session)
        .filter((job) => job.sessionId === session?.id)
        .map(publicTransfer);
}


export async function requestTransferApprovalContext(manifestId, reason) {
    const args = {
        manifestId,
        reason,
        authorizeHydrateCloudFiles: false,
    };
    const { preview, manifest } = await precheckCopyAndVerifyFiles(args);
    return { args, preview, manifest };
}


function cancelJobsForManifest(session, manifestId, reason) {
    if (!session?.transfers) {
        return;
    }

    for (const job of session.transfers.values()) {
        if (job.manifestId !== manifestId) {
            continue;
        }
        if (
            job.status === "running" ||
            job.status === "starting" ||
            job.status === "cancelling"
        ) {
            job.cancelRequested = true;
            job.status = "cancelling";
            job.failureCode = reason;
            const live = liveJobs.get(job.id);
            if (live) {
                live.cancelRequested = true;
                live.status = "cancelling";
                live.failureCode = reason;
            }
        }
    }
}


function endAllSessionJobs(session, reason) {
    if (!session?.transfers) {
        return;
    }

    for (const job of session.transfers.values()) {
        if (
            job.status === "running" ||
            job.status === "starting" ||
            job.status === "cancelling"
        ) {
            job.cancelRequested = true;
            job.status = "cancelling";
            job.failureCode = reason;
            const live = liveJobs.get(job.id);
            if (live) {
                live.cancelRequested = true;
                live.status = "cancelling";
                live.failureCode = reason;
            }
        }
    }
}


export async function bootstrapTransferRuntime() {
    if (bootstrapped) {
        return;
    }
    bootstrapped = true;
    setTransferSessionHooks({
        endSessionTransfers: endAllSessionJobs,
        cancelTransfersForManifest: cancelJobsForManifest,
    });
    await markUnfinishedJournalsInterrupted();
}


/** Test helpers */
export const _test = {
    capacityMargin,
    finalizationStrategy,
    offloadRootFor,
    looksLikeCloudPath,
    finalizeExclusive,
    hashFile,
    liveJobs,
    publicTransfer,
    persistJob,
    assertManifestIntegrity,
    classifySourcePlaceholder,
};
