// =========================================================
// lib/tools/troubleshooting-watch.js
//
// Phase E1 Watch Me Try — serialized read-only monitoring,
// process baseline, event correlation, evidence report.
// =========================================================


import { appendActivity } from "../activity.js";
import { getActiveSession } from "../storage-session.js";
import {
    DEFAULT_WATCH_DURATION_MS,
    MAX_PS_LAUNCHES_PER_WATCH,
    MAX_SAMPLES,
    SAMPLE_INTERVAL_MS,
    clearWatchTimers,
    createWatchSession,
    finalizeWatchStatus,
    getPublicWatch,
    markReproductionAttempt,
    markTryingNow,
    publicWatch,
    requestCancelWatch,
    requestStopWatch,
} from "../troubleshooting-session.js";
import {
    MAX_PROCESSES,
    TROUBLESHOOTING_EVENT_GRACE_MS,
    inspectProcesses,
    inspectSystemHealth,
    queryTroubleshootingCrashEvents,
} from "./windows.js";


function identityKey(pid, startedAt) {
    return `${pid}|${startedAt || "unknown"}`;
}


function processBaseName(name) {
    if (typeof name !== "string") {
        return "";
    }
    return name.toLowerCase().replace(/\.exe$/i, "");
}


function namesLikelyMatch(processName, faultingApplication) {
    if (!faultingApplication) {
        return false;
    }
    const target = processBaseName(processName);
    const fault = processBaseName(String(faultingApplication));
    if (!target || !fault) {
        return false;
    }
    return (
        fault === target ||
        fault.startsWith(`${target}.`) ||
        fault.includes(`\\${target}.`) ||
        fault.endsWith(`\\${target}`) ||
        fault.includes(target)
    );
}


async function sampleTargetProcesses(watch) {
    watch.psLaunches += 1;
    const result = await inspectProcesses({ name: watch.processName });
    const inventoryIncomplete =
        Array.isArray(result.processes) &&
        result.processes.length >= MAX_PROCESSES;
    return {
        queriedAt: new Date().toISOString(),
        processes: result.processes ?? [],
        inventoryIncomplete,
        interpretationLimits: result.interpretationLimits ?? [],
    };
}


function updateIdentities(watch, sample) {
    const seenKeys = new Set();
    const nowIso = sample.queriedAt;

    for (const proc of sample.processes) {
        const pid = proc.pid;
        if (pid == null) {
            continue;
        }
        const key = identityKey(pid, proc.startedAt);
        seenKeys.add(key);
        let identity = watch.processIdentities.get(key);
        if (!identity) {
            identity = {
                pid,
                startedAt: proc.startedAt,
                firstSeenAt: nowIso,
                lastSeenAt: nowIso,
                peakWorkingSetBytes: proc.memoryBytes ?? null,
                lastWorkingSetBytes: proc.memoryBytes ?? null,
                lastCpuSeconds: proc.cpuSeconds ?? null,
                lastStatus: proc.status ?? "unknown",
                everNotResponding: proc.status === "not_responding",
                observedBeforeAttempt: watch.baseline != null
                    ? false
                    : true,
                disappeared: false,
                restarted: false,
            };
            // If baseline already taken, this is a new observation during watch.
            if (watch.baseline) {
                const existedInBaseline = watch.baseline.identities.some(
                    (b) => b.pid === pid && b.startedAt === proc.startedAt,
                );
                identity.observedBeforeAttempt = existedInBaseline;
                if (
                    !existedInBaseline &&
                    watch.baseline.pids.includes(pid)
                ) {
                    // Same PID, different start time → conservative PID reuse / restart.
                    identity.restarted = true;
                }
            }
            watch.processIdentities.set(key, identity);
        } else {
            identity.lastSeenAt = nowIso;
            identity.lastWorkingSetBytes = proc.memoryBytes ?? identity.lastWorkingSetBytes;
            if (
                proc.memoryBytes != null &&
                (identity.peakWorkingSetBytes == null ||
                    proc.memoryBytes > identity.peakWorkingSetBytes)
            ) {
                identity.peakWorkingSetBytes = proc.memoryBytes;
            }
            identity.lastCpuSeconds = proc.cpuSeconds ?? identity.lastCpuSeconds;
            identity.lastStatus = proc.status ?? identity.lastStatus;
            if (proc.status === "not_responding") {
                identity.everNotResponding = true;
            }
            identity.disappeared = false;
        }
    }

    for (const [key, identity] of watch.processIdentities) {
        if (!seenKeys.has(key) && watch.baseline) {
            identity.disappeared = true;
        }
    }
}


function summarizeProcesses(watch) {
    const identities = [...watch.processIdentities.values()];
    const present = identities.filter((i) => !i.disappeared);
    const anyNotResponding = identities.some((i) => i.everNotResponding);
    const anyExited = identities.some((i) => i.disappeared);
    const anyRestarted = identities.some((i) => i.restarted);
    const neverObserved = identities.length === 0;
    const alreadyRunning =
        watch.baseline?.identities?.length > 0 &&
        present.some((i) => i.observedBeforeAttempt);
    const newDuringWatch = present.some((i) => !i.observedBeforeAttempt);

    let outcome = "insufficient_evidence";
    if (neverObserved) {
        outcome = "never_observed";
    } else if (anyNotResponding && present.length > 0) {
        outcome = "observed_not_responding";
    } else if (anyExited && present.length === 0) {
        outcome = "observed_exited";
    } else if (present.length > 0) {
        outcome = "observed_running";
    }

    return {
        outcome,
        processCountPresent: present.length,
        processCountEver: identities.length,
        alreadyRunningBeforeAttempt: alreadyRunning === true,
        newProcessDuringAttempt: newDuringWatch === true,
        processRestarted: anyRestarted,
        processDisappeared: anyExited,
        processRemainedPresent: present.length > 0 && !neverObserved,
        neverObserved,
        inventoryIncomplete: watch.baseline?.inventoryIncomplete === true,
        identities: identities.map((i) => ({
            pid: i.pid,
            startedAt: i.startedAt,
            firstSeenAt: i.firstSeenAt,
            lastSeenAt: i.lastSeenAt,
            peakWorkingSetBytes: i.peakWorkingSetBytes,
            lastWorkingSetBytes: i.lastWorkingSetBytes,
            lastCpuSeconds: i.lastCpuSeconds,
            lastStatus: i.lastStatus,
            everNotResponding: i.everNotResponding,
            observedBeforeAttempt: i.observedBeforeAttempt,
            disappeared: i.disappeared,
            restarted: i.restarted,
        })),
        notes: [
            "Multiple same-name processes are treated as one application group (e.g. Electron), not separate launches.",
            "PID reuse is handled conservatively using start-time identity when available.",
            "Process presence is not proof of health. Process exit is not automatically a crash.",
            "cpuSeconds values are cumulative since process start, not instantaneous utilization.",
        ],
    };
}


function correlateEvents(watch, eventQuery) {
    const correlated = [];
    if (!eventQuery?.events?.length) {
        return correlated;
    }

    const pids = new Set(
        [...watch.processIdentities.values()].map((i) => i.pid).filter(Boolean),
    );

    for (const event of eventQuery.events) {
        const appMatch = namesLikelyMatch(
            watch.processName,
            event.faultingApplication,
        );
        const pidMatch =
            event.faultingProcessId != null &&
            pids.has(event.faultingProcessId);

        let matchStrength = "temporal_only";
        if (appMatch && pidMatch) {
            matchStrength = "confirmed";
        } else if (appMatch) {
            matchStrength = "possible_application";
        } else if (pidMatch) {
            matchStrength = "possible_pid";
        }

        // Never claim membership on time alone as confirmed.
        correlated.push({
            ...event,
            matchStrength,
            werAloneNotProofOfCrash: event.id === 1001,
            note:
                matchStrength === "temporal_only"
                    ? "Time proximity only — not attributed to the watched application."
                    : matchStrength === "confirmed"
                      ? "Matched faulting application and PID evidence."
                      : "Weaker correlation; not established as fact.",
        });
    }

    return correlated;
}


function buildReport(watch) {
    const summary = watch.processSummary;
    const observed = [];
    const likely = [];
    const unverified = [];
    const nextSteps = [];
    const verification = [];

    observed.push(
        `Watch target: ${watch.targetAppLabel} (process name ${watch.processName}).`,
    );
    observed.push(
        `Monitoring window: ${watch.startedAt} → ${watch.endedAt || "in progress"} (${watch.durationMs}ms budget).`,
    );
    observed.push(`Samples collected: ${watch.samples.length}.`);
    if (watch.samplingGaps.length) {
        observed.push(
            `Sampling gaps recorded: ${watch.samplingGaps.length} (slow diagnostics reduced frequency; gaps are not fabricated samples).`,
        );
    }
    if (watch.tryingNowAt) {
        observed.push(
            `User-reported "Trying now" marker at ${watch.tryingNowAt} (not exact launch time).`,
        );
    }
    if (watch.reproductionAttemptAt) {
        observed.push(
            `User-reported "I tried it" marker at ${watch.reproductionAttemptAt} (not exact crash/launch time).`,
        );
    }

    if (summary) {
        observed.push(`Process outcome classification: ${summary.outcome}.`);
        observed.push(
            `Process inventory: ${summary.processCountPresent} present / ${summary.processCountEver} ever observed` +
                (summary.inventoryIncomplete
                    ? " (inventory incomplete — capped query)."
                    : ".") ,
        );
        if (summary.alreadyRunningBeforeAttempt) {
            observed.push(
                "At least one matching process was already running before the reproduction attempt.",
            );
        }
        if (summary.newProcessDuringAttempt) {
            observed.push(
                "A new matching process identity appeared during the watch.",
            );
        }
        if (summary.processRestarted) {
            observed.push(
                "A PID appeared with a changed start time (conservative restart / PID-reuse signal).",
            );
        }
        if (summary.processDisappeared) {
            observed.push(
                "At least one previously observed process identity disappeared.",
            );
        }
    }

    if (watch.systemPressure) {
        observed.push(
            `System pressure snapshot: memory=${watch.systemPressure.memoryPressure ?? "n/a"}, disk=${watch.systemPressure.diskPressure ?? "n/a"}.`,
        );
    }

    if (watch.eventQuery) {
        observed.push(
            `Crash/hang event query status: ${watch.eventQuery.status}` +
                (watch.eventQuery.complete ? " (complete)." : " (incomplete)."),
        );
        const confirmed = (watch.correlatedEvents || []).filter(
            (e) => e.matchStrength === "confirmed",
        );
        const possible = (watch.correlatedEvents || []).filter(
            (e) =>
                e.matchStrength === "possible_application" ||
                e.matchStrength === "possible_pid",
        );
        const temporal = (watch.correlatedEvents || []).filter(
            (e) => e.matchStrength === "temporal_only",
        );
        if (confirmed.length) {
            observed.push(
                `Confirmed application-correlated events: ${confirmed.length}.`,
            );
        }
        if (possible.length) {
            observed.push(
                `Weaker correlated events: ${possible.length} (not established facts).`,
            );
        }
        if (temporal.length) {
            observed.push(
                `Temporally nearby events not attributed to the app: ${temporal.length}.`,
            );
        }
        if (watch.eventQuery.status === "empty") {
            unverified.push(
                "No matching Application Error / WER / Hang / .NET events in the bounded window. This is not proof that no failure occurred.",
            );
        }
        if (
            watch.eventQuery.status === "timed_out" ||
            watch.eventQuery.status === "unavailable" ||
            watch.eventQuery.status === "incomplete"
        ) {
            unverified.push(
                `Event-log retrieval ${watch.eventQuery.status}` +
                    (watch.eventQuery.errorMessage
                        ? `: ${watch.eventQuery.errorMessage}`
                        : "."),
            );
        }
    }

    // Hypotheses — ranked, evidence-limited
    if (summary?.outcome === "observed_not_responding") {
        likely.push({
            rank: 1,
            hypothesis: "The application UI became unresponsive during the watch.",
            support: "Get-Process Responding=false on at least one sample.",
            limitation:
                "Not-responding does not identify the root cause (UI hang vs main-thread stall vs other).",
        });
    }
    const confirmedHang = (watch.correlatedEvents || []).find(
        (e) => e.id === 1002 && e.matchStrength === "confirmed",
    );
    if (confirmedHang) {
        likely.push({
            rank: 1,
            hypothesis: "Windows recorded an Application Hang for this app.",
            support: `Event 1002 at ${confirmedHang.time} with matching faulting application.`,
            limitation: "Hang event confirms hang reporting, not the underlying bug.",
        });
    }
    const confirmedError = (watch.correlatedEvents || []).find(
        (e) => e.id === 1000 && e.matchStrength === "confirmed",
    );
    if (confirmedError) {
        likely.push({
            rank: 1,
            hypothesis: "Windows recorded an Application Error for this app.",
            support: `Event 1000 at ${confirmedError.time} with matching faulting application` +
                (confirmedError.faultingModule
                    ? ` (module ${confirmedError.faultingModule}).`
                    : "."),
            limitation: "Faulting module is a hint, not a confirmed root cause.",
        });
    }
    const werOnly = (watch.correlatedEvents || []).filter(
        (e) => e.id === 1001 && e.matchStrength !== "temporal_only",
    );
    if (werOnly.length && !confirmedError) {
        likely.push({
            rank: 2,
            hypothesis: "Windows Error Reporting recorded a related report.",
            support: "WER event 1001 correlated by application/PID fields.",
            limitation:
                "WER 1001 alone does not prove a crash; treat as supporting context only.",
        });
    }
    if (summary?.outcome === "observed_exited" && !confirmedError && !werOnly.length) {
        likely.push({
            rank: 2,
            hypothesis: "The process exited during the watch without a matching crash event in the bounded window.",
            support: "Process identity disappeared from subsequent samples.",
            limitation:
                "Exit is not automatically a crash; event log may be delayed, incomplete, or unrelated.",
        });
    }
    if (summary?.outcome === "never_observed") {
        likely.push({
            rank: 2,
            hypothesis: "The target process never appeared during the watch.",
            support: "All samples returned no matching processes.",
            limitation:
                "The app may use a different process name, failed to start, or was not launched during the window.",
        });
    }
    if (summary?.alreadyRunningBeforeAttempt && !summary?.newProcessDuringAttempt) {
        likely.push({
            rank: 3,
            hypothesis: "An existing instance was observed rather than a fresh launch.",
            support: "Baseline already contained matching process identities.",
            limitation:
                "Do not claim a new launch succeeded merely because an existing process was present.",
        });
    }
    if (!likely.length) {
        likely.push({
            rank: 3,
            hypothesis: "Insufficient distinctive failure evidence in this watch.",
            support: "No strong process+event combination established a specific failure mode.",
            limitation: "Recommend another watch with a clearer reproduction or longer window (still ≤120s).",
        });
    }

    nextSteps.push(
        "Retry the Watch Me Try session and click Trying now immediately before reproducing, then I tried it after.",
    );
    nextSteps.push(
        "Confirm the process name matches what Task Manager shows for the app.",
    );
    nextSteps.push(
        "Check recent Application events in Event Viewer yourself for Application Error / Windows Error Reporting around the attempt.",
    );
    nextSteps.push(
        "If the app is Electron-based, expect multiple same-name processes; focus on hang/error events rather than process count.",
    );
    nextSteps.push(
        "Avoid force-killing or repairing until evidence points to a specific actionable cause.",
    );

    verification.push(
        "Reproduce once more under Watch Me Try and compare process outcome + correlated events.",
    );
    verification.push(
        "Success means the failure no longer appears in samples and no new confirmed Application Error/Hang events for this app appear in the watch window.",
    );

    const limitations = [
        ...(summary?.notes ?? []),
        ...(watch.eventQuery?.interpretationLimits ?? []),
        "Markers are user-reported timestamps, not exact OS launch/crash times.",
        "Correlation uses the full watch interval (± grace), not the marker alone.",
        "In-memory watches do not survive server restart.",
        "Ollama may prioritize hypotheses but must not invent observations.",
    ];

    let confidence = "low";
    if (
        confirmedError ||
        confirmedHang ||
        (summary?.outcome === "observed_not_responding" &&
            summary.processCountPresent > 0)
    ) {
        confidence = "medium";
    }
    if (
        watch.eventQuery &&
        !watch.eventQuery.complete &&
        watch.samples.length < 2
    ) {
        confidence = "low";
    }

    return {
        observed,
        likelyCauses: likely.sort((a, b) => a.rank - b.rank),
        unverified,
        recommendedNextSteps: nextSteps,
        verification,
        confidence,
        limitations,
        processBaseline: watch.baseline,
        processSummary: summary,
        sampling: {
            sampleCount: watch.samples.length,
            gaps: watch.samplingGaps,
            psLaunches: watch.psLaunches,
        },
        eventQuery: watch.eventQuery
            ? {
                  status: watch.eventQuery.status,
                  complete: watch.eventQuery.complete,
                  truncated: watch.eventQuery.truncated,
                  windowStart: watch.eventQuery.windowStart,
                  windowEnd: watch.eventQuery.windowEnd,
                  errorCode: watch.eventQuery.errorCode,
              }
            : null,
        correlatedEvents: watch.correlatedEvents,
        systemPressure: watch.systemPressure,
        markers: {
            tryingNowAt: watch.tryingNowAt,
            reproductionAttemptAt: watch.reproductionAttemptAt,
            userReported: true,
        },
    };
}


async function takeSystemPressure(watch) {
    try {
        watch.psLaunches += 0; // health uses Node APIs
        const health = await inspectSystemHealth({});
        const memoryPressure =
            health.pressure?.find((p) => p.resource === "memory")?.level ??
            null;
        const diskPressure =
            health.pressure?.find((p) => p.resource === "disk")?.level ?? null;
        watch.systemPressure = {
            at: new Date().toISOString(),
            memoryPressure,
            diskPressure,
            memoryAvailableBytes: health.memory?.availableBytes ?? null,
            memoryTotalBytes: health.memory?.totalBytes ?? null,
        };
    } catch {
        watch.systemPressure = {
            at: new Date().toISOString(),
            memoryPressure: null,
            diskPressure: null,
            error: "system_health_unavailable",
        };
    }
}


async function runSampleTick(watch) {
    if (watch.cancelRequested || watch.stopRequested) {
        return;
    }
    if (watch.status !== "watching") {
        return;
    }
    if (watch.sampleInFlight) {
        return;
    }
    if (watch.psLaunches >= MAX_PS_LAUNCHES_PER_WATCH) {
        watch.samplingGaps.push({
            at: new Date().toISOString(),
            reason: "ps_launch_budget_exhausted",
        });
        return;
    }
    if (watch.samples.length >= MAX_SAMPLES) {
        return;
    }

    watch.sampleInFlight = true;
    const tickStarted = Date.now();
    try {
        const sample = await sampleTargetProcesses(watch);
        if (watch.cancelRequested || watch.status !== "watching") {
            return;
        }
        updateIdentities(watch, sample);
        const compact = {
            at: sample.queriedAt,
            intervalMs: watch.samples.length
                ? Date.parse(sample.queriedAt) -
                  Date.parse(watch.samples[watch.samples.length - 1].at)
                : null,
            processCount: sample.processes.length,
            inventoryIncomplete: sample.inventoryIncomplete,
            pids: sample.processes.map((p) => p.pid).filter((p) => p != null),
            anyNotResponding: sample.processes.some(
                (p) => p.status === "not_responding",
            ),
            totalWorkingSetBytes: sample.processes.reduce(
                (sum, p) => sum + (p.memoryBytes ?? 0),
                0,
            ),
        };
        watch.samples.push(compact);

        if (!watch.baseline) {
            watch.baseline = {
                at: sample.queriedAt,
                inventoryIncomplete: sample.inventoryIncomplete,
                pids: compact.pids,
                identities: [...watch.processIdentities.values()].map((i) => ({
                    pid: i.pid,
                    startedAt: i.startedAt,
                    workingSetBytes: i.lastWorkingSetBytes,
                    status: i.lastStatus,
                })),
            };
            // Mark baseline identities as pre-existing
            for (const identity of watch.processIdentities.values()) {
                identity.observedBeforeAttempt = true;
            }
        }
    } catch (error) {
        watch.samplingGaps.push({
            at: new Date().toISOString(),
            reason: error.code || "sample_failed",
            detail: error.message,
            plannedIntervalMs: SAMPLE_INTERVAL_MS,
            actualWaitMs: Date.now() - tickStarted,
        });
    } finally {
        watch.sampleInFlight = false;
    }
}


function scheduleNextSample(watch) {
    clearTimeout(watch.sampleTimer);
    watch.sampleTimer = null;
    if (
        watch.cancelRequested ||
        watch.stopRequested ||
        watch.status !== "watching"
    ) {
        return;
    }
    watch.sampleTimer = setTimeout(() => {
        void (async () => {
            await runSampleTick(watch);
            scheduleNextSample(watch);
        })();
    }, SAMPLE_INTERVAL_MS);
}


async function analyzeWatch(watch, endReason) {
    if (watch.analysisCompleted && watch.report) {
        return watch;
    }
    if (watch.analysisStarted && watch.report) {
        return watch;
    }
    watch.analysisStarted = true;
    watch.status = "analyzing";
    clearWatchTimers(watch);

    // Wait for in-flight sample to finish (no overlap / no cancel of PS mid-flight beyond timeout).
    const waitStart = Date.now();
    while (watch.sampleInFlight && Date.now() - waitStart < 15_000) {
        await new Promise((r) => setTimeout(r, 50));
    }

    if (!watch.baseline && watch.samples.length === 0) {
        const previousStatus = watch.status;
        watch.status = "watching";
        const prevCancel = watch.cancelRequested;
        const prevStop = watch.stopRequested;
        watch.cancelRequested = false;
        watch.stopRequested = false;
        try {
            await runSampleTick(watch);
        } catch {
            // ignore — will reflect insufficient evidence
        } finally {
            watch.cancelRequested = prevCancel;
            watch.stopRequested = prevStop;
            watch.status = previousStatus;
        }
    }

    // One more identity summary from last state
    watch.processSummary = summarizeProcesses(watch);
    await takeSystemPressure(watch);

    const windowStart = new Date(watch.startedAtMs);
    const windowEnd = new Date(
        Math.min(Date.now(), watch.startedAtMs + watch.durationMs) +
            TROUBLESHOOTING_EVENT_GRACE_MS,
    );

    watch.eventQuery = await queryTroubleshootingCrashEvents({
        windowStart,
        windowEnd,
    });
    watch.correlatedEvents = correlateEvents(watch, watch.eventQuery);
    watch.report = buildReport(watch);
    watch.confidence = watch.report.confidence;
    watch.limitations = watch.report.limitations;
    watch.analysisCompleted = true;

    const terminal =
        endReason === "user_cancel"
            ? "cancelled"
            : endReason === "session_expiration"
              ? "expired"
              : endReason === "server_shutdown" || endReason === "abrupt_termination"
                ? "interrupted"
                : "completed";

    finalizeWatchStatus(watch, endReason, terminal);
    watch.message =
        terminal === "completed"
            ? "Watch finished. Review the evidence-based report."
            : `Watch ended (${endReason}). Partial evidence preserved when available.`;

    await appendActivity({
        type: "troubleshooting_watch",
        tool: "watch_me_try",
        status: terminal,
        summary: `Watch Me Try ${terminal} for ${watch.processName}`,
        details: {
            troubleshootingSessionId: watch.id,
            endReason,
            outcome: watch.processSummary?.outcome,
            eventQueryStatus: watch.eventQuery?.status,
            sampleCount: watch.samples.length,
        },
    });

    return watch;
}


export async function startWatch(args, session = getActiveSession()) {
    const watch = createWatchSession(args, session);

    // Baseline sample immediately, then schedule subsequent ticks after completion.
    setImmediate(() => {
        void (async () => {
            await runSampleTick(watch);
            scheduleNextSample(watch);
        })();
    });

    watch.deadlineTimer = setTimeout(() => {
        void (async () => {
            if (watch.status === "watching") {
                await analyzeWatch(watch, "duration_elapsed");
            }
        })();
    }, watch.durationMs);

    await appendActivity({
        type: "troubleshooting_watch",
        tool: "watch_me_try",
        status: "start",
        summary: `Started Watch Me Try for ${watch.processName}`,
        details: {
            troubleshootingSessionId: watch.id,
            durationMs: watch.durationMs,
        },
    });

    return publicWatch(watch);
}


export async function stopAndAnalyze(watchId, session = getActiveSession()) {
    const watch = requestStopWatch(watchId, session);
    if (watch.analysisCompleted && watch.report) {
        return publicWatch(watch);
    }
    await analyzeWatch(watch, "user_stop");
    return publicWatch(watch);
}


export async function cancelWatch(watchId, session = getActiveSession()) {
    const watch = requestCancelWatch(watchId, session);
    if (watch.analysisCompleted) {
        return publicWatch(watch);
    }
    await analyzeWatch(watch, "user_cancel");
    return publicWatch(watch);
}


export function tryingNow(watchId, session = getActiveSession()) {
    return publicWatch(markTryingNow(watchId, session));
}


export function iTriedIt(watchId, session = getActiveSession()) {
    return publicWatch(markReproductionAttempt(watchId, session));
}


export function validateInspectTroubleshootingSession(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Arguments must be an object.");
    }
    const keys = Object.keys(args);
    const unexpected = keys.filter((k) => k !== "troubleshootingSessionId");
    if (unexpected.length) {
        throw new Error(`Unexpected argument(s): ${unexpected.join(", ")}.`);
    }
    if (
        typeof args.troubleshootingSessionId !== "string" ||
        !args.troubleshootingSessionId.trim()
    ) {
        throw new Error("troubleshootingSessionId is required.");
    }
    return {
        troubleshootingSessionId: args.troubleshootingSessionId.trim(),
    };
}


export async function executeInspectTroubleshootingSession(args) {
    const { troubleshootingSessionId } =
        validateInspectTroubleshootingSession(args);
    const watch = getPublicWatch(troubleshootingSessionId);
    if (!watch) {
        throw Object.assign(new Error("Unknown troubleshooting session."), {
            code: "UNKNOWN_WATCH",
            status: 404,
        });
    }

    // Compact payload for Ollama — no raw unbounded dumps.
    return {
        untrusted: true,
        tool: "inspect_troubleshooting_session",
        troubleshootingSessionId: watch.troubleshootingSessionId,
        status: watch.status,
        processName: watch.processName,
        targetAppLabel: watch.targetAppLabel,
        problemDescription: watch.problemDescription,
        startedAt: watch.startedAt,
        endedAt: watch.endedAt,
        endReason: watch.endReason,
        markersAreUserReported: true,
        reproductionAttemptAt: watch.reproductionAttemptAt,
        tryingNowAt: watch.tryingNowAt,
        processSummary: watch.report?.processSummary ?? watch.processSummary,
        sampling: watch.report?.sampling ?? {
            sampleCount: watch.sampleCount,
            gaps: watch.samplingGaps,
        },
        eventQuery: watch.report?.eventQuery ?? watch.eventQuery,
        correlatedEvents: (watch.correlatedEvents || [])
            .filter((e) => e.matchStrength !== "temporal_only")
            .slice(0, 10),
        report: watch.report
            ? {
                  observed: watch.report.observed,
                  likelyCauses: watch.report.likelyCauses,
                  unverified: watch.report.unverified,
                  recommendedNextSteps: watch.report.recommendedNextSteps,
                  verification: watch.report.verification,
                  confidence: watch.report.confidence,
                  limitations: watch.report.limitations,
              }
            : null,
        interpretationLimits: [
            "Cite only facts in observed[]. likelyCauses are hypotheses with limitations.",
            "Do not invent crash reports or faulting modules.",
            "Empty event queries are not proof of no crash.",
            "User markers are not exact OS timestamps.",
        ],
    };
}


export const _test = {
    identityKey,
    namesLikelyMatch,
    correlateEvents,
    summarizeProcesses,
    buildReport,
    updateIdentities,
    runSampleTick,
    analyzeWatch,
    SAMPLE_INTERVAL_MS,
    DEFAULT_WATCH_DURATION_MS,
};
