import { useEffect, useState } from "react";

import { EmptyState } from "../components/EmptyState";
import { fetchActivity } from "../services/activityService";
import type { ActivityEntry } from "../types";

function formatTime(timestamp: string): string {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
        return timestamp;
    }

    return date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

export function ActivityPage() {
    const [entries, setEntries] = useState<ActivityEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const data = await fetchActivity(50);

                if (!cancelled) {
                    setEntries(data);
                    setError(null);
                }
            } catch (caught) {
                if (!cancelled) {
                    setError(
                        caught instanceof Error
                            ? caught.message
                            : "Could not load activity.",
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        void load();

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <section className="page" aria-labelledby="activity-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="activity-heading">Activity</h1>
                    <p className="page-kicker">Tool audit trail</p>
                </div>
            </header>

            <div className="page-stack">
                {loading ? <p>Loading activity…</p> : null}

                {error ? (
                    <div className="banner banner-error" role="alert">
                        <strong>Could not load activity</strong>
                        <p>{error}</p>
                    </div>
                ) : null}

                {!loading && !error && entries.length === 0 ? (
                    <EmptyState
                        title="No tool activity yet"
                        body="Computer-mode tool starts, reads, approvals, rejections, and failures will show up here. File contents are never logged."
                    />
                ) : null}

                {entries.length > 0 ? (
                    <ol className="activity-list">
                        {entries.map((entry) => (
                            <li key={entry.id} className="activity-item">
                                <time className="activity-time">
                                    {formatTime(entry.timestamp)}
                                </time>
                                <div>
                                    <p className="activity-title">{entry.summary}</p>
                                    <p className="activity-detail">
                                        {entry.status}
                                        {entry.tool ? ` · ${entry.tool}` : ""}
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ol>
                ) : null}
            </div>
        </section>
    );
}
