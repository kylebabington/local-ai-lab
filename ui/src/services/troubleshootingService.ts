import { apiRequest } from "./http";

export interface TroubleshootingPreset {
    id: string;
    label: string;
    processName: string;
}

export interface TroubleshootingSession {
    troubleshootingSessionId: string;
    status: string;
    processName: string;
    targetAppLabel: string;
    problemDescription: string;
    startedAt: string;
    endedAt: string | null;
    durationMs: number;
    elapsedMs: number;
    cancelRequested: boolean;
    reproductionAttemptAt: string | null;
    tryingNowAt: string | null;
    markersAreUserReported: boolean;
    processSummary: {
        outcome: string;
        processCountPresent: number;
        processCountEver: number;
        alreadyRunningBeforeAttempt: boolean;
        newProcessDuringAttempt: boolean;
        inventoryIncomplete: boolean;
    } | null;
    latestSample: {
        at: string;
        processCount: number;
        anyNotResponding: boolean;
        totalWorkingSetBytes: number;
    } | null;
    sampleCount: number;
    samplingGaps: Array<{ at: string; reason: string }>;
    systemPressure: {
        memoryPressure: string | null;
        diskPressure: string | null;
    } | null;
    eventQuery: {
        status: string;
        complete: boolean;
        eventCount: number;
        errorCode: string | null;
    } | null;
    correlatedEvents: Array<{
        time: string;
        id: number | null;
        source: string;
        matchStrength: string;
        faultingApplication: string | null;
        description: string;
    }>;
    report: {
        observed: string[];
        likelyCauses: Array<{
            rank: number;
            hypothesis: string;
            support: string;
            limitation: string;
        }>;
        unverified: string[];
        recommendedNextSteps: string[];
        verification: string[];
        confidence: string;
        limitations: string[];
    } | null;
    confidence: string | null;
    limitations: string[];
    endReason: string | null;
    message: string | null;
}

export async function fetchTroubleshootingPresets(): Promise<
    TroubleshootingPreset[]
> {
    const data = await apiRequest<{ presets: TroubleshootingPreset[] }>(
        "/api/troubleshooting/presets",
    );
    return data.presets ?? [];
}

export async function listTroubleshootingSessions(): Promise<
    TroubleshootingSession[]
> {
    const data = await apiRequest<{ sessions?: TroubleshootingSession[] }>(
        "/api/troubleshooting/sessions",
    );
    return data.sessions ?? [];
}

export async function startTroubleshootingSession(body: {
    preset?: string;
    processName?: string;
    problemDescription?: string;
    durationMs?: number;
}): Promise<TroubleshootingSession> {
    const data = await apiRequest<{ session: TroubleshootingSession }>(
        "/api/troubleshooting/sessions",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );
    return data.session;
}

export async function fetchTroubleshootingSession(
    id: string,
): Promise<TroubleshootingSession> {
    const data = await apiRequest<{ session: TroubleshootingSession }>(
        `/api/troubleshooting/sessions/${encodeURIComponent(id)}`,
    );
    return data.session;
}

export async function markTroubleshootingTryingNow(
    id: string,
): Promise<TroubleshootingSession> {
    const data = await apiRequest<{ session: TroubleshootingSession }>(
        `/api/troubleshooting/sessions/${encodeURIComponent(id)}/trying-now`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        },
    );
    return data.session;
}

export async function markTroubleshootingTried(
    id: string,
): Promise<TroubleshootingSession> {
    const data = await apiRequest<{ session: TroubleshootingSession }>(
        `/api/troubleshooting/sessions/${encodeURIComponent(id)}/tried`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        },
    );
    return data.session;
}

export async function stopTroubleshootingSession(
    id: string,
): Promise<TroubleshootingSession> {
    const data = await apiRequest<{ session: TroubleshootingSession }>(
        `/api/troubleshooting/sessions/${encodeURIComponent(id)}/stop`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        },
    );
    return data.session;
}

export async function cancelTroubleshootingSession(
    id: string,
): Promise<TroubleshootingSession> {
    const data = await apiRequest<{ session: TroubleshootingSession }>(
        `/api/troubleshooting/sessions/${encodeURIComponent(id)}/cancel`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        },
    );
    return data.session;
}
