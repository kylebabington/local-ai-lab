import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { forgetAllConversations } from "../services/chatService";
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
    const [forgetting, setForgetting] = useState(false);
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

    async function handleForgetAll() {
        const confirmed = window.confirm(
            "Forget all conversation history?\n\nThis permanently deletes the current transcript, all archived conversations, Chat model history, and Conversation Memory. This cannot be undone.",
        );

        if (!confirmed) {
            return;
        }

        setForgetting(true);
        setError(null);

        try {
            await forgetAllConversations();
            await refresh();
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not forget conversation history.",
            );
        } finally {
            setForgetting(false);
        }
    }

    const totalConversations = status?.totalConversations ?? null;
    const archivedConversations = status?.archivedConversations ?? null;

    return (
        <section className="page" aria-labelledby="memory-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="memory-heading">Memory</h1>
                    <p className="page-kicker">
                        Long-term semantic recall over current and archived conversations
                    </p>
                </div>
                <div className="toolbar-actions">
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void handleForgetAll()}
                        disabled={forgetting || rebuilding || loading}
                    >
                        {forgetting ? "Forgetting…" : "Forget all conversation history"}
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleRebuild()}
                        disabled={rebuilding || forgetting || loading}
                    >
                        {rebuilding ? "Rebuilding…" : "Rebuild memory"}
                    </button>
                </div>
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
                        <h2>Conversation Memory</h2>
                        <dl className="status-grid">
                            <div>
                                <dt>Conversations</dt>
                                <dd>{totalConversations ?? "—"}</dd>
                            </div>
                            <div>
                                <dt>Archived</dt>
                                <dd>{archivedConversations ?? "—"}</dd>
                            </div>
                            <div>
                                <dt>Current messages</dt>
                                <dd>
                                    {status.currentMessages ??
                                        status.transcriptMessages}
                                </dd>
                            </div>
                            <div>
                                <dt>Indexed turns</dt>
                                <dd>{status.memoryUnits}</dd>
                            </div>
                            <div>
                                <dt>Chunks</dt>
                                <dd>{status.chunks}</dd>
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
                                <dd>
                                    {status.stale ? "Behind transcript" : "Up to date"}
                                </dd>
                            </div>
                        </dl>
                    </article>
                ) : (
                    <EmptyState
                        title="Conversation memory is not ready"
                        body="The derived memory index will appear after the first successful sync."
                        hint="Your transcript and archive remain the source of truth even when memory is empty."
                    />
                )}

                <article className="info-card">
                    <h2>How it works</h2>
                    <ul className="plain-list">
                        <li>
                            Current and archived conversations are the permanent copy of
                            what you said.
                        </li>
                        <li>
                            Conversation Memory is a disposable search index over that
                            history.
                        </li>
                        <li>
                            Normal Chat can retrieve a few relevant past turns without
                            loading the whole history.
                        </li>
                        <li>
                            New conversation archives the current thread and starts
                            fresh. Long-term memory stays searchable.
                        </li>
                        <li>
                            Forget all conversation history is the only action that
                            permanently erases archived and current history.
                        </li>
                    </ul>
                </article>
            </div>
        </section>
    );
}
