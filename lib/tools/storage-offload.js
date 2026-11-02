// =========================================================
// lib/tools/storage-offload.js
//
// Read-only external-drive offload planning and selection lock.
// Never copies, moves, or deletes files.
// =========================================================


import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isPathInsideRoot } from "./path-safety.js";
import {
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_ENTRIES,
    DEFAULT_MAX_MS,
    MAX_SCAN_DEPTH,
    MAX_SCAN_ENTRIES,
    MAX_SCAN_MS,
    NO_SCAN_GRANT_MESSAGE,
    describeProtectedReason,
    isFilesystemRoot,
} from "./storage.js";
import { inspectExternalDrives } from "./windows.js";
import {
    beginSessionScan,
    endSessionScan,
    findGrantForPath,
    getActiveSession,
    getGrantRoots,
    getLastDriveSnapshot,
    getSessionPlan,
    listSessionGrants,
    listSessionPlans,
    setLastDriveSnapshot,
    storeSessionManifest,
    storeSessionPlan,
} from "../storage-session.js";


export const SAFETY_LIKELY_PORTABLE = "likely_portable";
export const SAFETY_REVIEW_REQUIRED = "review_required";
export const SAFETY_EXCLUDED = "excluded";

export const MAX_OFFLOAD_CANDIDATES = 400;
export const DEFAULT_MIN_CANDIDATE_BYTES = 5 * 1024 * 1024;
export const OFFLOAD_FOLDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

const PORTABLE_EXTENSIONS = new Set([
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v",
    ".mp3", ".flac", ".wav", ".aac", ".ogg",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".raw",
    ".zip", ".7z", ".rar", ".tar", ".gz", ".bz2",
    ".iso", ".img",
    ".bak", ".backup", ".vhd", ".vhdx",
]);

const REVIEW_EXTENSIONS = new Set([
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".txt", ".md", ".csv", ".json",
]);

const SENSITIVE_BASENAMES = new Set([
    ".env", ".pem", ".key", "id_rsa", "id_ed25519",
]);

const WINDOWS_RESERVED = new Set([
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;


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


function optionalInteger(args, field, fallback, min, max) {
    if (!(field in args) || args[field] === undefined) {
        return fallback;
    }
    const value = args[field];
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`"${field}" must be an integer.`);
    }
    if (value < min || value > max) {
        throw new Error(`"${field}" must be between ${min} and ${max}.`);
    }
    return value;
}


function normalizeCompare(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


async function lstatSafe(filePath) {
    try {
        return await fs.lstat(filePath);
    } catch {
        return null;
    }
}


function shouldSkipDirectoryName(name) {
    const lower = name.toLowerCase();
    return (
        lower === "windows" ||
        lower === "system32" ||
        lower === "winsxs" ||
        lower === "appdata" ||
        lower === "$recycle.bin" ||
        lower === "system volume information" ||
        lower === "recovery" ||
        lower === ".ssh" ||
        lower === ".gnupg" ||
        lower === "program files" ||
        lower === "program files (x86)" ||
        lower === "programdata" ||
        lower === "node_modules"
    );
}


/**
 * Validate a Windows destination leaf filename.
 * @param {string} name
 * @returns {string|null} error message or null if ok
 */
export function validateDestinationFilename(name) {
    if (typeof name !== "string" || !name.trim()) {
        return "Destination filename is empty.";
    }

    if (name !== name.trim()) {
        return "Destination filename has leading or trailing whitespace.";
    }

    if (/[. ]$/.test(name)) {
        return "Destination filename cannot end with a space or period.";
    }

    if (INVALID_FILENAME_CHARS.test(name)) {
        return "Destination filename contains invalid characters.";
    }

    const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    if (WINDOWS_RESERVED.has(stem.toLowerCase())) {
        return "Destination filename uses a reserved Windows device name.";
    }

    return null;
}


export function sanitizeOffloadFolderName(name) {
    const trimmed = String(name ?? "Offload").trim() || "Offload";
    if (!OFFLOAD_FOLDER_NAME_PATTERN.test(trimmed)) {
        throw new Error(
            '"destinationFolderName" must be a short safe folder name.',
        );
    }
    return trimmed;
}


/**
 * Classify a candidate. Age/extension/location are heuristics only —
 * never proof the file is unused.
 */
export function classifyOffloadCandidate(entry) {
    const concerns = [];
    const basename = path.basename(entry.sourcePath);
    const ext = path.extname(basename).toLowerCase();
    const lowerName = basename.toLowerCase();

    if (
        SENSITIVE_BASENAMES.has(lowerName) ||
        lowerName.endsWith(".pem") ||
        lowerName.endsWith(".key") ||
        lowerName.startsWith(".env")
    ) {
        return {
            safety: SAFETY_EXCLUDED,
            dependencyConcerns: ["sensitive_filename"],
            concerns: ["Sensitive filenames are excluded from offload proposals."],
        };
    }

    const protectedReason = describeProtectedReason(entry.sourcePath);
    if (protectedReason) {
        return {
            safety: SAFETY_EXCLUDED,
            dependencyConcerns: ["protected_location"],
            concerns: [protectedReason],
        };
    }

    const labRoot = normalizeCompare(process.cwd());
    const sourceNorm = normalizeCompare(entry.sourcePath);
    if (sourceNorm === labRoot || sourceNorm.startsWith(`${labRoot}${path.sep}`)) {
        return {
            safety: SAFETY_EXCLUDED,
            dependencyConcerns: ["local_ai_lab_directory"],
            concerns: [
                "Files inside the Local AI Lab application directory are excluded.",
            ],
        };
    }

    if (entry.mtimeMs != null) {
        const ageDays = (Date.now() - entry.mtimeMs) / (24 * 60 * 60 * 1000);
        if (Number.isFinite(ageDays) && ageDays > 365) {
            concerns.push(
                "File is older than one year. Age alone does not mean it is unused.",
            );
        }
    }

    if (entry.inUse === true) {
        return {
            safety: SAFETY_REVIEW_REQUIRED,
            dependencyConcerns: ["running_process_image"],
            concerns: [
                ...concerns,
                "A process appears to use this file path. Do not treat it as unused.",
            ],
        };
    }

    if (PORTABLE_EXTENSIONS.has(ext) || (entry.sizeBytes ?? 0) >= 50 * 1024 * 1024) {
        concerns.push(
            "Heuristic: media, archive, backup extension, or large size. Not proof of unused.",
        );
        return {
            safety: SAFETY_LIKELY_PORTABLE,
            dependencyConcerns: entry.inUse === null ? ["unverified"] : [],
            concerns,
        };
    }

    if (REVIEW_EXTENSIONS.has(ext)) {
        concerns.push("Document-like file. Confirm it is not needed before copying.");
    } else {
        concerns.push("Unrecognized type. Manual review required.");
    }

    return {
        safety: SAFETY_REVIEW_REQUIRED,
        dependencyConcerns: entry.inUse === null ? ["unverified"] : [],
        concerns,
    };
}


function buildDestinationPath(mount, folderName, relativePath) {
    const mountRoot = mount.endsWith("\\") || mount.endsWith("/")
        ? mount
        : `${mount}\\`;
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    return path.join(mountRoot, "LocalAI-Offload", folderName, ...parts);
}


function detectDestinationConflicts(entries) {
    const byLower = new Map();
    const conflicts = [];

    for (const entry of entries) {
        if (entry.safety === SAFETY_EXCLUDED) {
            continue;
        }

        const filenameError = validateDestinationFilename(
            path.basename(entry.destinationPath),
        );
        if (filenameError) {
            entry.destinationConflict = filenameError;
            entry.safety = SAFETY_EXCLUDED;
            entry.dependencyConcerns = [
                ...(entry.dependencyConcerns ?? []),
                "invalid_destination_filename",
            ];
            conflicts.push({
                entryId: entry.id,
                reason: filenameError,
            });
            continue;
        }

        const key = normalizeCompare(entry.destinationPath);
        if (byLower.has(key)) {
            const other = byLower.get(key);
            const reason =
                "Duplicate or case-insensitive destination path collision.";
            entry.destinationConflict = reason;
            other.destinationConflict = reason;
            entry.safety = SAFETY_EXCLUDED;
            other.safety = SAFETY_EXCLUDED;
            conflicts.push({
                entryId: entry.id,
                reason,
                otherEntryId: other.id,
            });
        } else {
            byLower.set(key, entry);
        }
    }

    return conflicts;
}


async function collectFilesUnderGrant(grant, options, signal, state) {
    const {
        maxDepth,
        maxEntries,
        maxMs,
        minBytes,
        started,
    } = options;

    async function walk(directory, depth, grantRoot) {
        if (signal.aborted) {
            state.cancelled = true;
            state.truncated = true;
            state.limit = "cancelled";
            return;
        }

        if (Date.now() - started > maxMs) {
            state.timedOut = true;
            state.truncated = true;
            state.limit = "time";
            return;
        }

        if (state.filesVisited + state.directoriesVisited >= maxEntries) {
            state.truncated = true;
            state.limit = "entries";
            return;
        }

        if (state.files.length >= MAX_OFFLOAD_CANDIDATES) {
            state.truncated = true;
            state.limit = "candidates";
            return;
        }

        let dirents;
        try {
            dirents = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }

        state.directoriesVisited += 1;

        for (const dirent of dirents) {
            if (signal.aborted) {
                state.cancelled = true;
                state.truncated = true;
                state.limit = "cancelled";
                return;
            }

            if (Date.now() - started > maxMs) {
                state.timedOut = true;
                state.truncated = true;
                state.limit = "time";
                return;
            }

            if (state.filesVisited + state.directoriesVisited >= maxEntries) {
                state.truncated = true;
                state.limit = "entries";
                return;
            }

            if (state.files.length >= MAX_OFFLOAD_CANDIDATES) {
                state.truncated = true;
                state.limit = "candidates";
                return;
            }

            if (dirent.isSymbolicLink()) {
                continue;
            }

            const absolute = path.join(directory, dirent.name);

            if (dirent.isDirectory()) {
                if (shouldSkipDirectoryName(dirent.name)) {
                    continue;
                }

                if (depth >= maxDepth) {
                    state.truncated = true;
                    state.limit = state.limit ?? "depth";
                    continue;
                }

                let realChild;
                try {
                    const childStats = await fs.lstat(absolute);
                    if (childStats.isSymbolicLink()) {
                        continue;
                    }
                    realChild = await fs.realpath(absolute);
                } catch {
                    continue;
                }

                if (!isPathInsideRoot(realChild, grantRoot)) {
                    throw new Error("Symbolic links are not allowed.");
                }

                await walk(realChild, depth + 1, grantRoot);
                continue;
            }

            if (!dirent.isFile()) {
                continue;
            }

            const stats = await lstatSafe(absolute);
            if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
                continue;
            }

            state.filesVisited += 1;
            const size = Number.isFinite(stats.size) ? stats.size : 0;

            if (size < minBytes) {
                continue;
            }

            let realFile;
            try {
                realFile = await fs.realpath(absolute);
            } catch {
                continue;
            }

            if (!isPathInsideRoot(realFile, grantRoot)) {
                continue;
            }

            const relativePath = path.relative(grantRoot, realFile);
            if (!relativePath || relativePath.startsWith("..")) {
                continue;
            }

            state.files.push({
                sourcePath: realFile,
                relativePath,
                grantId: grant.id,
                grantPath: grant.path,
                sizeBytes: size,
                mtimeMs: stats.mtimeMs,
                mtime: stats.mtime.toISOString(),
                inUse: null,
            });
        }
    }

    await walk(grant.realPath, 0, grant.realPath);
}


function findDestinationVolume(volumes, destinationVolumeId) {
    const match = volumes.find((volume) => volume.volumeId === destinationVolumeId);
    if (!match) {
        return null;
    }
    return match;
}


function assertEligibleDestination(volume) {
    if (!volume) {
        throw Object.assign(
            new Error("Unknown destination volume. Inspect external drives again."),
            { code: "UNKNOWN_VOLUME", status: 400 },
        );
    }

    if (volume.identityConfidence === "low" || !volume.volumeId) {
        throw Object.assign(
            new Error(
                "That volume lacks a stable identity. Reconnect it and inspect drives again.",
            ),
            { code: "AMBIGUOUS_VOLUME", status: 400 },
        );
    }

    if (
        volume.classification !== "external" &&
        volume.classification !== "removable"
    ) {
        throw Object.assign(
            new Error(
                "Destination must be an external or removable volume. " +
                    `This volume is classified as ${volume.classification}.`,
            ),
            { code: "INTERNAL_DESTINATION", status: 400 },
        );
    }

    if (isFilesystemRoot(volume.mount) === false) {
        // mount should be a volume root like E:\
    }

    return volume;
}


export function validatePlanStorageOffload(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, [
        "destinationVolumeId",
        "destinationFolderName",
        "sources",
        "minBytes",
        "maxDepth",
        "maxEntries",
        "maxMs",
    ]);

    const validated = {
        destinationVolumeId: requireString(args, "destinationVolumeId", 512),
        destinationFolderName: sanitizeOffloadFolderName(
            args.destinationFolderName ?? "Offload",
        ),
        minBytes: optionalInteger(
            args,
            "minBytes",
            DEFAULT_MIN_CANDIDATE_BYTES,
            0,
            10 * 1024 * 1024 * 1024,
        ),
        maxDepth: optionalInteger(args, "maxDepth", DEFAULT_MAX_DEPTH, 0, MAX_SCAN_DEPTH),
        maxEntries: optionalInteger(
            args,
            "maxEntries",
            DEFAULT_MAX_ENTRIES,
            1,
            MAX_SCAN_ENTRIES,
        ),
        maxMs: optionalInteger(args, "maxMs", DEFAULT_MAX_MS, 1_000, MAX_SCAN_MS),
    };

    if ("sources" in args && args.sources !== undefined) {
        if (!Array.isArray(args.sources) || args.sources.length === 0) {
            throw new Error('"sources" must be a non-empty array of granted paths.');
        }
        validated.sources = args.sources.map((item, index) => {
            if (typeof item !== "string" || !item.trim()) {
                throw new Error(`"sources[${index}]" must be a non-empty string.`);
            }
            return item.trim();
        });
    }

    return validated;
}


export function validateInspectExternalDrivesArgs(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }
    rejectUnknownKeys(args, []);
    return {};
}


export async function refreshDriveSnapshot() {
    const result = await inspectExternalDrives({});
    setLastDriveSnapshot(result);
    return result;
}


export async function planStorageOffload(args) {
    const validated = validatePlanStorageOffload(args ?? {});
    const grants = listSessionGrants();

    if (grants.length === 0) {
        throw Object.assign(new Error(NO_SCAN_GRANT_MESSAGE), {
            code: "NO_GRANT",
        });
    }

    let snapshot = getLastDriveSnapshot();
    if (!snapshot?.volumes) {
        snapshot = await refreshDriveSnapshot();
    }

    const volume = assertEligibleDestination(
        findDestinationVolume(snapshot.volumes, validated.destinationVolumeId),
    );

    const sourcePaths = validated.sources ?? grants.map((grant) => grant.path);
    const grantRoots = getGrantRoots();
    const started = Date.now();
    const signal = beginSessionScan();
    const state = {
        files: [],
        filesVisited: 0,
        directoriesVisited: 0,
        truncated: false,
        timedOut: false,
        cancelled: false,
        limit: null,
    };

    const usedGrantIds = new Set();

    try {
        for (const sourcePath of sourcePaths) {
            const grant = findGrantForPath(sourcePath);
            if (!grant) {
                throw Object.assign(
                    new Error(
                        `Source is not in the current scan session: ${sourcePath}`,
                    ),
                    { code: "NO_GRANT" },
                );
            }

            usedGrantIds.add(grant.id);

            await collectFilesUnderGrant(
                grant,
                {
                    maxDepth: validated.maxDepth,
                    maxEntries: validated.maxEntries,
                    maxMs: validated.maxMs,
                    minBytes: validated.minBytes,
                    started,
                },
                signal,
                state,
            );

            if (state.truncated || state.timedOut || state.cancelled) {
                break;
            }
        }
    } finally {
        endSessionScan();
    }

    const entries = [];

    for (const file of state.files) {
        const destinationPath = buildDestinationPath(
            volume.mount,
            validated.destinationFolderName,
            file.relativePath,
        );

        const classified = classifyOffloadCandidate(file);
        const entry = {
            id: `off_${crypto.randomBytes(12).toString("hex")}`,
            sourcePath: file.sourcePath,
            relativePath: file.relativePath,
            destinationPath,
            sizeBytes: file.sizeBytes,
            mtime: file.mtime,
            mtimeMs: file.mtimeMs,
            grantId: file.grantId,
            safety: classified.safety,
            dependencyConcerns: classified.dependencyConcerns,
            concerns: classified.concerns,
            destinationConflict: null,
            selectable: classified.safety !== SAFETY_EXCLUDED,
        };
        entries.push(entry);
    }

    const conflicts = detectDestinationConflicts(entries);
    for (const entry of entries) {
        entry.selectable = entry.safety !== SAFETY_EXCLUDED;
    }

    const complete = !state.truncated && !state.timedOut && !state.cancelled;
    const selectable = entries.filter((entry) => entry.selectable);
    const estimatedTransferBytes = selectable.reduce(
        (sum, entry) => sum + (entry.sizeBytes ?? 0),
        0,
    );

    const plan = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        sessionId: getActiveSession()?.id ?? null,
        destination: {
            volumeId: volume.volumeId,
            mount: volume.mount,
            label: volume.label,
            fileSystem: volume.fileSystem,
            freeBytes: volume.freeBytes,
            totalBytes: volume.totalBytes,
            classification: volume.classification,
            identityConfidence: volume.identityConfidence,
            volumeSerialNumber: volume.volumeSerialNumber,
            diskUniqueId: volume.diskUniqueId,
            folderName: validated.destinationFolderName,
        },
        grantIds: [...usedGrantIds],
        complete,
        incomplete: complete
            ? null
            : {
                  truncated: state.truncated,
                  timedOut: state.timedOut,
                  cancelled: state.cancelled,
                  limit: state.limit,
              },
        filesVisited: state.filesVisited,
        directoriesVisited: state.directoriesVisited,
        candidateCount: entries.length,
        selectableCount: selectable.length,
        estimatedTransferBytes,
        potentialRecoverableBytesAfterVerifiedRemoval: estimatedTransferBytes,
        estimatesNote:
            "Preparing or copying files does not free internal storage. " +
            "potentialRecoverableBytesAfterVerifiedRemoval is only available after a " +
            "future verified source-removal step, which is not implemented yet.",
        conflicts,
        entries,
        invalidated: false,
        invalidReason: null,
    };

    if (
        volume.freeBytes != null &&
        estimatedTransferBytes > volume.freeBytes
    ) {
        plan.destinationCapacityWarning =
            "Estimated transfer size exceeds reported free space on the destination.";
    }

    storeSessionPlan(plan);

    return {
        untrusted: true,
        tool: "plan_storage_offload",
        planId: plan.id,
        complete: plan.complete,
        incomplete: plan.incomplete,
        destination: plan.destination,
        candidateCount: plan.candidateCount,
        selectableCount: plan.selectableCount,
        estimatedTransferBytes: plan.estimatedTransferBytes,
        potentialRecoverableBytesAfterVerifiedRemoval:
            plan.potentialRecoverableBytesAfterVerifiedRemoval,
        estimatesNote: plan.estimatesNote,
        destinationCapacityWarning: plan.destinationCapacityWarning ?? null,
        conflicts: plan.conflicts,
        entries: plan.entries.map(publicPlanEntry),
        interpretationLimits: [
            "likely_portable is a heuristic, not proof a file is unused or safe to move.",
            "review_required means the user must decide; do not auto-select these as safe.",
            "excluded entries cannot be selected into a transfer manifest.",
            "complete=false means discovery was partial; do not treat the plan as exhaustive.",
            "Copying is not available in this milestone. The user must review and select files in the UI.",
        ],
    };
}


function publicPlanEntry(entry) {
    return {
        id: entry.id,
        sourcePath: entry.sourcePath,
        destinationPath: entry.destinationPath,
        relativePath: entry.relativePath,
        sizeBytes: entry.sizeBytes,
        mtime: entry.mtime,
        safety: entry.safety,
        dependencyConcerns: entry.dependencyConcerns,
        concerns: entry.concerns,
        destinationConflict: entry.destinationConflict,
        selectable: entry.selectable,
        grantId: entry.grantId,
    };
}


export function publicPlanSummary(plan) {
    if (!plan) {
        return null;
    }

    return {
        id: plan.id,
        createdAt: plan.createdAt,
        complete: plan.complete,
        incomplete: plan.incomplete,
        destination: plan.destination,
        candidateCount: plan.candidateCount,
        selectableCount: plan.selectableCount,
        estimatedTransferBytes: plan.estimatedTransferBytes,
        potentialRecoverableBytesAfterVerifiedRemoval:
            plan.potentialRecoverableBytesAfterVerifiedRemoval,
        estimatesNote: plan.estimatesNote,
        destinationCapacityWarning: plan.destinationCapacityWarning ?? null,
        conflicts: plan.conflicts,
        invalidated: plan.invalidated === true,
        invalidReason: plan.invalidReason,
        entries: (plan.entries ?? []).map(publicPlanEntry),
        lockedManifestId: plan.lockedManifestId ?? null,
    };
}


function canonicalManifestPayload(plan, selectedEntries) {
    return {
        planId: plan.id,
        complete: plan.complete,
        incomplete: plan.incomplete,
        destination: {
            volumeId: plan.destination.volumeId,
            volumeSerialNumber: plan.destination.volumeSerialNumber,
            diskUniqueId: plan.destination.diskUniqueId,
            mount: plan.destination.mount,
            folderName: plan.destination.folderName,
        },
        entries: selectedEntries
            .map((entry) => ({
                id: entry.id,
                sourcePath: entry.sourcePath,
                destinationPath: entry.destinationPath,
                sizeBytes: entry.sizeBytes,
                mtime: entry.mtime,
                safety: entry.safety,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
    };
}


/**
 * Lock an immutable manifest from exact plan entry IDs submitted by the user.
 */
export function lockManifestFromSelection(planId, entryIds) {
    if (typeof planId !== "string" || !planId.trim()) {
        throw Object.assign(new Error("planId is required."), { status: 400 });
    }

    if (!Array.isArray(entryIds) || entryIds.length === 0) {
        throw Object.assign(
            new Error("Select at least one file entry id."),
            { status: 400 },
        );
    }

    const plan = getSessionPlan(planId.trim());
    if (!plan) {
        throw Object.assign(new Error("Unknown storage plan."), { status: 404 });
    }

    if (plan.invalidated) {
        throw Object.assign(
            new Error(plan.invalidReason || "That plan is no longer valid."),
            { status: 409 },
        );
    }

    const session = getActiveSession();
    if (plan.sessionId && session && plan.sessionId !== session.id) {
        throw Object.assign(new Error("Unknown storage plan."), { status: 404 });
    }

    const seen = new Set();
    for (const id of entryIds) {
        if (typeof id !== "string" || !id.trim()) {
            throw Object.assign(new Error("Invalid entry id."), { status: 400 });
        }
        if (seen.has(id)) {
            throw Object.assign(
                new Error("Duplicate entry ids are not allowed."),
                { status: 400 },
            );
        }
        seen.add(id);
    }

    const byId = new Map((plan.entries ?? []).map((entry) => [entry.id, entry]));
    const selected = [];

    for (const id of entryIds) {
        const entry = byId.get(id);
        if (!entry) {
            throw Object.assign(
                new Error(`Unknown or stale plan entry: ${id}`),
                { status: 400 },
            );
        }

        if (entry.safety === SAFETY_EXCLUDED || entry.selectable === false) {
            throw Object.assign(
                new Error(`Excluded entry cannot be selected: ${id}`),
                { status: 400 },
            );
        }

        const grant = findGrantForPath(entry.sourcePath);
        if (!grant || grant.id !== entry.grantId) {
            throw Object.assign(
                new Error(
                    "A selected source is no longer authorized by a scan grant.",
                ),
                { status: 409 },
            );
        }

        selected.push(entry);
    }

    const conflicts = detectDestinationConflicts(
        selected.map((entry) => ({ ...entry })),
    );
    if (conflicts.length > 0) {
        throw Object.assign(
            new Error("Selected files have unresolved destination conflicts."),
            { status: 400 },
        );
    }

    const canonical = canonicalManifestPayload(plan, selected);
    const hash = crypto
        .createHash("sha256")
        .update(JSON.stringify(canonical))
        .digest("hex");

    const estimatedTransferBytes = selected.reduce(
        (sum, entry) => sum + (entry.sizeBytes ?? 0),
        0,
    );

    const manifest = {
        id: crypto.randomUUID(),
        planId: plan.id,
        sessionId: session?.id ?? plan.sessionId,
        createdAt: new Date().toISOString(),
        hash,
        complete: plan.complete,
        incomplete: plan.incomplete,
        destination: { ...plan.destination },
        entryIds: selected.map((entry) => entry.id),
        entries: selected.map(publicPlanEntry),
        estimatedTransferBytes,
        potentialRecoverableBytesAfterVerifiedRemoval: estimatedTransferBytes,
        estimatesNote: plan.estimatesNote,
        invalidated: false,
        invalidReason: null,
        immutable: true,
    };

    storeSessionManifest(manifest);
    plan.lockedManifestId = manifest.id;
    storeSessionPlan(plan);

    return {
        manifestId: manifest.id,
        hash: manifest.hash,
        planId: plan.id,
        complete: manifest.complete,
        incomplete: manifest.incomplete,
        entryCount: manifest.entries.length,
        estimatedTransferBytes: manifest.estimatedTransferBytes,
        potentialRecoverableBytesAfterVerifiedRemoval:
            manifest.potentialRecoverableBytesAfterVerifiedRemoval,
        estimatesNote: manifest.estimatesNote,
        destination: manifest.destination,
        entries: manifest.entries,
        copyAvailable: false,
        message:
            "Selection locked. Copy and verification are not enabled in this milestone.",
    };
}


export function listPublicPlans() {
    return listSessionPlans().map(publicPlanSummary);
}


export function getPublicPlan(planId) {
    return publicPlanSummary(getSessionPlan(planId));
}


/** Test helpers */
export const _test = {
    buildDestinationPath,
    detectDestinationConflicts,
    canonicalManifestPayload,
};
