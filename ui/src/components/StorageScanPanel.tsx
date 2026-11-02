import { useEffect, useState, type FormEvent } from "react";

import {
    cancelStorageScan,
    fetchStorageSession,
    grantStorageFolder,
    revokeAllStorageGrants,
    revokeStorageGrant,
} from "../services/storageService";
import type { StorageSession } from "../types";

function formatBytes(bytes: number | null | undefined): string {
    if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) < 0) {
        return "—";
    }

    const value = bytes as number;

    if (value < 1024) {
        return `${value} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let scaled = value / 1024;
    let unit = 0;

    while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
    }

    return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`;
}

interface StorageScanPanelProps {
    refreshKey?: number;
    computerBusy?: boolean;
    onGrantsChanged?: () => void;
}

export function StorageScanPanel({
    refreshKey = 0,
    computerBusy = false,
    onGrantsChanged,
}: StorageScanPanelProps) {
    const [session, setSession] = useState<StorageSession | null>(null);
    const [pathInput, setPathInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function load() {
        const data = await fetchStorageSession();
        setSession(data);
        setError(null);
        return data;
    }

    useEffect(() => {
        let cancelled = false;

        fetchStorageSession()
            .then((data) => {
                if (!cancelled) {
                    setSession(data);
                    setError(null);
                }
            })
            .catch((caught: unknown) => {
                if (!cancelled) {
                    setError(
                        caught instanceof Error
                            ? caught.message
                            : "Could not load scan folders.",
                    );
                }
            });

        return () => {
            cancelled = true;
        };
    }, [refreshKey]);

    useEffect(() => {
        if (!computerBusy) {
            return;
        }

        const timer = window.setInterval(() => {
            void load().catch(() => undefined);
        }, 2000);

        return () => window.clearInterval(timer);
    }, [computerBusy]);

    async function run(work: () => Promise<StorageSession>) {
        setBusy(true);
        setError(null);

        try {
            const data = await work();
            setSession(data);
            setPathInput("");
            onGrantsChanged?.();
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not update scan folders.",
            );
        } finally {
            setBusy(false);
        }
    }

    function handleAdd(event: FormEvent) {
        event.preventDefault();
        const trimmed = pathInput.trim();

        if (!trimmed) {
            return;
        }

        void run(() => grantStorageFolder(trimmed));
    }

    const grants = session?.grants ?? [];
    const suggestions = session?.suggestions ?? [];
    const discovery = session?.discovery;
    const grantedPaths = new Set(grants.map((grant) => grant.path.toLowerCase()));

    return (
        <article className="storage-scan-panel" aria-label="Storage scan folders">
            <div className="storage-scan-header">
                <div>
                    <h2>Scan folders</h2>
                    <p>
                        Temporary read-only access for this Computer session.
                        Whole drives are never scanned.
                    </p>
                </div>
                {grants.length > 0 ? (
                    <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => void run(() => revokeAllStorageGrants())}
                    >
                        End session
                    </button>
                ) : null}
            </div>

            {error ? (
                <div className="banner banner-error" role="alert">
                    <strong>Scan folders</strong>
                    <p>{error}</p>
                </div>
            ) : null}

            <div className="storage-scan-suggestions" aria-label="Suggested folders">
                {suggestions.map((suggestion) => {
                    const already = grantedPaths.has(suggestion.path.toLowerCase());

                    return (
                        <button
                            key={suggestion.id}
                            type="button"
                            className="storage-scan-chip"
                            disabled={
                                busy || already || suggestion.available === false
                            }
                            onClick={() =>
                                void run(() => grantStorageFolder(suggestion.path))
                            }
                        >
                            {suggestion.label}
                            {already ? " · granted" : ""}
                        </button>
                    );
                })}
            </div>

            <form className="files-root-form" onSubmit={handleAdd}>
                <label className="files-field">
                    <span>Absolute folder path</span>
                    <input
                        type="text"
                        value={pathInput}
                        onChange={(event) => setPathInput(event.target.value)}
                        placeholder="C:\Users\...\Downloads"
                        spellCheck={false}
                        autoComplete="off"
                        disabled={busy}
                    />
                </label>
                <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy || !pathInput.trim()}
                >
                    Grant folder
                </button>
            </form>

            {grants.length === 0 ? (
                <p className="storage-scan-empty">
                    Select Downloads, Documents, Pictures, Videos, Desktop, or
                    another folder. The assistant cannot inspect disk usage until
                    you grant a folder.
                </p>
            ) : (
                <ul className="storage-scan-grants">
                    {grants.map((grant) => (
                        <li key={grant.id}>
                            <div>
                                <p className="files-root-path">{grant.path}</p>
                                <p className="activity-detail">
                                    Read-only until {new Date(grant.expiresAt).toLocaleTimeString([], {
                                        hour: "numeric",
                                        minute: "2-digit",
                                    })}
                                </p>
                            </div>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busy}
                                onClick={() =>
                                    void run(() => revokeStorageGrant(grant.id))
                                }
                            >
                                Revoke
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <p className="storage-scan-scope">
                Estimated scope: {grants.length} folder
                {grants.length === 1 ? "" : "s"} · descendants only · depth, file
                count, and time limits apply
            </p>

            {discovery ? (
                <p className="storage-scan-discovery">
                    Last scan of {discovery.path}:{" "}
                    {discovery.complete ? "complete" : "incomplete"} ·{" "}
                    {discovery.filesVisited} files ·{" "}
                    {formatBytes(discovery.totalBytes)}
                    {discovery.timedOut ? " · timed out" : ""}
                    {discovery.cancelled ? " · cancelled" : ""}
                    {discovery.truncated && !discovery.timedOut && !discovery.cancelled
                        ? " · truncated"
                        : ""}
                </p>
            ) : null}

            {computerBusy || session?.scanning ? (
                <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void run(() => cancelStorageScan())}
                >
                    Cancel scan
                </button>
            ) : null}
        </article>
    );
}
