// =========================================================
// lib/troubleshooting-session.js
//
// Phase E1 Watch Me Try — in-memory diagnostic watch sessions.
// Bound to the HttpOnly browser session cookie. One active watch.
// =========================================================


import crypto from "node:crypto";

import {
    getActiveSession,
    setTroubleshootingSessionHooks,
} from "./storage-session.js";


export const DEFAULT_WATCH_DURATION_MS = 90_000;
export const MAX_WATCH_DURATION_MS = 120_000;
export const MIN_WATCH_DURATION_MS = 15_000;
export const SAMPLE_INTERVAL_MS = 2_500;
export const MAX_SAMPLES = 40;
export const MAX_PS_LAUNCHES_PER_WATCH = 60;

/** @type {Map<string, object>} */
const watchesById = new Map();

/** @type {string | null} */
let activeWatchId = null;

let bootstrapped = false;


function watchError(message, code, status = 400) {
    return Object.assign(new Error(message), { code, status });
}


export const APP_PRESETS = [
    { id: "cursor", label: "Cursor", processName: "Cursor" },
    { id: "vscode", label: "VS Code", processName: "Code" },
    { id: "firefox", label: "Firefox", processName: "firefox" },
    { id: "chrome", label: "Chrome", processName: "chrome" },
    { id: "notepad", label: "Notepad", processName: "notepad" },
];


export function resolveProcessName({ preset, processName } = {}) {
    if (typeof preset === "string" && preset.trim()) {
        const found = APP_PRESETS.find(
            (p) => p.id === preset.trim().toLowerCase(),
        );
        if (!found) {
            throw watchError("Unknown application preset.", "UNKNOWN_PRESET");
        }
        return { processName: found.processName, targetAppLabel: found.label };
    }

    if (typeof processName !== "string" || !processName.trim()) {
        throw watchError(
            "Provide a preset or an exact process name.",
            "PROCESS_NAME_REQUIRED",
        );
    }

    let name = processName.trim();
    if (name.toLowerCase().endsWith(".exe")) {
        name = name.slice(0, -4);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw watchError(
            "Process name must be an exact name without wildcards.",
            "INVALID_PROCESS_NAME",
        );
    }
    return { processName: name, targetAppLabel: name };
}


export function publicWatch(watch) {
    if (!watch) {
        return null;
    }
    return {
        troubleshootingSessionId: watch.id,
        status: watch.status,
        processName: watch.processName,
        targetAppLabel: watch.targetAppLabel,
        problemDescription: watch.problemDescription,
        startedAt: watch.startedAt,
        endedAt: watch.endedAt,
        durationMs: watch.durationMs,
        elapsedMs: watch.startedAtMs
            ? Math.min(
                  Date.now() - watch.startedAtMs,
                  watch.durationMs,
              )
            : 0,
        cancelRequested: watch.cancelRequested === true,
        reproductionAttemptAt: watch.reproductionAttemptAt,
        tryingNowAt: watch.tryingNowAt,
        markersAreUserReported: true,
        processSummary: watch.processSummary ?? null,
        latestSample: watch.samples?.length
            ? watch.samples[watch.samples.length - 1]
            : null,
        sampleCount: watch.samples?.length ?? 0,
        samplingGaps: watch.samplingGaps ?? [],
        systemPressure: watch.systemPressure ?? null,
        eventQuery: watch.eventQuery
            ? {
                  status: watch.eventQuery.status,
                  complete: watch.eventQuery.complete,
                  truncated: watch.eventQuery.truncated,
                  windowStart: watch.eventQuery.windowStart,
                  windowEnd: watch.eventQuery.windowEnd,
                  eventCount: watch.eventQuery.events?.length ?? 0,
                  errorCode: watch.eventQuery.errorCode,
              }
            : null,
        correlatedEvents: watch.correlatedEvents ?? [],
        report: watch.report ?? null,
        confidence: watch.confidence ?? null,
        limitations: watch.limitations ?? [],
        endReason: watch.endReason ?? null,
        message: watch.message ?? null,
    };
}


function getOwnedWatch(watchId, session = getActiveSession()) {
    if (!session?.id) {
        throw watchError("No active browser session.", "NO_SESSION", 401);
    }
    const watch = watchesById.get(watchId);
    if (!watch || watch.sessionId !== session.id) {
        return null;
    }
    return watch;
}


export function getPublicWatch(watchId, session = getActiveSession()) {
    return publicWatch(getOwnedWatch(watchId, session));
}


export function listPublicWatches(session = getActiveSession()) {
    if (!session?.id) {
        return [];
    }
    return [...watchesById.values()]
        .filter((w) => w.sessionId === session.id)
        .map(publicWatch);
}


/**
 * Atomic start — exactly one active watch globally.
 */
export function createWatchSession(args, session = getActiveSession()) {
    if (!session?.id) {
        throw watchError("No active browser session.", "NO_SESSION", 401);
    }
    if (activeWatchId && watchesById.has(activeWatchId)) {
        const existing = watchesById.get(activeWatchId);
        if (
            existing &&
            (existing.status === "watching" || existing.status === "analyzing")
        ) {
            throw watchError(
                "Another troubleshooting watch is already active.",
                "WATCH_IN_PROGRESS",
                409,
            );
        }
    }

    const { processName, targetAppLabel } = resolveProcessName(args);
    let durationMs = DEFAULT_WATCH_DURATION_MS;
    if (args.durationMs != null) {
        durationMs = Math.trunc(Number(args.durationMs));
        if (
            !Number.isFinite(durationMs) ||
            durationMs < MIN_WATCH_DURATION_MS ||
            durationMs > MAX_WATCH_DURATION_MS
        ) {
            throw watchError(
                `durationMs must be between ${MIN_WATCH_DURATION_MS} and ${MAX_WATCH_DURATION_MS}.`,
                "INVALID_DURATION",
            );
        }
    }

    const problemDescription =
        typeof args.problemDescription === "string"
            ? args.problemDescription.trim().slice(0, 500)
            : "";

    const id = crypto.randomUUID();
    const now = Date.now();
    const watch = {
        id,
        sessionId: session.id,
        processName,
        targetAppLabel,
        problemDescription,
        status: "watching",
        startedAt: new Date(now).toISOString(),
        startedAtMs: now,
        endedAt: null,
        durationMs,
        cancelRequested: false,
        stopRequested: false,
        analysisStarted: false,
        analysisCompleted: false,
        reproductionAttemptAt: null,
        tryingNowAt: null,
        samples: [],
        samplingGaps: [],
        processIdentities: new Map(),
        baseline: null,
        processSummary: null,
        systemPressure: null,
        eventQuery: null,
        correlatedEvents: [],
        report: null,
        confidence: null,
        limitations: [],
        endReason: null,
        message: "Watching. Reproduce the problem, then stop to analyze.",
        psLaunches: 0,
        sampleInFlight: false,
        sampleTimer: null,
        deadlineTimer: null,
        abortSample: null,
    };

    watchesById.set(id, watch);
    activeWatchId = id;

    if (!session.troubleshootingWatches) {
        session.troubleshootingWatches = new Map();
    }
    session.troubleshootingWatches.set(id, watch);

    return watch;
}


export function markTryingNow(watchId, session = getActiveSession()) {
    const watch = getOwnedWatch(watchId, session);
    if (!watch) {
        throw watchError("Unknown troubleshooting session.", "UNKNOWN_WATCH", 404);
    }
    if (watch.status !== "watching") {
        throw watchError(
            "Watch is not active.",
            "WATCH_NOT_ACTIVE",
            409,
        );
    }
    watch.tryingNowAt = new Date().toISOString();
    return watch;
}


export function markReproductionAttempt(watchId, session = getActiveSession()) {
    const watch = getOwnedWatch(watchId, session);
    if (!watch) {
        throw watchError("Unknown troubleshooting session.", "UNKNOWN_WATCH", 404);
    }
    if (watch.status !== "watching") {
        throw watchError(
            "Watch is not active.",
            "WATCH_NOT_ACTIVE",
            409,
        );
    }
    watch.reproductionAttemptAt = new Date().toISOString();
    return watch;
}


export function requestCancelWatch(watchId, session = getActiveSession()) {
    const watch = getOwnedWatch(watchId, session);
    if (!watch) {
        throw watchError("Unknown troubleshooting session.", "UNKNOWN_WATCH", 404);
    }
    if (
        watch.status === "completed" ||
        watch.status === "cancelled" ||
        watch.status === "expired" ||
        watch.status === "interrupted"
    ) {
        return watch;
    }
    watch.cancelRequested = true;
    clearWatchTimers(watch);
    return watch;
}


export function requestStopWatch(watchId, session = getActiveSession()) {
    const watch = getOwnedWatch(watchId, session);
    if (!watch) {
        throw watchError("Unknown troubleshooting session.", "UNKNOWN_WATCH", 404);
    }
    if (watch.analysisCompleted && watch.report) {
        return watch;
    }
    watch.stopRequested = true;
    clearWatchTimers(watch);
    return watch;
}


export function clearWatchTimers(watch) {
    if (watch.sampleTimer) {
        clearTimeout(watch.sampleTimer);
        watch.sampleTimer = null;
    }
    if (watch.deadlineTimer) {
        clearTimeout(watch.deadlineTimer);
        watch.deadlineTimer = null;
    }
}


export function finalizeWatchStatus(watch, endReason, status) {
    clearWatchTimers(watch);
    watch.endReason = endReason;
    watch.status = status;
    watch.endedAt = watch.endedAt || new Date().toISOString();
    if (activeWatchId === watch.id) {
        activeWatchId = null;
    }
}


function endWatchesForSession(session, reason) {
    if (!session?.troubleshootingWatches) {
        return;
    }
    for (const watch of session.troubleshootingWatches.values()) {
        if (
            watch.status === "watching" ||
            watch.status === "analyzing"
        ) {
            watch.cancelRequested = true;
            clearWatchTimers(watch);
            finalizeWatchStatus(
                watch,
                reason === "session_expired" ? "session_expiration" : reason,
                reason === "session_expired" ? "expired" : "interrupted",
            );
            watch.message = `Watch ended (${watch.endReason}).`;
        }
    }
}


export function interruptAllWatches(reason = "server_shutdown") {
    for (const watch of watchesById.values()) {
        if (watch.status === "watching" || watch.status === "analyzing") {
            watch.cancelRequested = true;
            clearWatchTimers(watch);
            finalizeWatchStatus(watch, reason, "interrupted");
            watch.message = `Watch interrupted (${reason}). In-memory watches do not survive restart.`;
        }
    }
    activeWatchId = null;
}


export function bootstrapTroubleshootingRuntime() {
    if (bootstrapped) {
        return;
    }
    bootstrapped = true;
    setTroubleshootingSessionHooks({
        endSessionTroubleshootingWatches: endWatchesForSession,
    });
    // Prior in-memory watches cannot survive restart; nothing to recover.
}


export const _test = {
    watchesById,
    getActiveWatchId: () => activeWatchId,
    setActiveWatchId: (id) => {
        activeWatchId = id;
    },
    reset() {
        for (const watch of watchesById.values()) {
            clearWatchTimers(watch);
        }
        watchesById.clear();
        activeWatchId = null;
    },
};
