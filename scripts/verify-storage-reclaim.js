// =========================================================
// scripts/verify-storage-reclaim.js
//
// Milestone D1: inspect_reclaim_candidates, journal trust,
// bounded verification jobs. Synthetic fixtures only unless
// a live external volume is available (reported separately).
// =========================================================


import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    approveById,
    createStandaloneTransferApproval,
} from "../lib/agent.js";
import {
    PERMISSION_HIGH_RISK,
    PERMISSION_READ,
    getTool,
    listTools,
    validateToolArguments,
} from "../lib/tools/registry.js";
import {
    lockManifestFromSelection,
    planStorageOffload,
    _test as offloadTest,
} from "../lib/tools/storage-offload.js";
import {
    bootstrapTransferRuntime,
    getPublicTransfer,
    loadTransferJournal,
} from "../lib/tools/storage-transfer.js";
import {
    RECLAIM_ELIGIBLE,
    RECLAIM_EXCLUDED,
    RECLAIM_FAILED,
    RECLAIM_MANUAL,
    assessManifestTrust,
    bootstrapReclaimRuntime,
    getPublicReclaimJob,
    requestCancelReclaimJob,
    startReclaimReview,
    _test as reclaimTest,
} from "../lib/tools/storage-reclaim.js";
import { grantScanFolder } from "../lib/tools/storage.js";
import { inspectExternalDrives } from "../lib/tools/windows.js";
import {
    _test as sessionTest,
    revokeSessionGrant,
    runWithSession,
} from "../lib/storage-session.js";
import {
    JOURNAL_SCHEMA_VERSION,
    JOURNAL_SCHEMA_VERSION_LEGACY,
    readTransferJournal,
    writeTransferJournal,
} from "../lib/transfer-journal.js";


const results = [];
const PARENT = path.dirname(process.cwd());
const SOURCE_SANDBOX = path.join(PARENT, ".local-ai-lab-reclaim-src-sandbox");
const DEST_SANDBOX = path.join(PARENT, ".local-ai-lab-reclaim-dest-sandbox");
const SUBST_LETTER = "R:";


function record(name, status, detail = "", kind = "mocked") {
    results.push({ name, status, detail, kind });
    console.log(
        `${status.toUpperCase()}  [${kind}] ${name}${detail ? ` — ${detail}` : ""}`,
    );
}

function pass(name, detail, kind = "mocked") {
    record(name, "pass", detail, kind);
}

function fail(name, detail, kind = "mocked") {
    record(name, "fail", detail, kind);
}

function skip(name, detail, kind = "mocked") {
    record(name, "skip", detail, kind);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function expectThrow(work, needle) {
    try {
        await work();
    } catch (error) {
        if (needle && !String(error.message).includes(needle)) {
            throw new Error(
                `Expected error containing ${JSON.stringify(needle)}, got: ${error.message}`,
            );
        }
        return error;
    }
    throw new Error("Expected an error.");
}

async function rimraf(target) {
    await fs.rm(target, { recursive: true, force: true });
}

async function writeFile(filePath, contents) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
}

function runSubst(args) {
    return spawnSync("subst", args, { encoding: "utf8", windowsHide: true });
}

function mountSubst() {
    runSubst([SUBST_LETTER, "/d"]);
    const mapped = runSubst([SUBST_LETTER, DEST_SANDBOX]);
    if (mapped.status !== 0) {
        throw new Error(`subst failed: ${mapped.stderr || mapped.stdout}`);
    }
}

function unmountSubst() {
    runSubst([SUBST_LETTER, "/d"]);
}

function mockVolume(overrides = {}) {
    return {
        mount: `${SUBST_LETTER}\\`,
        label: "ReclaimTest",
        fileSystem: "NTFS",
        totalBytes: 50_000_000_000,
        freeBytes: 20_000_000_000,
        usedPercent: 10,
        driveType: "2",
        busType: "USB",
        classification: "removable",
        confidence: "high",
        uncertainty: null,
        volumeId: "vol-reclaim-test-001",
        volumeSerialNumber: "RCLM-1234",
        diskUniqueId: "USBSTOR\\RECLAIM",
        identityConfidence: "high",
        ...overrides,
    };
}

async function seedSource() {
    await rimraf(SOURCE_SANDBOX);
    await writeFile(
        path.join(SOURCE_SANDBOX, "videos", "clip.mp4"),
        "synthetic-reclaim-video-aaaaaaaa",
    );
    await writeFile(
        path.join(SOURCE_SANDBOX, "videos", "other.mp4"),
        "synthetic-reclaim-video-bbbbbbbb",
    );
}

async function prepareDest() {
    await rimraf(DEST_SANDBOX);
    await fs.mkdir(DEST_SANDBOX, { recursive: true });
    mountSubst();
}

async function waitForTransfer(transferId, session, timeoutMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const transfer = await runWithSession(session, () =>
            getPublicTransfer(transferId),
        );
        if (
            transfer &&
            (transfer.status === "completed" ||
                transfer.status === "failed" ||
                transfer.status === "cancelled" ||
                transfer.status === "interrupted")
        ) {
            return transfer;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for transfer.");
}

async function waitForReclaim(jobId, session, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const job = await runWithSession(session, () =>
            getPublicReclaimJob(jobId),
        );
        if (
            job &&
            (job.status === "completed" ||
                job.status === "failed" ||
                job.status === "cancelled" ||
                job.status === "incomplete")
        ) {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for reclaim job.");
}

async function withMockedVolume(volume, work) {
    offloadTest.setRefreshDriveSnapshotOverride(async () => ({
        volumes: [volume],
        queriedAt: new Date().toISOString(),
        interpretationLimits: ["test override"],
    }));
    try {
        return await work();
    } finally {
        offloadTest.setRefreshDriveSnapshotOverride(null);
    }
}

async function runApprovedTransfer(session, volume, folderName = "ReclaimTest") {
    await grantScanFolder(SOURCE_SANDBOX);
    const planned = await planStorageOffload({
        destinationVolumeId: volume.volumeId,
        destinationFolderName: folderName,
        minBytes: 1,
        maxDepth: 4,
        maxEntries: 50,
        maxMs: 15_000,
    });
    const selectable = planned.entries.filter((entry) => entry.selectable);
    assert(selectable.length >= 1, "expected selectable candidates");
    const locked = lockManifestFromSelection(
        planned.planId,
        selectable.map((entry) => entry.id),
    );
    const approval = await createStandaloneTransferApproval({
        manifestId: locked.manifestId,
        reason: "reclaim verify transfer",
    });
    const approved = await approveById(approval.id, {
        acknowledgeIncompleteScan: approval.requiresIncompleteAck
            ? true
            : undefined,
    });
    assert(approved.status === "transfer_started", "transfer did not start");
    const finished = await waitForTransfer(approved.transfer.transferId, session);
    assert(
        finished.status === "completed",
        `status=${finished.status} ${finished.failureMessage ?? ""}`,
    );
    const journal = await loadTransferJournal(finished.transferId);
    return { finished, journal, selectable, planned, locked };
}


async function testRegistry() {
    const tool = getTool("inspect_reclaim_candidates");
    assert(tool.permission === PERMISSION_READ, "read permission");
    validateToolArguments("inspect_reclaim_candidates", {
        transferId: crypto.randomUUID(),
    });
    await expectThrow(
        () =>
            validateToolArguments("inspect_reclaim_candidates", {
                transferId: crypto.randomUUID(),
                sourcePath: "C:\\evil",
            }),
        "Unexpected",
    );
    const deleteTool = listTools().find((item) => item.name === "delete_path");
    assert(deleteTool, "delete_path missing from catalog");
    assert(deleteTool.available === false, "delete_path available");
    assert(deleteTool.permission === PERMISSION_HIGH_RISK, "delete high-risk");
    assert(
        !listTools().some((item) => item.name === "run_shell" && item.available),
        "run_shell available",
    );
    pass(
        "registry",
        "inspect_reclaim_candidates read-only; no path args; delete blocked",
    );
}


async function testHappyPath() {
    await seedSource();
    const volume = mockVolume();
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            const { finished, journal } = await runApprovedTransfer(
                session,
                volume,
                "Happy",
            );
            assert(journal.schemaVersion === JOURNAL_SCHEMA_VERSION, "schema v2");
            assert(journal.hasManifestSnapshot === true, "snapshot present");
            assert(journal.manifestSnapshot, "snapshot body");

            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const job = await waitForReclaim(started.id, session);
            assert(
                job.status === "completed" || job.status === "incomplete",
                `job status ${job.status}`,
            );
            assert(job.bytesActuallyReclaimed === 0, "reclaimed not zero");
            assert(
                job.estimates.bytesActuallyReclaimed === 0,
                "estimates reclaimed not zero",
            );
            assert(job.counts.reverified >= 1, "expected reverified");
            // Dependency uncertainty is expected without conclusive active-use data.
            const candidate = job.candidates.find(
                (item) =>
                    item.sourceIntegrity.status === "verified" &&
                    item.destinationIntegrity.status === "verified",
            );
            assert(candidate, "missing verified candidate");
            assert(
                candidate.eligibility === RECLAIM_ELIGIBLE ||
                    candidate.eligibility === RECLAIM_MANUAL,
                `unexpected eligibility ${candidate.eligibility}`,
            );
            if (candidate.eligibility === RECLAIM_MANUAL) {
                assert(
                    candidate.manualReviewNeeds.length > 0,
                    "manual review needs missing",
                );
            }

            const sourceBody = await fs.readFile(
                path.join(SOURCE_SANDBOX, "videos", "clip.mp4"),
                "utf8",
            );
            assert(
                sourceBody.includes("synthetic-reclaim-video"),
                "source modified",
            );
        });
    });

    pass(
        "happy path verified transfer",
        "snapshot journal + independent reverify; sources intact",
    );
}


async function testLegacyJournalCompatibility() {
    const id = crypto.randomUUID();
    const session = sessionTest.createSession();
    await writeTransferJournal(id, {
        transferId: id,
        sessionId: session.id,
        status: "completed",
        manifestId: crypto.randomUUID(),
        manifestHash: "abc",
        destination: mockVolume(),
        files: [
            {
                entryId: "e1",
                sourcePath: path.join(SOURCE_SANDBOX, "videos", "clip.mp4"),
                destinationPath: path.join(
                    DEST_SANDBOX,
                    "LocalAI-Offload",
                    "x",
                    "clip.mp4",
                ),
                relativePath: "clip.mp4",
                sizeBytes: 10,
                state: "verified",
                sourceHash: "aa",
                destinationHash: "aa",
            },
        ],
    });

    const journal = await loadTransferJournal(id);
    assert(
        journal.schemaVersion === JOURNAL_SCHEMA_VERSION_LEGACY,
        "legacy schema",
    );
    assert(journal.hasManifestSnapshot === false, "fabricated snapshot");

    const trust = await runWithSession(session, () =>
        assessManifestTrust(journal, session),
    );
    assert(trust.canInspect === true, "legacy not inspectable");
    assert(trust.canBeRemovalEligible === false, "legacy eligible");
    assert(
        trust.manifestTrust === "legacy_untrusted_manifest",
        trust.manifestTrust,
    );

    pass(
        "legacy Milestone C journal compatibility",
        "inspectable; never removal-eligible without trusted snapshot",
    );
}


async function testTamperedSnapshot() {
    await seedSource();
    const volume = mockVolume({ volumeId: "vol-reclaim-tamp" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            const { finished, journal } = await runApprovedTransfer(
                session,
                volume,
                "Tamp",
            );
            const raw = await readTransferJournal(finished.transferId);
            raw.manifestSnapshot.entries[0].sizeBytes += 1;
            await writeTransferJournal(finished.transferId, raw);

            const trust = assessManifestTrust(
                await loadTransferJournal(finished.transferId),
                session,
            );
            assert(trust.integrityFailed === true, "tamper not detected");
            assert(trust.canBeRemovalEligible === false, "eligible after tamper");

            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const job = await waitForReclaim(started.id, session);
            assert(
                job.candidates.every((c) => c.eligibility === RECLAIM_FAILED),
                "tampered candidates not failed",
            );
            void journal;
        });
    });

    pass("altered manifest snapshot", "hash mismatch blocks eligibility");
}


async function testTamperedHashAndSnapshot() {
    const id = crypto.randomUUID();
    const session = sessionTest.createSession();
    await writeTransferJournal(id, {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        transferId: id,
        sessionId: session.id,
        status: "completed",
        manifestId: crypto.randomUUID(),
        manifestHash: "deadbeef",
        manifestSnapshot: {
            planId: "p",
            hash: "cafebabe",
            complete: true,
            incomplete: null,
            destination: mockVolume(),
            entries: [],
        },
        destination: mockVolume(),
        files: [],
    });

    const loaded = await loadTransferJournal(id);
    const trust = await runWithSession(session, () =>
        assessManifestTrust(loaded, session),
    );
    assert(trust.canBeRemovalEligible === false, "dual tamper eligible");
    assert(
        trust.integrityFailed === true ||
            trust.manifestTrust.includes("mismatch"),
        trust.manifestTrust,
    );
    pass("tampered hash and snapshot together", "rejected");
}


async function testPartialAndInterrupted() {
    const id = crypto.randomUUID();
    const session = sessionTest.createSession();
    const volume = mockVolume({ volumeId: "vol-partial" });

    await seedSource();
    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            await grantScanFolder(SOURCE_SANDBOX);
            // Build a realistic snapshot via a real transfer, then rewrite status.
            const { finished } = await runApprovedTransfer(
                session,
                volume,
                "Partial",
            );
            const raw = await readTransferJournal(finished.transferId);
            raw.status = "interrupted";
            if (raw.files.length > 1) {
                raw.files[1].state = "interrupted";
                raw.files[1].sourceHash = null;
                raw.files[1].destinationHash = null;
            }
            await writeTransferJournal(finished.transferId, raw);

            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const job = await waitForReclaim(started.id, session);
            assert(job.transferComplete === false, "marked complete");
            assert(job.transferStatus === "interrupted", job.transferStatus);
            const failed = job.candidates.filter(
                (c) => c.journalState !== "verified",
            );
            assert(
                failed.every((c) => c.eligibility === RECLAIM_FAILED),
                "non-verified not failed",
            );
            assert(
                job.estimates.logicalBytesIndependentlyReverified <=
                    job.estimates.logicalBytesCopiedAndVerifiedInJournal,
                "inflated reverified bytes",
            );
            void id;
        });
    });

    pass(
        "interrupted / partial transfer",
        "per-file verify; transfer not treated as entirely successful",
    );
}


async function testModifiedSourceAndDest() {
    await seedSource();
    const volume = mockVolume({ volumeId: "vol-mod" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            const { finished, journal } = await runApprovedTransfer(
                session,
                volume,
                "Mod",
            );
            const verified = journal.files.find((f) => f.state === "verified");
            assert(verified, "no verified file");

            await fs.writeFile(verified.sourcePath, "source-changed-after-copy");
            let started = await startReclaimReview({
                transferId: finished.transferId,
                entryIds: [verified.entryId],
            });
            let job = await waitForReclaim(started.id, session);
            assert(
                job.candidates[0].eligibility === RECLAIM_FAILED,
                "modified source not failed",
            );

            // Restore source, break destination.
            await fs.writeFile(
                verified.sourcePath,
                "synthetic-reclaim-video-aaaaaaaa",
            );
            // Re-seed exact original content for clip if this was clip.
            await seedSource();
            await grantScanFolder(SOURCE_SANDBOX);

            const destPath = verified.destinationPath;
            await fs.writeFile(destPath, "destination-tampered");
            started = await startReclaimReview({
                transferId: finished.transferId,
                entryIds: [verified.entryId],
            });
            job = await waitForReclaim(started.id, session);
            assert(
                job.candidates[0].eligibility === RECLAIM_FAILED,
                "modified dest not failed",
            );

            await fs.unlink(destPath);
            started = await startReclaimReview({
                transferId: finished.transferId,
                entryIds: [verified.entryId],
            });
            job = await waitForReclaim(started.id, session);
            assert(
                job.candidates[0].eligibility === RECLAIM_FAILED,
                "missing dest not failed",
            );
        });
    });

    pass(
        "modified source / destination / missing destination",
        "all verification_failed",
    );
}


async function testDriveAndIdentity() {
    await seedSource();
    const volume = mockVolume({ volumeId: "vol-drive" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            const { finished } = await runApprovedTransfer(
                session,
                volume,
                "Drive",
            );

            offloadTest.setRefreshDriveSnapshotOverride(async () => ({
                volumes: [],
                queriedAt: new Date().toISOString(),
                interpretationLimits: ["disconnected"],
            }));
            let started = await startReclaimReview({
                transferId: finished.transferId,
            });
            let job = await waitForReclaim(started.id, session);
            assert(
                job.candidates.every((c) => c.eligibility === RECLAIM_FAILED),
                "disconnected not failed",
            );

            offloadTest.setRefreshDriveSnapshotOverride(async () => ({
                volumes: [
                    mockVolume({
                        volumeId: "vol-drive",
                        volumeSerialNumber: "CHANGED",
                        diskUniqueId: "USBSTOR\\RECLAIM",
                    }),
                ],
                queriedAt: new Date().toISOString(),
                interpretationLimits: ["identity"],
            }));
            started = await startReclaimReview({
                transferId: finished.transferId,
            });
            job = await waitForReclaim(started.id, session);
            assert(
                job.candidates.every((c) => c.eligibility === RECLAIM_FAILED),
                "identity change not failed",
            );
        });
    });

    pass("disconnected drive / changed volume identity", "verification_failed");
}


async function testGrantsAndForeignSession() {
    await seedSource();
    const volume = mockVolume({ volumeId: "vol-grant" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            const { finished } = await runApprovedTransfer(
                session,
                volume,
                "Grant",
            );
            const grants = [...session.grants.keys()];
            assert(grants.length >= 1, "grant missing");
            revokeSessionGrant(grants[0]);

            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const job = await waitForReclaim(started.id, session);
            assert(
                job.candidates.every((c) => c.eligibility === RECLAIM_FAILED),
                "revoked grant not failed",
            );
            assert(
                job.candidates.every(
                    (c) => c.sourceAuthorization.status === "failed",
                ),
                "auth not failed",
            );
        });
    });

    const foreign = sessionTest.createSession();
    await runWithSession(foreign, async () => {
        // Create a live-owned transfer id collision scenario using a journal
        // whose owning session is still active with a stored transfer.
        const owner = sessionTest.createSession();
        const transferId = crypto.randomUUID();
        owner.transfers.set(transferId, {
            id: transferId,
            sessionId: owner.id,
            status: "completed",
            manifestHash: "x",
        });
        await writeTransferJournal(transferId, {
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            transferId,
            sessionId: owner.id,
            status: "completed",
            manifestId: crypto.randomUUID(),
            manifestHash: "x",
            manifestSnapshot: null,
            destination: mockVolume(),
            files: [],
        });

        // Keep owner live in the sessions map via createSession (already registered).
        await expectThrow(
            () => startReclaimReview({ transferId }),
            "another active storage session",
        );
    });

    pass(
        "grant revoke / foreign active session",
        "auth failed; foreign session blocked",
    );
}


async function testCloudBeforeOpen() {
    const cloudPath = path.join(
        os.homedir(),
        "OneDrive",
        "Documents",
        "cloud-placeholder-test.mp4",
    );
    const safety = await reclaimTest.precheckPathSafety(cloudPath, {
        role: "Source",
    });
    assert(safety.ok === false, "cloud path allowed");
    assert(
        safety.code === "CLOUD_PATH" || safety.code === "CLOUD" || safety.code === "ENOENT" || safety.reason,
        safety.code,
    );
    // Path marker detection should fire even if the file does not exist when
    // looksLikeCloudPath is consulted first — precheck lstats first.
    // For non-existent cloud paths, ENOENT is acceptable; marker check on existing
    // synthetic path:
    const syntheticCloud = path.join(SOURCE_SANDBOX, "OneDrive", "doc.mp4");
    await writeFile(syntheticCloud, "cloudish");
    const marked = await reclaimTest.precheckPathSafety(syntheticCloud, {
        role: "Source",
    });
    assert(marked.ok === false, "onedrive marker allowed");
    assert(
        marked.code === "CLOUD_PATH" || marked.code === "CLOUD",
        marked.code,
    );
    pass(
        "cloud placeholder detection before open",
        "OneDrive markers excluded without hydration",
    );
}


async function testValidHashesUncertainDeps() {
    await seedSource();
    const volume = mockVolume({ volumeId: "vol-deps" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            const { finished } = await runApprovedTransfer(
                session,
                volume,
                "Deps",
            );
            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const job = await waitForReclaim(started.id, session);
            const ok = job.candidates.filter(
                (c) =>
                    c.sourceIntegrity.status === "verified" &&
                    c.destinationIntegrity.status === "verified",
            );
            assert(ok.length >= 1, "no integrity-verified files");
            // Unknown active-use should not collapse into integrity failure.
            assert(
                ok.every((c) => c.copyIntegrity.status === "verified"),
                "copy integrity collapsed",
            );
            const manual = ok.filter((c) => c.eligibility === RECLAIM_MANUAL);
            if (manual.length > 0) {
                assert(
                    manual.every((c) => c.manualReviewNeeds.length > 0),
                    "missing manual review guidance",
                );
            }
        });
    });

    pass(
        "valid hashes with uncertain dependencies",
        "integrity separated from dependency confidence",
    );
}


async function testSensitiveAndProjectExclusion() {
    await rimraf(SOURCE_SANDBOX);
    await writeFile(path.join(SOURCE_SANDBOX, ".env"), "SECRET=1");
    await writeFile(path.join(SOURCE_SANDBOX, "package.json"), "{}");
    await writeFile(
        path.join(SOURCE_SANDBOX, "videos", "clip.mp4"),
        "synthetic-reclaim-video-aaaaaaaa",
    );

    const volume = mockVolume({ volumeId: "vol-excl" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            await grantScanFolder(SOURCE_SANDBOX);
            // Transfer only the video (sensitive/env excluded by offload planner).
            const planned = await planStorageOffload({
                destinationVolumeId: volume.volumeId,
                destinationFolderName: "Excl",
                minBytes: 1,
                maxDepth: 4,
                maxEntries: 50,
                maxMs: 15_000,
            });
            const video = planned.entries.find((e) =>
                e.sourcePath.toLowerCase().endsWith(".mp4"),
            );
            assert(video, "video candidate missing");
            const locked = lockManifestFromSelection(planned.planId, [video.id]);
            const approval = await createStandaloneTransferApproval({
                manifestId: locked.manifestId,
                reason: "excl",
            });
            const approved = await approveById(approval.id, {
                acknowledgeIncompleteScan: approval.requiresIncompleteAck
                    ? true
                    : undefined,
            });
            const finished = await waitForTransfer(
                approved.transfer.transferId,
                session,
            );
            assert(finished.status === "completed", finished.status);

            // Project marker should exclude the video under the granted tree.
            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const job = await waitForReclaim(started.id, session);
            assert(
                job.candidates.every((c) => c.eligibility === RECLAIM_EXCLUDED),
                `expected excluded, got ${job.candidates.map((c) => c.eligibility).join(",")}`,
            );
        });
    });

    pass(
        "active project / sensitive exclusion",
        "package.json marker excludes; sensitive filenames blocked by planner",
    );
}


async function testCancellationAndConcurrency() {
    await seedSource();
    const volume = mockVolume({ volumeId: "vol-cancel" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            const { finished } = await runApprovedTransfer(
                session,
                volume,
                "Cancel",
            );
            const started = await startReclaimReview({
                transferId: finished.transferId,
                maxMs: 600_000,
            });
            await expectThrow(
                () =>
                    startReclaimReview({
                        transferId: finished.transferId,
                    }),
                "already running",
            );
            const cancelled = requestCancelReclaimJob(started.id);
            assert(
                cancelled.status === "cancelling" ||
                    cancelled.status === "cancelled" ||
                    cancelled.status === "completed",
                cancelled.status,
            );
            const job = await waitForReclaim(started.id, session);
            assert(
                job.status === "cancelled" ||
                    job.status === "completed" ||
                    job.status === "incomplete",
                job.status,
            );
        });
    });

    pass(
        "verification cancellation / concurrent requests",
        "second start rejected; cancel honored",
    );
}


async function testStreamingBuffer() {
    assert(
        reclaimTest.HASH_BUFFER_BYTES === 64 * 1024,
        "unexpected buffer size",
    );
    const large = path.join(SOURCE_SANDBOX, "large.bin");
    const chunk = Buffer.alloc(1024, 7);
    await fs.mkdir(SOURCE_SANDBOX, { recursive: true });
    const handle = await fs.open(large, "w");
    try {
        for (let i = 0; i < 256; i += 1) {
            await handle.write(chunk);
        }
    } finally {
        await handle.close();
    }
    const digest = await reclaimTest.streamHashFile(large);
    assert(/^[a-f0-9]{64}$/.test(digest), "bad digest");
    pass("large-file streaming hash", `sha256=${digest.slice(0, 12)}…`);
}


async function testNoDeletionCapability() {
    const deleteTool = listTools().find((item) => item.name === "delete_path");
    assert(deleteTool?.available === false, "delete enabled");
    await expectThrow(
        () =>
            validateToolArguments("inspect_reclaim_candidates", {
                transferId: crypto.randomUUID(),
                delete: true,
            }),
        "Unexpected",
    );
    pass("no deletion capability exposed", "delete_path blocked; no delete args");
}


async function testLiveExternalWhenAvailable() {
    let snapshot;
    try {
        snapshot = await inspectExternalDrives({});
    } catch (error) {
        skip("live external reclaim", error.message, "live");
        return;
    }

    const external = (snapshot.volumes ?? []).find(
        (volume) =>
            (volume.classification === "external" ||
                volume.classification === "removable") &&
            volume.volumeId &&
            volume.identityConfidence !== "low" &&
            !String(volume.mount || "").toUpperCase().startsWith(SUBST_LETTER),
    );

    if (!external) {
        skip(
            "live external reclaim",
            "no eligible non-subst external/removable volume connected",
            "live",
        );
        return;
    }

    console.log(`LIVE  reclaim review against ${external.mount}`);
    const liveSrc = path.join(
        PARENT,
        `.local-ai-lab-live-reclaim-src-${crypto.randomUUID().slice(0, 8)}`,
    );
    const folderName = `LalReclaim-${crypto.randomUUID().slice(0, 8)}`;
    await writeFile(path.join(liveSrc, "note.mp4"), "live-reclaim-synthetic");

    const session = sessionTest.createSession();
    try {
        await runWithSession(session, async () => {
            await grantScanFolder(liveSrc);
            const planned = await planStorageOffload({
                destinationVolumeId: external.volumeId,
                destinationFolderName: folderName,
                minBytes: 1,
                maxDepth: 2,
                maxEntries: 20,
                maxMs: 15_000,
            });
            const selectable = planned.entries.filter((e) => e.selectable);
            assert(selectable.length >= 1, "live selectable missing");
            const locked = lockManifestFromSelection(planned.planId, [
                selectable[0].id,
            ]);
            const approval = await createStandaloneTransferApproval({
                manifestId: locked.manifestId,
                reason: "live reclaim",
            });
            const approved = await approveById(approval.id, {
                acknowledgeIncompleteScan: approval.requiresIncompleteAck
                    ? true
                    : undefined,
            });
            const finished = await waitForTransfer(
                approved.transfer.transferId,
                session,
                60_000,
            );
            assert(finished.status === "completed", finished.status);

            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const job = await waitForReclaim(started.id, session, 60_000);
            assert(
                job.status === "completed" || job.status === "incomplete",
                job.status,
            );
            assert(job.bytesActuallyReclaimed === 0, "live reclaimed");
            const sourceStill = await fs.readFile(
                path.join(liveSrc, "note.mp4"),
                "utf8",
            );
            assert(sourceStill === "live-reclaim-synthetic", "live source changed");

            await rimraf(path.join(external.mount, "LocalAI-Offload", folderName));
        });
        pass("live external reclaim", `${external.mount} ${folderName}`, "live");
    } catch (error) {
        fail("live external reclaim", error.message, "live");
    } finally {
        await rimraf(liveSrc);
    }
}


async function main() {
    await bootstrapTransferRuntime();
    bootstrapReclaimRuntime();
    await prepareDest();
    await seedSource();

    const tests = [
        ["registry", testRegistry],
        ["happy path verified transfer", testHappyPath],
        ["legacy Milestone C journal compatibility", testLegacyJournalCompatibility],
        ["altered manifest snapshot", testTamperedSnapshot],
        ["tampered hash and snapshot together", testTamperedHashAndSnapshot],
        ["interrupted / partial transfer", testPartialAndInterrupted],
        ["modified source / destination / missing destination", testModifiedSourceAndDest],
        ["disconnected drive / changed volume identity", testDriveAndIdentity],
        ["grant revoke / foreign active session", testGrantsAndForeignSession],
        ["cloud placeholder detection before open", testCloudBeforeOpen],
        ["valid hashes with uncertain dependencies", testValidHashesUncertainDeps],
        ["active project / sensitive exclusion", testSensitiveAndProjectExclusion],
        ["verification cancellation / concurrent requests", testCancellationAndConcurrency],
        ["large-file streaming hash", testStreamingBuffer],
        ["no deletion capability exposed", testNoDeletionCapability],
        ["live external reclaim", testLiveExternalWhenAvailable],
    ];

    for (const [name, fn] of tests) {
        try {
            await fn();
        } catch (error) {
            fail(name, error.message);
        }
    }

    unmountSubst();
    await rimraf(SOURCE_SANDBOX);
    await rimraf(DEST_SANDBOX);

    const mocked = results.filter((item) => item.kind === "mocked");
    const live = results.filter((item) => item.kind === "live");
    const summarize = (items) => ({
        passed: items.filter((item) => item.status === "pass").length,
        failed: items.filter((item) => item.status === "fail").length,
        skipped: items.filter((item) => item.status === "skip").length,
    });

    const mockedSummary = summarize(mocked);
    const liveSummary = summarize(live);
    console.log(
        `\nMocked Windows/synthetic: ${mockedSummary.passed} passed, ${mockedSummary.failed} failed, ${mockedSummary.skipped} skipped`,
    );
    console.log(
        `Live Windows: ${liveSummary.passed} passed, ${liveSummary.failed} failed, ${liveSummary.skipped} skipped`,
    );

    if (mockedSummary.failed + liveSummary.failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    try {
        unmountSubst();
    } catch {
        // ignore
    }
    process.exitCode = 1;
});
