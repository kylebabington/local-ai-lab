import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import {
    fetchMemoryStatus,
    rebuildMemoryIndex,
} from "../services/memoryService";
import type { ConversationMemoryStatus } from "../types";

function formatIndexedAt(value: string | null): string {
    if (!value) {
        return "Never";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

export function MemoryPage() {
    const [status, setStatus] = useState<ConversationMemoryStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [rebuilding, setRebuilding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const next = await fetchMemoryStatus();
            setStatus(next);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not load conversation memory status.",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function handleRebuild() {
        setRebuilding(true);
        setError(null);

        try {
            const result = await rebuildMemoryIndex();
            setStatus(result.status);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not rebuild conversation memory.",
            );
            await refresh();
        } finally {
            setRebuilding(false);
        }
    }

    return (
        <section className="page" aria-labelledby="memory-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="memory-heading">Memory</h1>
                    <p className="page-kicker">
                        Long-term semantic recall over your conversation transcript
                    </p>
                </div>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleRebuild()}
                    disabled={rebuilding || loading}
                >
                    {rebuilding ? "Rebuilding…" : "Rebuild memory"}
                </button>
            </header>

            <div className="page-stack">
                {error ? (
                    <div className="banner banner-error" role="alert">
                        <strong>Conversation memory</strong>
                        <p>{error}</p>
                    </div>
                ) : null}

                {status?.stale ? (
                    <div className="banner banner-info" role="status">
                        <strong>Conversation memory is behind the transcript.</strong>
                        <p>
                            Rebuild memory to catch up. Chat still works without it.
                        </p>
                    </div>
                ) : null}

                {loading && !status ? (
                    <p className="chat-working">Loading conversation memory…</p>
                ) : status ? (
                    <article className="info-card">
                        <h2>Conversation memory</h2>
                        <dl className="status-grid">
                            <div>
                                <dt>Indexed turns</dt>
                                <dd>{status.memoryUnits}</dd>
                            </div>
                            <div>
                                <dt>Chunks</dt>
                                <dd>{status.chunks}</dd>
                            </div>
                            <div>
                                <dt>Transcript messages</dt>
                                <dd>{status.transcriptMessages}</dd>
                            </div>
                            <div>
                                <dt>Last updated</dt>
                                <dd>{formatIndexedAt(status.indexedAt)}</dd>
                            </div>
                            <div>
                                <dt>Embedding model</dt>
                                <dd>{status.embeddingModel}</dd>
                            </div>
                            <div>
                                <dt>State</dt>
                                <dd>{status.stale ? "Behind transcript" : "Up to date"}</dd>
                            </div>
                        </dl>
                    </article>
                ) : (
                    <EmptyState
                        title="Conversation memory is not ready"
                        body="The derived memory index will appear after the first successful sync."
                        hint="Your transcript remains the source of truth even when memory is empty."
                    />
                )}

                <article className="info-card">
                    <h2>How it works</h2>
                    <ul className="plain-list">
                        <li>
                            The transcript is the only permanent copy of what you said.
                        </li>
                        <li>
                            Conversation Memory is a disposable search index over that
                            transcript.
                        </li>
                        <li>
                            Normal Chat can retrieve a few relevant past turns without
                            loading the whole history.
                        </li>
                        <li>
                            Clear conversation forgets the transcript, Chat history, and
                            memory index together.
                        </li>
                    </ul>
                </article>
            </div>
        </section>
    );
}
