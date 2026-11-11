// =========================================================
// scripts/verify-troubleshooting-watch.js
//
// Phase E1 Watch Me Try — mocked + optional live Notepad.
// =========================================================


import {
    getTool,
    listTools,
    validateToolArguments,
} from "../lib/tools/registry.js";
import {
    APP_PRESETS,
    bootstrapTroubleshootingRuntime,
    interruptAllWatches,
    _test as sessionTestWatch,
} from "../lib/troubleshooting-session.js";
import {
    cancelWatch,
    executeInspectTroubleshootingSession,
    iTriedIt,
    startWatch,
    stopAndAnalyze,
    tryingNow,
    _test as watchTest,
} from "../lib/tools/troubleshooting-watch.js";
import { _test as windowsTest } from "../lib/tools/windows.js";
import {
    _test as storageSessionTest,
    runWithSession,
} from "../lib/storage-session.js";


const results = [];


function record(name, status, detail = "") {
    results.push({ name, status, detail });
    console.log(
        `${status.toUpperCase()}  ${name}${detail ? ` — ${detail}` : ""}`,
    );
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
        throw new Error(message || "assertion failed");
    }
}

async function expectThrow(fn, match) {
    try {
        await fn();
        throw new Error("expected throw");
    } catch (error) {
        if (error.message === "expected throw") {
            throw error;
        }
        if (
            match &&
            error.code !== match &&
            !String(error.message).includes(match)
        ) {
            throw new Error(`expected ${match}, got ${error.message}`);
        }
    }
}


function psProcesses(list) {
    return JSON.stringify(
        list.map((p) => ({
            Name: p.name,
            Id: p.pid,
            CPU: p.cpu ?? 1,
            WorkingSet64: p.ws ?? 10_000_000,
            StartTime: p.startedAt ?? "2026-01-01T00:00:00",
            Responding: p.responding !== false,
        })),
    );
}


function installProcessFixture(sequence) {
    let i = 0;
    windowsTest.setPlatform("win32");
    windowsTest.setRunWindowsCommand(async (spec) => {
        const command = spec.args[spec.args.length - 1] || "";
        if (command.includes("Get-Process -Name")) {
            const snapshot = sequence[Math.min(i, sequence.length - 1)];
            i += 1;
            return { stdout: psProcesses(snapshot), stderr: "", exitCode: 0 };
        }
        if (command.includes("Id = 1000,1001,1002")) {
            return { stdout: "[]", stderr: "", exitCode: 0 };
        }
        // Allow other diagnostics to succeed empty
        return { stdout: "[]", stderr: "", exitCode: 0 };
    });
}


function installCrashEvents(eventsFactory, { exitCode = 0, delayMs = 0 } = {}) {
    windowsTest.setPlatform("win32");
    const previous = windowsTest.defaultRunWindowsCommand;
    windowsTest.setRunWindowsCommand(async (spec) => {
        const command = spec.args[spec.args.length - 1] || "";
        if (command.includes("Id = 1000,1001,1002")) {
            if (delayMs) {
                await new Promise((r) => setTimeout(r, delayMs));
            }
            if (exitCode !== 0) {
                return { stdout: "", stderr: "fail", exitCode };
            }
            const events =
                typeof eventsFactory === "function"
                    ? eventsFactory()
                    : eventsFactory;
            return {
                stdout: JSON.stringify(events),
                stderr: "",
                exitCode: 0,
            };
        }
        if (command.includes("Get-Process")) {
            return {
                stdout: psProcesses([
                    {
                        name: "notepad",
                        pid: 1001,
                        startedAt: "2026-01-01T00:00:00",
                    },
                ]),
                stderr: "",
                exitCode: 0,
            };
        }
        return previous(spec);
    });
}


async function withSession(fn) {
    const session = storageSessionTest.createSession();
    return runWithSession(session, () => fn(session));
}


async function testRegistry() {
    const tool = getTool("inspect_troubleshooting_session");
    assert(tool.permission === "read", "read permission");
    validateToolArguments("inspect_troubleshooting_session", {
        troubleshootingSessionId: "abc",
    });
    await expectThrow(
        () =>
            validateToolArguments("inspect_troubleshooting_session", {
                troubleshootingSessionId: "abc",
                path: "C:\\evil",
            }),
        "Unexpected",
    );
    assert(
        listTools().find((t) => t.name === "run_shell")?.available === false,
        "shell blocked",
    );
    assert(APP_PRESETS.length >= 5, "presets");
    pass("registry / no unauthorized execution");
}


async function testValidStartAndDuplicate() {
    sessionTestWatch.reset();
    installProcessFixture([
        [{ name: "notepad", pid: 11, startedAt: "2026-01-01T00:00:00" }],
    ]);

    await withSession(async () => {
        const first = await startWatch({
            preset: "notepad",
            problemDescription: "won't open",
            durationMs: 15_000,
        });
        assert(first.status === "watching", first.status);
        await expectThrow(
            () =>
                startWatch({
                    preset: "notepad",
                    problemDescription: "again",
                    durationMs: 15_000,
                }),
            "WATCH_IN_PROGRESS",
        );
        await cancelWatch(first.troubleshootingSessionId);
        pass("valid start + duplicate start rejected");
    });
}


async function testForeignSession() {
    sessionTestWatch.reset();
    installProcessFixture([
        [{ name: "notepad", pid: 11, startedAt: "2026-01-01T00:00:00" }],
    ]);

    const owner = storageSessionTest.createSession();
    let id;
    await runWithSession(owner, async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        id = watch.troubleshootingSessionId;
    });

    const foreign = storageSessionTest.createSession();
    await runWithSession(foreign, async () => {
        await expectThrow(() => stopAndAnalyze(id), "UNKNOWN_WATCH");
    });

    await runWithSession(owner, async () => {
        await cancelWatch(id);
    });
    pass("foreign-session rejection");
}


async function testProcessOutcomes() {
    sessionTestWatch.reset();

    // Never appeared
    installProcessFixture([[], [], []]);
    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        await new Promise((r) => setTimeout(r, 50));
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(
            done.report?.processSummary?.outcome === "never_observed" ||
                done.processSummary?.outcome === "never_observed" ||
                done.report?.processSummary?.neverObserved === true ||
                done.report?.observed?.some((o) =>
                    /never_observed|never appeared/i.test(o),
                ),
            JSON.stringify(done.report?.processSummary),
        );
        pass("process never appeared");
    });

    sessionTestWatch.reset();
    // Observed then exited
    installProcessFixture([
        [{ name: "notepad", pid: 42, startedAt: "2026-01-01T00:00:00" }],
        [{ name: "notepad", pid: 42, startedAt: "2026-01-01T00:00:00" }],
        [],
    ]);
    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        await watchTest.runSampleTick(
            sessionTestWatch.watchesById.get(watch.troubleshootingSessionId),
        );
        await watchTest.runSampleTick(
            sessionTestWatch.watchesById.get(watch.troubleshootingSessionId),
        );
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        const outcome =
            done.report?.processSummary?.outcome ||
            done.processSummary?.outcome;
        assert(
            outcome === "observed_exited" ||
                done.report?.processSummary?.processDisappeared === true,
            outcome,
        );
        pass("process observed then exited");
    });

    sessionTestWatch.reset();
    // Existing process not a new launch
    installProcessFixture([
        [{ name: "Cursor", pid: 7, startedAt: "2026-01-01T00:00:00" }],
        [{ name: "Cursor", pid: 7, startedAt: "2026-01-01T00:00:00" }],
    ]);
    await withSession(async () => {
        const watch = await startWatch({
            preset: "cursor",
            durationMs: 15_000,
        });
        await watchTest.runSampleTick(
            sessionTestWatch.watchesById.get(watch.troubleshootingSessionId),
        );
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(
            done.report?.processSummary?.alreadyRunningBeforeAttempt === true,
            "should mark already running",
        );
        assert(
            done.report?.likelyCauses?.some((h) =>
                /existing instance/i.test(h.hypothesis),
            ),
            "hypothesis about existing instance",
        );
        pass("existing process not mistaken for new launch");
    });

    sessionTestWatch.reset();
    // Restart / PID reuse
    installProcessFixture([
        [{ name: "notepad", pid: 9, startedAt: "2026-01-01T00:00:00" }],
        [{ name: "notepad", pid: 9, startedAt: "2026-01-01T01:00:00" }],
    ]);
    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        const live = sessionTestWatch.watchesById.get(
            watch.troubleshootingSessionId,
        );
        await watchTest.runSampleTick(live);
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(
            done.report?.processSummary?.processRestarted === true,
            "restart expected",
        );
        pass("process restart / PID reuse");
    });

    sessionTestWatch.reset();
    // Multi electron + not responding
    installProcessFixture([
        [
            {
                name: "Cursor",
                pid: 1,
                startedAt: "2026-01-01T00:00:00",
                responding: true,
            },
            {
                name: "Cursor",
                pid: 2,
                startedAt: "2026-01-01T00:00:00",
                responding: false,
            },
        ],
    ]);
    await withSession(async () => {
        const watch = await startWatch({
            preset: "cursor",
            durationMs: 15_000,
        });
        await watchTest.runSampleTick(
            sessionTestWatch.watchesById.get(watch.troubleshootingSessionId),
        );
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(
            done.report?.processSummary?.processCountEver >= 2,
            "electron group",
        );
        assert(
            done.report?.processSummary?.outcome === "observed_not_responding",
            done.report?.processSummary?.outcome,
        );
        pass("multiple Electron subprocesses + unresponsive");
    });
}


async function testEventCorrelation() {
    sessionTestWatch.reset();
    installCrashEvents(() => {
        const now = new Date().toISOString();
        return [
            {
                TimeCreated: now,
                Id: 1001,
                Level: 4,
                LevelDisplayName: "Information",
                ProviderName: "Windows Error Reporting",
                FaultingApplication: "notepad.exe",
                FaultingModule: "",
                FaultingProcessId: 1001,
                Message: "Fault bucket ...",
            },
            {
                TimeCreated: now,
                Id: 1000,
                Level: 2,
                LevelDisplayName: "Error",
                ProviderName: "Application Error",
                FaultingApplication: "notepad.exe",
                FaultingModule: "ntdll.dll",
                FaultingProcessId: 1001,
                Message: "Faulting application name: notepad.exe",
            },
            {
                TimeCreated: now,
                Id: 1002,
                Level: 2,
                LevelDisplayName: "Error",
                ProviderName: "Application Hang",
                FaultingApplication: "notepad.exe",
                FaultingModule: "",
                FaultingProcessId: 1001,
                Message: "The program notepad.exe ...",
            },
            {
                TimeCreated: now,
                Id: 9999,
                Level: 4,
                LevelDisplayName: "Information",
                ProviderName: "SomeOtherProvider",
                FaultingApplication: "other.exe",
                FaultingModule: "",
                FaultingProcessId: 1,
                Message: "unrelated informational noise",
            },
        ];
    });

    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        const events = done.correlatedEvents || [];
        assert(
            events.some((e) => e.id === 1001),
            "WER 1001 informational detected",
        );
        assert(
            events.some((e) => e.id === 1000 && e.matchStrength === "confirmed"),
            "App Error 1000 confirmed",
        );
        assert(
            events.some((e) => e.id === 1002),
            "Hang 1002 present",
        );
        assert(
            events
                .filter((e) => e.id === 9999)
                .every((e) => e.matchStrength === "temporal_only"),
            "unrelated informational excluded from attribution",
        );
        assert(
            done.report?.likelyCauses?.some((h) =>
                /WER 1001 alone does not prove/i.test(h.limitation),
            ) ||
                done.report?.limitations?.some((l) =>
                    /WER event 1001 alone/i.test(l),
                ),
            "WER caveat present",
        );
        pass("WER/AppError/Hang correlation + unrelated excluded");
    });
}


async function testEventTimeoutAndEmpty() {
    sessionTestWatch.reset();
    installCrashEvents([], { exitCode: 2 });
    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(
            done.eventQuery?.status === "incomplete" ||
                done.report?.eventQuery?.status === "incomplete",
            done.eventQuery?.status,
        );
        assert(
            done.report?.unverified?.some((u) => /incomplete|failed/i.test(u)),
            "incomplete noted",
        );
        pass("incomplete event-log retrieval");
    });

    sessionTestWatch.reset();
    installCrashEvents([]);
    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(
            done.eventQuery?.status === "empty" ||
                done.report?.eventQuery?.status === "empty",
            done.eventQuery?.status,
        );
        assert(
            done.report?.unverified?.some((u) =>
                /not proof that no failure/i.test(u),
            ),
            "empty is not proof",
        );
        pass("empty event query confidence");
    });
}


async function testLifecycle() {
    sessionTestWatch.reset();
    installProcessFixture([
        [{ name: "notepad", pid: 3, startedAt: "2026-01-01T00:00:00" }],
    ]);

    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        tryingNow(watch.troubleshootingSessionId);
        iTriedIt(watch.troubleshootingSessionId);
        const first = await stopAndAnalyze(watch.troubleshootingSessionId);
        const second = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(first.report && second.report, "report present");
        assert(
            first.troubleshootingSessionId === second.troubleshootingSessionId,
            "idempotent stop",
        );
        assert(first.tryingNowAt && first.reproductionAttemptAt, "markers");
        assert(first.markersAreUserReported === true, "user-reported markers");

        const inspected = await executeInspectTroubleshootingSession({
            troubleshootingSessionId: first.troubleshootingSessionId,
        });
        assert(inspected.report?.observed?.length > 0, "tool report");
        pass("markers + duplicate stop + inspect tool");
    });

    sessionTestWatch.reset();
    installProcessFixture([
        [{ name: "notepad", pid: 3, startedAt: "2026-01-01T00:00:00" }],
    ]);
    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        interruptAllWatches("server_shutdown");
        const live = sessionTestWatch.watchesById.get(
            watch.troubleshootingSessionId,
        );
        assert(live.status === "interrupted", live.status);
        assert(live.endReason === "server_shutdown", live.endReason);
        pass("abrupt server restart / shutdown interrupt");
    });
}


async function testNoOverlapSampling() {
    sessionTestWatch.reset();
    let concurrent = 0;
    let maxConcurrent = 0;
    windowsTest.setPlatform("win32");
    windowsTest.setRunWindowsCommand(async (spec) => {
        const command = spec.args[spec.args.length - 1] || "";
        if (command.includes("Get-Process")) {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise((r) => setTimeout(r, 80));
            concurrent -= 1;
            return {
                stdout: psProcesses([
                    {
                        name: "notepad",
                        pid: 5,
                        startedAt: "2026-01-01T00:00:00",
                    },
                ]),
                stderr: "",
                exitCode: 0,
            };
        }
        return { stdout: "[]", stderr: "", exitCode: 0 };
    });

    await withSession(async () => {
        const watch = await startWatch({
            processName: "notepad",
            durationMs: 15_000,
        });
        const live = sessionTestWatch.watchesById.get(
            watch.troubleshootingSessionId,
        );
        const a = watchTest.runSampleTick(live);
        const b = watchTest.runSampleTick(live);
        await Promise.all([a, b]);
        assert(maxConcurrent <= 1, `overlap=${maxConcurrent}`);
        await cancelWatch(watch.troubleshootingSessionId);
        pass("no overlapping samples");
    });
}


async function testLiveNotepad() {
    if (process.platform !== "win32") {
        skip("live Notepad", "not Windows");
        return;
    }
    windowsTest.reset();
    sessionTestWatch.reset();
    console.log(
        "LIVE  Open Notepad yourself if you want a live observation (optional).",
    );
    await withSession(async () => {
        const watch = await startWatch({
            preset: "notepad",
            problemDescription: "live optional observation",
            durationMs: 15_000,
        });
        await new Promise((r) => setTimeout(r, 3000));
        const done = await stopAndAnalyze(watch.troubleshootingSessionId);
        assert(done.report, "live report");
        pass(
            "live Notepad watch",
            `outcome=${done.report?.processSummary?.outcome || "n/a"}; events=${done.eventQuery?.status}`,
        );
    });
}


async function main() {
    bootstrapTroubleshootingRuntime();
    windowsTest.reset();
    sessionTestWatch.reset();

    const tests = [
        ["registry", testRegistry],
        ["start/duplicate", testValidStartAndDuplicate],
        ["foreign session", testForeignSession],
        ["process outcomes", testProcessOutcomes],
        ["event correlation", testEventCorrelation],
        ["event empty/incomplete", testEventTimeoutAndEmpty],
        ["lifecycle", testLifecycle],
        ["no overlap", testNoOverlapSampling],
        ["live notepad", testLiveNotepad],
    ];

    for (const [name, fn] of tests) {
        try {
            windowsTest.reset();
            sessionTestWatch.reset();
            await fn();
        } catch (error) {
            fail(name, error.message);
        } finally {
            interruptAllWatches("test_cleanup");
            sessionTestWatch.reset();
            windowsTest.reset();
        }
    }

    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const skipped = results.filter((r) => r.status === "skip").length;
    console.log(
        `\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`,
    );
    process.exitCode = failed > 0 ? 1 : 0;
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
