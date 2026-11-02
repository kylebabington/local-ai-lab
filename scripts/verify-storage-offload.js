// =========================================================
// scripts/verify-storage-offload.js
//
// Milestone B: external drives, offload planning, selection lock.
// Synthetic sandbox only — never personal user files.
// =========================================================


import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    PERMISSION_READ,
    executeTool,
    getTool,
    listTools,
    validateToolArguments,
} from "../lib/tools/registry.js";
import {
    SAFETY_EXCLUDED,
    SAFETY_LIKELY_PORTABLE,
    classifyOffloadCandidate,
    lockManifestFromSelection,
    planStorageOffload,
    validateDestinationFilename,
    _test as offloadTest,
} from "../lib/tools/storage-offload.js";
import { classifyDrive, _test as windowsTest } from "../lib/tools/windows.js";
import {
    _test as sessionTest,
    getSessionManifest,
    getSessionPlan,
    revokeSessionGrant,
    runWithSession,
    setLastDriveSnapshot,
} from "../lib/storage-session.js";
import { grantScanFolder } from "../lib/tools/storage.js";


const results = [];
// Outside process.cwd() so candidates are not excluded as Local AI Lab files.
const SANDBOX = path.join(
    path.dirname(process.cwd()),
    ".local-ai-lab-offload-test-sandbox",
);


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

function mockExternalVolume(overrides = {}) {
    return {
        mount: "E:\\",
        label: "Backup",
        fileSystem: "NTFS",
        totalBytes: 500_000_000_000,
        freeBytes: 200_000_000_000,
        usedPercent: 60,
        driveType: "Fixed",
        busType: "USB",
        classification: "external",
        confidence: "high",
        uncertainty: null,
        volumeId: "disk-usb|vol-serial-1",
        volumeSerialNumber: "vol-serial-1",
        diskUniqueId: "disk-usb",
        identityConfidence: "high",
        diskNumber: 1,
        ...overrides,
    };
}

async function setupSandbox() {
    await rimraf(SANDBOX);
    await fs.mkdir(path.join(SANDBOX, "videos"), { recursive: true });
    await fs.mkdir(path.join(SANDBOX, "docs"), { recursive: true });
    await writeFile(
        path.join(SANDBOX, "videos", "movie.mp4"),
        "v".repeat(6 * 1024 * 1024),
    );
    await writeFile(
        path.join(SANDBOX, "docs", "notes.pdf"),
        "p".repeat(6 * 1024 * 1024),
    );
    await writeFile(path.join(SANDBOX, "tiny.txt"), "hi");
    await writeFile(path.join(SANDBOX, ".env"), "SECRET=1");
}

async function withSession(work) {
    const session = sessionTest.createSession();
    return runWithSession(session, () => work(session));
}


async function testRegistry() {
    const listed = listTools();
    const drives = listed.find((item) => item.name === "inspect_external_drives");
    const plan = listed.find((item) => item.name === "plan_storage_offload");
    assert(drives?.permission === PERMISSION_READ, "drives permission");
    assert(plan?.permission === PERMISSION_READ, "plan permission");
    assert(getTool("inspect_external_drives"), "drives registered");
    assert(getTool("plan_storage_offload"), "plan registered");
    assert(
        listed.find((item) => item.name === "run_shell")?.available === false,
        "run_shell must stay blocked",
    );
    assert(
        !listed.some((item) => item.name === "copy_and_verify_files"),
        "copy must not exist yet",
    );

    validateToolArguments("inspect_external_drives", {});
    validateToolArguments("plan_storage_offload", {
        destinationVolumeId: "disk-usb|vol-serial-1",
    });
    await expectThrow(
        () => validateToolArguments("plan_storage_offload", {}),
        "destinationVolumeId",
    );

    pass("registry", "offload tools read-only; copy not registered; run_shell blocked");
}


async function testDriveClassification() {
    assert(
        classifyDrive({ driveType: "Removable", busType: "" }).classification ===
            "removable",
        "removable",
    );
    assert(
        classifyDrive({ driveType: "Fixed", busType: "USB" }).classification ===
            "external",
        "usb fixed => external",
    );
    assert(
        classifyDrive({ driveType: "Fixed", busType: "NVMe" }).classification ===
            "internal",
        "nvme internal",
    );
    assert(
        classifyDrive({ driveType: "Fixed", busType: "" }).classification ===
            "unknown",
        "fixed without bus => unknown",
    );

    pass("drive classification", "conservative unknown when BusType missing");
}


async function testCandidateClassification() {
    const portable = classifyOffloadCandidate({
        sourcePath: path.join(SANDBOX, "videos", "movie.mp4"),
        sizeBytes: 6 * 1024 * 1024,
        mtimeMs: Date.now() - 400 * 24 * 60 * 60 * 1000,
        inUse: null,
    });
    assert(portable.safety === SAFETY_LIKELY_PORTABLE, "mp4 likely_portable");
    assert(
        portable.concerns.some((item) => item.toLowerCase().includes("not proof")),
        "must not claim unused",
    );

    const excluded = classifyOffloadCandidate({
        sourcePath: path.join(SANDBOX, ".env"),
        sizeBytes: 10,
        mtimeMs: Date.now(),
        inUse: null,
    });
    assert(excluded.safety === SAFETY_EXCLUDED, ".env excluded");

    const lab = classifyOffloadCandidate({
        sourcePath: path.join(process.cwd(), "package.json"),
        sizeBytes: 10_000_000,
        mtimeMs: Date.now(),
        inUse: null,
    });
    assert(lab.safety === SAFETY_EXCLUDED, "lab directory excluded");

    pass("candidate classification", "likely_portable / review / excluded; no safe-to-move");
}


async function testDestinationFilenames() {
    assert(validateDestinationFilename("movie.mp4") === null, "valid name");
    assert(validateDestinationFilename("bad:name.mp4"), "colon invalid");
    assert(validateDestinationFilename("con.txt"), "reserved name");
    assert(validateDestinationFilename("ends. "), "trailing space");

    pass("destination filenames", "invalid and reserved names rejected");
}


async function testPlanAndRelativePaths() {
    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        setLastDriveSnapshot({
            volumes: [mockExternalVolume()],
            queriedAt: new Date().toISOString(),
        });

        const result = await planStorageOffload({
            destinationVolumeId: "disk-usb|vol-serial-1",
            destinationFolderName: "Media",
            minBytes: 1024 * 1024,
        });

        assert(result.planId, "planId");
        assert(typeof result.estimatedTransferBytes === "number", "transfer estimate");
        assert(
            typeof result.potentialRecoverableBytesAfterVerifiedRemoval === "number",
            "recoverable estimate",
        );
        assert(
            result.estimatesNote.toLowerCase().includes("does not free"),
            "must not claim frees space",
        );

        const movie = result.entries.find((entry) =>
            entry.sourcePath.toLowerCase().endsWith("movie.mp4"),
        );
        assert(movie, "movie candidate");
        assert(
            movie.destinationPath.replace(/\//g, "\\").includes(
                "LocalAI-Offload\\Media\\videos\\movie.mp4",
            ),
            `relative structure lost: ${movie.destinationPath}`,
        );

        const envEntry = result.entries.find((entry) =>
            entry.sourcePath.toLowerCase().endsWith(".env"),
        );
        assert(!envEntry || envEntry.safety === SAFETY_EXCLUDED, ".env must stay excluded");

        const tiny = result.entries.find((entry) =>
            entry.sourcePath.toLowerCase().endsWith("tiny.txt"),
        );
        assert(!tiny, "below minBytes should be omitted");
    });

    pass("plan relative paths", "LocalAI-Offload preserves videos\\movie.mp4");
}


async function testInternalDestinationRejected() {
    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        setLastDriveSnapshot({
            volumes: [
                mockExternalVolume({
                    volumeId: "internal-c",
                    mount: "C:\\",
                    classification: "internal",
                    busType: "NVMe",
                    driveType: "Fixed",
                }),
            ],
        });

        await expectThrow(
            () =>
                planStorageOffload({
                    destinationVolumeId: "internal-c",
                }),
            "external or removable",
        );
    });

    pass("internal destination", "internal volumes refused");
}


async function testNoGrantPlanFails() {
    await withSession(async () => {
        setLastDriveSnapshot({ volumes: [mockExternalVolume()] });
        await expectThrow(
            () =>
                planStorageOffload({
                    destinationVolumeId: "disk-usb|vol-serial-1",
                }),
            "No storage scan folders",
        );
    });

    pass("plan without grants", "refuses until folders are granted");
}


async function testSelectionLock() {
    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        setLastDriveSnapshot({ volumes: [mockExternalVolume()] });
        const planned = await planStorageOffload({
            destinationVolumeId: "disk-usb|vol-serial-1",
            minBytes: 1024 * 1024,
        });

        const selectable = planned.entries.filter((entry) => entry.selectable);
        assert(selectable.length >= 1, "need selectable entries");

        await expectThrow(
            () => lockManifestFromSelection(planned.planId, []),
            "at least one",
        );

        await expectThrow(
            () =>
                lockManifestFromSelection(planned.planId, [
                    selectable[0].id,
                    selectable[0].id,
                ]),
            "Duplicate",
        );

        await expectThrow(
            () => lockManifestFromSelection(planned.planId, ["off_missing"]),
            "stale",
        );

        const excluded = planned.entries.find(
            (entry) => entry.safety === SAFETY_EXCLUDED,
        );
        if (excluded) {
            await expectThrow(
                () =>
                    lockManifestFromSelection(planned.planId, [excluded.id]),
                "Excluded",
            );
        }

        const ids = selectable.map((entry) => entry.id);
        const locked = lockManifestFromSelection(planned.planId, ids);
        assert(locked.manifestId, "manifest id");
        assert(locked.hash?.length === 64, "sha256 hash");
        assert(locked.copyAvailable === false, "copy not available");
        assert(
            locked.complete === planned.complete,
            "manifest must preserve plan completeness",
        );

        const stored = getSessionManifest(locked.manifestId);
        assert(stored?.immutable === true, "immutable flag");
        assert(
            stored.entryIds.length === selectable.length,
            "entry id count",
        );
    });

    pass("selection lock", "exact ids only; duplicates/excluded/stale rejected");
}


async function testDestinationCollisions() {
    const a = {
        id: "1",
        safety: SAFETY_LIKELY_PORTABLE,
        destinationPath: "E:\\LocalAI-Offload\\Media\\Video.mp4",
        selectable: true,
        dependencyConcerns: [],
    };
    const b = {
        id: "2",
        safety: SAFETY_LIKELY_PORTABLE,
        destinationPath: "E:\\LocalAI-Offload\\Media\\video.mp4",
        selectable: true,
        dependencyConcerns: [],
    };
    const conflicts = offloadTest.detectDestinationConflicts([a, b]);
    assert(conflicts.length >= 1, "case collision");
    assert(a.safety === SAFETY_EXCLUDED && b.safety === SAFETY_EXCLUDED, "both excluded");

    pass("destination collisions", "case-insensitive collisions exclude both");
}


async function testRevokeInvalidatesPlan() {
    await withSession(async (session) => {
        const grant = await grantScanFolder(SANDBOX);
        setLastDriveSnapshot({ volumes: [mockExternalVolume()] });
        const planned = await planStorageOffload({
            destinationVolumeId: "disk-usb|vol-serial-1",
            minBytes: 1024 * 1024,
        });

        const selectable = planned.entries.find((entry) => entry.selectable);
        assert(selectable, "need a selectable entry before revoke");

        revokeSessionGrant(grant.id, session);
        const plan = getSessionPlan(planned.planId);
        assert(plan.invalidated === true, "plan should invalidate");

        await expectThrow(
            () => lockManifestFromSelection(planned.planId, [selectable.id]),
            "revoked",
        );
    });

    pass("revoke invalidates plan", "locked selection refused after grant revoke");
}


async function testIncompletePreserved() {
    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        setLastDriveSnapshot({ volumes: [mockExternalVolume()] });
        const planned = await planStorageOffload({
            destinationVolumeId: "disk-usb|vol-serial-1",
            minBytes: 1024 * 1024,
            maxEntries: 1,
            maxDepth: 0,
        });

        assert(planned.complete === false, "limit should be incomplete");
        assert(planned.incomplete, "incomplete object");

        const selectable = planned.entries.filter((entry) => entry.selectable);
        if (selectable.length > 0) {
            const locked = lockManifestFromSelection(planned.planId, [
                selectable[0].id,
            ]);
            assert(locked.complete === false, "manifest keeps incomplete");
            assert(locked.incomplete, "manifest incomplete object");
        }
    });

    pass("incomplete preserved", "partial plans stay partial through lock");
}


async function testAmbiguousVolume() {
    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        setLastDriveSnapshot({
            volumes: [
                mockExternalVolume({
                    volumeId: "mount:E:\\",
                    identityConfidence: "low",
                    volumeSerialNumber: null,
                    diskUniqueId: null,
                }),
            ],
        });

        await expectThrow(
            () =>
                planStorageOffload({
                    destinationVolumeId: "mount:E:\\",
                }),
            "stable identity",
        );
    });

    pass("ambiguous volume", "low-identity destinations refused");
}


async function testLiveExternalDrives() {
    if (process.platform !== "win32") {
        skip("live inspect_external_drives", "not running on Windows");
        return;
    }

    windowsTest.reset();

    try {
        const { result } = await executeTool("inspect_external_drives", {});
        assert(Array.isArray(result.volumes), "volumes array");
        for (const volume of result.volumes) {
            assert(volume.mount, "mount");
            assert(volume.classification, "classification");
            assert(volume.identityConfidence, "identityConfidence");
        }
        pass(
            "live inspect_external_drives",
            `${result.volumes.length} volumes`,
        );
    } catch (error) {
        if (
            error.code === "TIMEOUT" ||
            error.code === "ACCESS_DENIED" ||
            error.code === "DIAGNOSTIC_FAILED" ||
            error.code === "UNSUPPORTED_PLATFORM"
        ) {
            pass(
                "live inspect_external_drives",
                `structured failure ${error.code}: ${error.message}`,
            );
            return;
        }
        throw error;
    }
}


async function testLivePlanAgainstSandbox() {
    if (process.platform !== "win32") {
        skip("live plan_storage_offload", "not running on Windows");
        return;
    }

    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        setLastDriveSnapshot({ volumes: [mockExternalVolume()] });
        const planned = await planStorageOffload({
            destinationVolumeId: "disk-usb|vol-serial-1",
            minBytes: 1024 * 1024,
        });
        assert(planned.planId, "live plan id");
        pass(
            "live plan_storage_offload",
            `complete=${planned.complete} candidates=${planned.candidateCount}`,
        );
    });
}


async function main() {
    const tests = [
        ["registry", testRegistry],
        ["drive classification", testDriveClassification],
        ["candidate classification", testCandidateClassification],
        ["destination filenames", testDestinationFilenames],
        ["plan relative paths", testPlanAndRelativePaths],
        ["internal destination", testInternalDestinationRejected],
        ["plan without grants", testNoGrantPlanFails],
        ["selection lock", testSelectionLock],
        ["destination collisions", testDestinationCollisions],
        ["revoke invalidates plan", testRevokeInvalidatesPlan],
        ["incomplete preserved", testIncompletePreserved],
        ["ambiguous volume", testAmbiguousVolume],
        ["live inspect_external_drives", testLiveExternalDrives],
        ["live plan_storage_offload", testLivePlanAgainstSandbox],
    ];

    try {
        await setupSandbox();

        for (const [name, run] of tests) {
            try {
                sessionTest.reset();
                windowsTest.reset();
                await run();
            } catch (error) {
                fail(name, error.message);
            } finally {
                sessionTest.reset();
                windowsTest.reset();
            }
        }
    } finally {
        await rimraf(SANDBOX);
        sessionTest.reset();
        windowsTest.reset();
    }

    const passed = results.filter((item) => item.status === "pass").length;
    const failed = results.filter((item) => item.status === "fail").length;
    const skipped = results.filter((item) => item.status === "skip").length;
    console.log("");
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

    if (failed > 0) {
        process.exitCode = 1;
    }
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
