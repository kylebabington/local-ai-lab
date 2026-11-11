import { useEffect, useMemo, useState } from "react";

import {
    cancelTroubleshootingSession,
    fetchTroubleshootingPresets,
    fetchTroubleshootingSession,
    markTroubleshootingTried,
    markTroubleshootingTryingNow,
    startTroubleshootingSession,
    stopTroubleshootingSession,
    type TroubleshootingPreset,
    type TroubleshootingSession,
} from "../services/troubleshootingService";

interface TroubleshootingPanelProps {
    computerBusy?: boolean;
}

function formatBytes(bytes: number | null | undefined): string {
    if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) < 0) {
        return "—";
    }
    const value = bytes as number;
    if (value < 1024) {
        return `${value} B`;
    }
    const units = ["KB", "MB", "GB"];
    let scaled = value / 1024;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
    }
    return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function TroubleshootingPanel({
    computerBusy = false,
}: TroubleshootingPanelProps) {
    const [presets, setPresets] = useState<TroubleshootingPreset[]>([]);
    const [presetId, setPresetId] = useState("notepad");
    const [customProcess, setCustomProcess] = useState("");
    const [problem, setProblem] = useState("");
    const [session, setSession] = useState<TroubleshootingSession | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void fetchTroubleshootingPresets()
            .then((list) => {
                setPresets(list);
                if (list.length && !list.some((p) => p.id === presetId)) {
                    setPresetId(list[0].id);
                }
            })
            .catch(() => {
                // presets optional for custom names
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (
            !session ||
            computerBusy ||
            (session.status !== "watching" && session.status !== "analyzing")
        ) {
            return;
        }
        const timer = setInterval(() => {
            void fetchTroubleshootingSession(session.troubleshootingSessionId)
                .then(setSession)
                .catch(() => {
                    // ignore transient poll errors
                });
        }, 2000);
        return () => clearInterval(timer);
    }, [session, computerBusy]);

    const elapsedLabel = useMemo(() => {
        if (!session) {
            return "";
        }
        const elapsed = Math.round((session.elapsedMs || 0) / 1000);
        const budget = Math.round(session.durationMs / 1000);
        return `${elapsed}s / ${budget}s`;
    }, [session]);

    async function handleStart() {
        setBusy(true);
        setError(null);
        try {
            const body =
                customProcess.trim().length > 0
                    ? {
                          processName: customProcess.trim(),
                          problemDescription: problem,
                      }
                    : {
                          preset: presetId,
                          problemDescription: problem,
                      };
            const started = await startTroubleshootingSession(body);
            setSession(started);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not start watching.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function run(
        action: () => Promise<TroubleshootingSession>,
        fallback: string,
    ) {
        setBusy(true);
        setError(null);
        try {
            setSession(await action());
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : fallback);
        } finally {
            setBusy(false);
        }
    }

    return (
        <article className="storage-offload-panel">
            <header className="storage-offload-header">
                <div>
                    <h2>Watch Me Try</h2>
                    <p>
                        Start a short read-only watch, reproduce the problem
                        yourself, then review evidence. Local AI does not launch,
                        kill, or repair applications in this phase.
                    </p>
                </div>
            </header>

            {error ? (
                <div className="banner banner-error" role="alert">
                    <strong>Watch error</strong>
                    <p>{error}</p>
                </div>
            ) : null}

            {!session ||
            ["completed", "cancelled", "expired", "interrupted"].includes(
                session.status,
            ) ? (
                <div className="storage-offload-controls">
                    <label>
                        Application preset
                        <select
                            value={presetId}
                            disabled={busy || computerBusy}
                            onChange={(event) =>
                                setPresetId(event.target.value)
                            }
                        >
                            {presets.map((preset) => (
                                <option key={preset.id} value={preset.id}>
                                    {preset.label} ({preset.processName})
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Or exact process name
                        <input
                            type="text"
                            value={customProcess}
                            disabled={busy || computerBusy}
                            placeholder="e.g. notepad"
                            onChange={(event) =>
                                setCustomProcess(event.target.value)
                            }
                        />
                    </label>
                    <label>
                        What goes wrong?
                        <textarea
                            value={problem}
                            disabled={busy || computerBusy}
                            rows={3}
                            placeholder="Cursor crashes when I open a project…"
                            onChange={(event) => setProblem(event.target.value)}
                        />
                    </label>
                    <div className="storage-offload-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy || computerBusy}
                            onClick={() => void handleStart()}
                        >
                            Start Watching
                        </button>
                    </div>
                </div>
            ) : null}

            {session ? (
                <div className="storage-offload-table-wrap">
                    <p>
                        Status: <strong>{session.status}</strong> · Target{" "}
                        <code>{session.targetAppLabel}</code> (
                        <code>{session.processName}</code>) · Elapsed{" "}
                        {elapsedLabel}
                    </p>
                    <p>{session.message}</p>
                    <p>
                        Detected:{" "}
                        {session.latestSample
                            ? session.latestSample.processCount > 0
                                ? `yes (${session.latestSample.processCount} process${session.latestSample.processCount === 1 ? "" : "es"})`
                                : "not detected in latest sample"
                            : "waiting for first sample"}
                        {session.latestSample?.anyNotResponding
                            ? " · not responding observed"
                            : ""}
                        {session.latestSample
                            ? ` · working set ${formatBytes(session.latestSample.totalWorkingSetBytes)}`
                            : ""}
                    </p>
                    {session.tryingNowAt ? (
                        <p>
                            User-reported Trying now: {session.tryingNowAt}
                        </p>
                    ) : null}
                    {session.reproductionAttemptAt ? (
                        <p>
                            User-reported I tried it:{" "}
                            {session.reproductionAttemptAt}
                        </p>
                    ) : null}

                    {session.status === "watching" ? (
                        <div className="storage-offload-actions">
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busy}
                                onClick={() =>
                                    void run(
                                        () =>
                                            markTroubleshootingTryingNow(
                                                session.troubleshootingSessionId,
                                            ),
                                        "Could not mark Trying now.",
                                    )
                                }
                            >
                                Trying now
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busy}
                                onClick={() =>
                                    void run(
                                        () =>
                                            markTroubleshootingTried(
                                                session.troubleshootingSessionId,
                                            ),
                                        "Could not mark I tried it.",
                                    )
                                }
                            >
                                I tried it
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary"
                                disabled={busy}
                                onClick={() =>
                                    void run(
                                        () =>
                                            stopTroubleshootingSession(
                                                session.troubleshootingSessionId,
                                            ),
                                        "Could not stop and analyze.",
                                    )
                                }
                            >
                                Stop &amp; Analyze
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busy}
                                onClick={() =>
                                    void run(
                                        () =>
                                            cancelTroubleshootingSession(
                                                session.troubleshootingSessionId,
                                            ),
                                        "Could not cancel.",
                                    )
                                }
                            >
                                Cancel
                            </button>
                        </div>
                    ) : null}

                    {session.report ? (
                        <div className="banner banner-info" role="status">
                            <strong>
                                Evidence report · confidence{" "}
                                {session.report.confidence}
                            </strong>
                            <p>
                                <strong>Observed</strong>
                            </p>
                            <ul>
                                {session.report.observed.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                            <p>
                                <strong>Likely causes</strong>
                            </p>
                            <ul>
                                {session.report.likelyCauses.map((item) => (
                                    <li key={item.hypothesis}>
                                        {item.hypothesis} — {item.support}{" "}
                                        <em>Limit: {item.limitation}</em>
                                    </li>
                                ))}
                            </ul>
                            {session.report.unverified.length ? (
                                <>
                                    <p>
                                        <strong>Unverified</strong>
                                    </p>
                                    <ul>
                                        {session.report.unverified.map(
                                            (line) => (
                                                <li key={line}>{line}</li>
                                            ),
                                        )}
                                    </ul>
                                </>
                            ) : null}
                            <p>
                                <strong>Recommended next steps</strong>
                            </p>
                            <ol>
                                {session.report.recommendedNextSteps.map(
                                    (line) => (
                                        <li key={line}>{line}</li>
                                    ),
                                )}
                            </ol>
                            <p>
                                <strong>Verification</strong>
                            </p>
                            <ul>
                                {session.report.verification.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                        </div>
                    ) : null}

                    {["completed", "cancelled", "expired", "interrupted"].includes(
                        session.status,
                    ) ? (
                        <div className="storage-offload-actions">
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busy}
                                onClick={() => setSession(null)}
                            >
                                Start another watch
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </article>
    );
}
