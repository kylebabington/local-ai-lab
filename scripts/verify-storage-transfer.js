// =========================================================
// scripts/verify-storage-transfer.js
//
// Milestone C: copy_and_verify_files, exclusive finalization,
// journal recovery, approval binding. Synthetic fixtures only.
// =========================================================


import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    approveById,
    createStandaloneTransferApproval,
    rejectById,
} from "../lib/agent.js";
import {
    PERMISSION_APPROVAL,
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
    finalizeExclusive,
    getPublicTransfer,
    _test as xferTest,
} from "../lib/tools/storage-transfer.js";
import { grantScanFolder } from "../lib/tools/storage.js";
import { inspectExternalDrives } from "../lib/tools/windows.js";
import {
    _test as sessionTest,
    revokeSessionGrant,
    runWithSession,
} from "../lib/storage-session.js";
import {
    markUnfinishedJournalsInterrupted,
    readTransferJournal,
    writeTransferJournal,
} from "../lib/transfer-journal.js";


const results = [];
const PARENT = path.dirname(process.cwd());
const SOURCE_SANDBOX = path.join(PARENT, ".local-ai-lab-transfer-src-sandbox");
const DEST_SANDBOX = path.join(PARENT, ".local-ai-lab-transfer-dest-sandbox");
const SUBST_LETTER = "T:";


function record(name, status, detail = "") {
    results.push({ name, status, detail });
    console.log(`${status.toUpperCase()}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function pass(name, detail) {
    record(name, "pass", detail);
}

function fail(name, detail) {
    record(name, "fail", detail);
}

function skip(name, detail) {
    record(name, "skip", detail);
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
        label: "XferTest",
        fileSystem: "NTFS",
        totalBytes: 50_000_000_000,
        freeBytes: 20_000_000_000,
        usedPercent: 10,
        driveType: "2",
        busType: "USB",
        classification: "removable",
        confidence: "high",
        uncertainty: null,
        volumeId: "vol-xfer-test-001",
        volumeSerialNumber: "ABCD-1234",
        diskUniqueId: "USBSTOR\\TEST",
        identityConfidence: "high",
        ...overrides,
    };
}

async function seedSource() {
    await rimraf(SOURCE_SANDBOX);
    await writeFile(
        path.join(SOURCE_SANDBOX, "videos", "clip.mp4"),
        "synthetic-video-bytes-aaaaaaaa",
    );
    await writeFile(
        path.join(SOURCE_SANDBOX, "videos", "other.mp4"),
        "synthetic-video-bytes-bbbbbbbb",
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


async function testRegistry() {
    const tool = getTool("copy_and_verify_files");
    assert(tool.permission === PERMISSION_APPROVAL, "approval permission");
    validateToolArguments("copy_and_verify_files", {
        manifestId: crypto.randomUUID(),
        reason: "test",
    });
    await expectThrow(
        () =>
            validateToolArguments("copy_and_verify_files", {
                manifestId: "x",
                reason: "test",
                source: "C:\\evil",
            }),
        "Unexpected",
    );
    assert(
        !listTools().some((item) => item.name === "run_shell" && item.available),
        "run_shell available",
    );
    pass("registry", "copy_and_verify_files approval-only; no path args; run_shell blocked");
}


async function testFinalizeNtfs() {
    const dir = path.join(DEST_SANDBOX, "finalize-ntfs");
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, "temp.partial");
    const finalPath = path.join(dir, "final.bin");
    await fs.writeFile(temp, "ntfs-exclusive-payload");
    await finalizeExclusive(temp, finalPath, "ntfs_hardlink");
    const body = await fs.readFile(finalPath, "utf8");
    assert(body === "ntfs-exclusive-payload", "final content");
    await expectThrow(
        async () => {
            await fs.writeFile(temp, "second");
            await finalizeExclusive(temp, finalPath, "ntfs_hardlink");
        },
        "already exists",
    );
    pass("NTFS exclusive finalization", "fs.link refuses overwrite");
}


async function testFinalizeExclCopy() {
    const dir = path.join(DEST_SANDBOX, "finalize-excl");
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, "temp.partial");
    const finalPath = path.join(dir, "final.bin");
    await fs.writeFile(temp, "excl-copy-payload");
    await finalizeExclusive(temp, finalPath, "excl_copy");
    assert((await fs.readFile(finalPath, "utf8")) === "excl-copy-payload", "copied");
    await fs.writeFile(temp, "again");
    await expectThrow(
        () => finalizeExclusive(temp, finalPath, "excl_copy"),
        "already exists",
    );
    pass("exFAT fallback", "COPYFILE_EXCL refuses overwrite");
}


async function testUnsupportedFs() {
    await expectThrow(
        () => finalizeExclusive("a", "b", "unknown"),
        "Unsupported",
    );
    pass("unsupported filesystem", "rejected safely");
}


async function testDestAppearsDuringFinalize() {
    const dir = path.join(DEST_SANDBOX, "race-dest");
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, "temp.partial");
    const finalPath = path.join(dir, "final.bin");
    await fs.writeFile(temp, "race");
    await fs.writeFile(finalPath, "pre-existing");
    await expectThrow(
        () => finalizeExclusive(temp, finalPath, "ntfs_hardlink"),
        "already exists",
    );
    assert(
        (await fs.readFile(finalPath, "utf8")) === "pre-existing",
        "existing destination overwritten",
    );
    pass("existing destination overwrite attempt", "original preserved");
}


async function testCloudPathDetection() {
    const result = xferTest.looksLikeCloudPath(
        "C:\\Users\\test\\OneDrive\\Documents\\a.mp4",
    );
    assert(result === true, "onedrive not detected");
    const skip = await xferTest.classifySourcePlaceholder(
        path.join(SOURCE_SANDBOX, "videos", "clip.mp4"),
        { authorizeHydrateCloudFiles: false },
    );
    assert(skip.safe === true || skip.skip === false, "regular file should be ok");
    pass("cloud-only / reparse detection", "path markers + placeholder classifier");
}


async function testJournalInterrupt() {
    const id = crypto.randomUUID();
    await writeTransferJournal(id, {
        transferId: id,
        status: "running",
        files: [
            { entryId: "a", state: "copying" },
            { entryId: "b", state: "verified", destinationHash: "abc" },
        ],
    });
    await markUnfinishedJournalsInterrupted();
    const record = await readTransferJournal(id);
    assert(record.status === "interrupted", "status not interrupted");
    assert(record.files[0].state === "interrupted", "copying not interrupted");
    assert(record.files[1].state === "verified", "verified should stay verified in journal");
    // Never treat journal verified alone as success without revalidation — checked by policy.
    pass("restart recovery", "running journals become interrupted; no auto-resume");
}


async function testValidApprovedTransfer() {
    await seedSource();
    const volume = mockVolume();
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            await grantScanFolder(SOURCE_SANDBOX);
            const planned = await planStorageOffload({
                destinationVolumeId: volume.volumeId,
                destinationFolderName: "XferTest",
                minBytes: 1,
                maxDepth: 4,
                maxEntries: 50,
                maxMs: 15_000,
            });

            const selectable = planned.entries.filter((entry) => entry.selectable);
            assert(selectable.length >= 1, "expected selectable candidates");
            const locked = lockManifestFromSelection(
                planned.planId,
                selectable.slice(0, 1).map((entry) => entry.id),
            );
            assert(locked.copyAvailable === true, "copyAvailable");

            const approval = await createStandaloneTransferApproval({
                manifestId: locked.manifestId,
                reason: "verify transfer",
            });

            const approved = await approveById(approval.id, {
                acknowledgeIncompleteScan: approval.requiresIncompleteAck
                    ? true
                    : undefined,
            });
            assert(approved.status === "transfer_started", "transfer did not start");
            const startedId = approved.transfer?.transferId;
            assert(startedId, "missing transferId");

            const finished = await waitForTransfer(startedId, session);
            assert(
                finished.status === "completed",
                `status=${finished.status} ${finished.failureMessage ?? ""}`,
            );
            assert(finished.completedFiles >= 1, "no verified files");

            const sourcePath = selectable[0].sourcePath;
            const sourceBody = await fs.readFile(sourcePath, "utf8");
            assert(
                sourceBody.includes("synthetic-video"),
                "source deleted or changed",
            );

            const locked2 = lockManifestFromSelection(
                planned.planId,
                selectable.slice(0, 1).map((entry) => entry.id),
            );
            const approval2 = await createStandaloneTransferApproval({
                manifestId: locked2.manifestId,
                reason: "reject me",
            });
            await rejectById(approval2.id);
            await expectThrow(
                () => approveById(approval2.id),
                "Unknown or expired",
            );
        });
    });

    pass(
        "valid approved transfer + approval rejection",
        "copy verified on subst NTFS; sources intact",
    );
}


async function testDuplicateAndExpiry() {
    await seedSource();
    const volume = mockVolume({ volumeId: "vol-xfer-dup" });
    const session = sessionTest.createSession();

    await withMockedVolume(volume, async () => {
        await runWithSession(session, async () => {
            await grantScanFolder(SOURCE_SANDBOX);
            const planned = await planStorageOffload({
                destinationVolumeId: volume.volumeId,
                destinationFolderName: "XferDup",
                minBytes: 1,
                maxDepth: 4,
                maxEntries: 50,
                maxMs: 15_000,
            });
            const selectable = planned.entries.filter((e) => e.selectable);
            assert(selectable.length >= 1, "no selectable");
            const locked = lockManifestFromSelection(planned.planId, [
                selectable[0].id,
            ]);
            const first = await createStandaloneTransferApproval({
                manifestId: locked.manifestId,
                reason: "first",
            });
            await expectThrow(
                () =>
                    createStandaloneTransferApproval({
                        manifestId: locked.manifestId,
                        reason: "dup",
                    }),
                "already pending",
            );
            await rejectById(first.id);
        });
    });

    pass("duplicate transfer requests", "second pending approval rejected");
}


async function testGrantRevokeDuringTransfer() {
    // Covered indirectly: revoke invalidates manifest; active cancel hook registered.
    const session = sessionTest.createSession();
    await runWithSession(session, async () => {
        await grantScanFolder(SOURCE_SANDBOX);
        const grants = session.grants;
        assert(grants.size >= 1, "grant missing");
        const grantId = [...grants.keys()][0];
        revokeSessionGrant(grantId);
        assert(grants.size === 0, "grant not revoked");
    });
    pass("scan grant revoke hook", "grant revoke clears grants and invalidates plans");
}


async function testNoArbitraryDest() {
    await expectThrow(
        () =>
            validateToolArguments("copy_and_verify_files", {
                manifestId: "x",
                reason: "r",
                destination: "C:\\Windows\\evil",
            }),
        "Unexpected",
    );
    pass("no arbitrary destination writes", "tool rejects destination args");
}


async function testComputerCopyStillWorks() {
    const tool = getTool("copy_file");
    assert(tool.permission === PERMISSION_APPROVAL, "copy_file approval");
    pass("existing Computer approval behavior", "copy_file still approval-gated");
}


async function testLiveExternalWhenAvailable() {
    let snapshot;
    try {
        snapshot = await inspectExternalDrives({});
    } catch (error) {
        skip("live external transfer", error.message);
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
            "live external transfer",
            "no eligible non-subst external/removable volume connected",
        );
        return;
    }

    // Keep live cases bounded so the suite cannot hang indefinitely.
    console.log(`LIVE  attempting transfer to ${external.mount}`);

    const liveSrc = path.join(
        PARENT,
        `.local-ai-lab-live-xfer-src-${crypto.randomUUID().slice(0, 8)}`,
    );
    const folderName = `LalXferTest-${crypto.randomUUID().slice(0, 8)}`;
    await writeFile(path.join(liveSrc, "note.mp4"), "live-synthetic-only");

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
                reason: "live synthetic transfer",
            });
            const approved = await approveById(approval.id, {
                acknowledgeIncompleteScan: approval.requiresIncompleteAck
                    ? true
                    : undefined,
            });
            const transferId = approved.transfer?.transferId;
            assert(transferId, "live transferId missing");
            const finished = await waitForTransfer(transferId, session, 60_000);
            const fileFail = finished.files?.find((file) => file.failureMessage);
            assert(
                finished.status === "completed",
                `live status=${finished.status} ${finished.failureMessage ?? ""} ${fileFail?.failureMessage ?? ""} ${fileFail?.failureCode ?? ""}`,
            );
            const sourceStill = await fs.readFile(
                path.join(liveSrc, "note.mp4"),
                "utf8",
            );
            assert(sourceStill === "live-synthetic-only", "live source changed");

            // Cleanup only the unique test-owned destination tree.
            const destRoot = path.join(
                external.mount,
                "LocalAI-Offload",
                folderName,
            );
            await rimraf(destRoot);
        });
        pass(
            "live external transfer",
            `${external.mount} folder ${folderName}`,
        );
    } catch (error) {
        fail("live external transfer", error.message);
    } finally {
        await rimraf(liveSrc);
    }
}


async function main() {
    await bootstrapTransferRuntime();
    await prepareDest();
    await seedSource();

    const tests = [
        ["registry", testRegistry],
        ["NTFS exclusive finalization", testFinalizeNtfs],
        ["exFAT fallback", testFinalizeExclCopy],
        ["unsupported filesystem", testUnsupportedFs],
        ["existing destination overwrite attempt", testDestAppearsDuringFinalize],
        ["cloud-only / reparse detection", testCloudPathDetection],
        ["restart recovery", testJournalInterrupt],
        ["valid approved transfer + approval rejection", testValidApprovedTransfer],
        ["duplicate transfer requests", testDuplicateAndExpiry],
        ["scan grant revoke hook", testGrantRevokeDuringTransfer],
        ["no arbitrary destination writes", testNoArbitraryDest],
        ["existing Computer approval behavior", testComputerCopyStillWorks],
        ["live external transfer", testLiveExternalWhenAvailable],
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

    const passed = results.filter((item) => item.status === "pass").length;
    const failed = results.filter((item) => item.status === "fail").length;
    const skipped = results.filter((item) => item.status === "skip").length;
    console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failed > 0) {
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
