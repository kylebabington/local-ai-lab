import { useEffect, useRef, useState } from "react";

import { ChatComposer } from "../components/ChatComposer";
import { ChatMessageItem } from "../components/ChatMessage";
import { EmptyState } from "../components/EmptyState";
import {
    approveAction,
    listApprovals,
    rejectAction,
    sendAgentMessage,
} from "../services/agentService";
import {
    appendTranscriptMessages,
    clearTranscript,
    createId,
    loadTranscript,
    patchTranscriptMessage,
    sendChatMessage,
} from "../services/chatService";
import type {
    AgentResponse,
    ChatContextMode,
    ChatMessage,
    PendingApproval,
} from "../types";

const SAVE_ERROR = "Conversation could not be saved.";

function buildAssistantFromAgent(
    response: AgentResponse,
    contextMode: ChatContextMode,
    previousToolCount = 0,
): ChatMessage {
    const toolUses = (response.activity ?? []).slice(previousToolCount);

    if (response.status === "approval_required" && response.approval) {
        return {
            id: createId(),
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            contextMode,
            toolUses,
            approval: response.approval,
            approvalStatus: "pending",
        };
    }

    return {
        id: createId(),
        role: "assistant",
        content: response.answer ?? "",
        createdAt: new Date().toISOString(),
        contextMode,
        toolUses,
    };
}

function reconcileApprovals(
    transcript: ChatMessage[],
    liveApprovals: PendingApproval[],
): { messages: ChatMessage[]; expiredIds: string[] } {
    const liveIds = new Set(liveApprovals.map((item) => item.id));
    const expiredIds: string[] = [];

    const messages = transcript.map((message) => {
        const approvalId = message.approval?.id;

        if (!approvalId || message.approvalStatus !== "pending") {
            return message;
        }

        if (liveIds.has(approvalId)) {
            return message;
        }

        expiredIds.push(message.id);
        return {
            ...message,
            approvalStatus: "expired" as const,
        };
    });

    return { messages, expiredIds };
}

function kickerForMode(mode: ChatContextMode): string {
    if (mode === "computer") {
        return "Next message uses Computer tools · read tools run immediately · changes need approval";
    }

    if (mode === "project") {
        return "Next message uses Project RAG · prior turns stay visible in this transcript";
    }

    if (mode === "file") {
        return "Next message uses File RAG · prior turns stay visible in this transcript";
    }

    return "Next message uses normal Chat · the full transcript is saved until you clear it";
}

export function ChatPage() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [contextMode, setContextMode] = useState<ChatContextMode>("chat");
    const [busy, setBusy] = useState(false);
    const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
    const [loadingHistory, setLoadingHistory] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const logRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const [transcript, liveApprovals] = await Promise.all([
                    loadTranscript(),
                    listApprovals().catch(() => [] as PendingApproval[]),
                ]);

                if (cancelled) {
                    return;
                }

                const { messages: reconciled, expiredIds } = reconcileApprovals(
                    transcript,
                    liveApprovals,
                );

                setMessages(reconciled);
                setHistoryError(null);

                for (const id of expiredIds) {
                    try {
                        await patchTranscriptMessage(id, {
                            approvalStatus: "expired",
                        });
                    } catch {
                        // Display already shows expired; persist best-effort.
                    }
                }
            } catch (caught) {
                if (!cancelled) {
                    setHistoryError(
                        caught instanceof Error
                            ? caught.message
                            : "Could not load conversation history.",
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoadingHistory(false);
                }
            }
        }

        void load();

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const log = logRef.current;

        if (!log) {
            return;
        }

        const reduceMotion = document.documentElement.dataset.reducedMotion === "true";

        log.scrollTo({
            top: log.scrollHeight,
            behavior: reduceMotion ? "auto" : "smooth",
        });
    }, [messages, busy, error, saveError, loadingHistory]);

    async function persistUserMessage(userMessage: ChatMessage): Promise<void> {
        try {
            await appendTranscriptMessages([userMessage]);
            setSaveError(null);
        } catch {
            setSaveError(SAVE_ERROR);
            throw new Error(SAVE_ERROR);
        }
    }

    async function persistAssistantMessage(
        assistantMessage: ChatMessage,
    ): Promise<void> {
        try {
            await appendTranscriptMessages([assistantMessage]);
            setSaveError(null);
        } catch {
            setSaveError(SAVE_ERROR);
        }
    }

    async function handleSend(text: string) {
        const userMessage: ChatMessage = {
            id: createId(),
            role: "user",
            content: text,
            createdAt: new Date().toISOString(),
            contextMode,
        };

        setBusy(true);
        setError(null);
        setSaveError(null);

        try {
            await persistUserMessage(userMessage);
            setMessages((current) => [...current, userMessage]);
        } catch {
            setBusy(false);
            return;
        }

        try {
            if (contextMode === "computer") {
                const response = await sendAgentMessage(text);
                const assistantMessage = buildAssistantFromAgent(
                    response,
                    contextMode,
                );
                setMessages((current) => [...current, assistantMessage]);
                await persistAssistantMessage(assistantMessage);
            } else {
                const response = await sendChatMessage({
                    message: text,
                    contextMode,
                });
                const assistantMessage: ChatMessage = {
                    id: createId(),
                    role: "assistant",
                    content: response.answer,
                    createdAt: new Date().toISOString(),
                    contextMode,
                    sources: response.sources,
                };
                setMessages((current) => [...current, assistantMessage]);
                await persistAssistantMessage(assistantMessage);
            }
        } catch (caught) {
            const message =
                caught instanceof Error
                    ? caught.message
                    : "The local API request failed.";

            setError(message);
        } finally {
            setBusy(false);
        }
    }

    async function handleClear() {
        setBusy(true);
        setError(null);
        setSaveError(null);

        try {
            await clearTranscript();
            setMessages([]);
            setHistoryError(null);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not clear the conversation.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleApproval(id: string, decision: "approve" | "reject") {
        setApprovalBusyId(id);
        setError(null);

        const target = messages.find((message) => message.approval?.id === id);
        if (!target) {
            setApprovalBusyId(null);
            return;
        }

        const nextStatus = decision === "approve" ? "approved" : "rejected";

        setMessages((current) =>
            current.map((message) =>
                message.approval?.id === id
                    ? { ...message, approvalStatus: nextStatus }
                    : message,
            ),
        );

        try {
            await patchTranscriptMessage(target.id, {
                approvalStatus: nextStatus,
            });
        } catch {
            setSaveError(SAVE_ERROR);
        }

        try {
            const response =
                decision === "approve"
                    ? await approveAction(id)
                    : await rejectAction(id);

            const previousToolCount = target.toolUses?.length ?? 0;
            const assistantMessage = buildAssistantFromAgent(
                response,
                target.contextMode ?? "computer",
                previousToolCount,
            );

            setMessages((current) => [...current, assistantMessage]);
            await persistAssistantMessage(assistantMessage);
        } catch (caught) {
            const message =
                caught instanceof Error
                    ? caught.message
                    : "Could not update that approval.";

            if (message.includes("Unknown or expired")) {
                setMessages((current) =>
                    current.map((item) =>
                        item.approval?.id === id
                            ? { ...item, approvalStatus: "expired" }
                            : item,
                    ),
                );

                try {
                    await patchTranscriptMessage(target.id, {
                        approvalStatus: "expired",
                    });
                } catch {
                    setSaveError(SAVE_ERROR);
                }

                setError("That approval is no longer available.");
            } else {
                setMessages((current) =>
                    current.map((item) =>
                        item.approval?.id === id
                            ? { ...item, approvalStatus: "pending" }
                            : item,
                    ),
                );

                try {
                    await patchTranscriptMessage(target.id, {
                        approvalStatus: "pending",
                    });
                } catch {
                    setSaveError(SAVE_ERROR);
                }

                setError(message);
            }
        } finally {
            setApprovalBusyId(null);
        }
    }

    const empty =
        !loadingHistory && messages.length === 0 && !busy && !historyError;

    return (
        <section className="page page-chat" aria-labelledby="chat-heading">
            <div className="page-toolbar">
                <div>
                    <h1 id="chat-heading">Chat</h1>
                    <p className="page-kicker">{kickerForMode(contextMode)}</p>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void handleClear()}
                    disabled={
                        busy ||
                        (messages.length === 0 && !error && !saveError)
                    }
                >
                    Clear conversation
                </button>
            </div>

            <div className="chat-log" ref={logRef} tabIndex={0} aria-label="Conversation">
                {loadingHistory ? (
                    <p className="chat-working" aria-live="polite">
                        Loading conversation…
                    </p>
                ) : null}

                {historyError ? (
                    <div className="banner banner-error" role="alert">
                        <strong>Could not load history</strong>
                        <p>{historyError}</p>
                    </div>
                ) : null}

                {empty ? (
                    <EmptyState
                        title="Ask your computer"
                        body="One shared transcript keeps Chat, Project, File, and Computer turns in order. The context selector only changes how the next message is processed."
                        hint="Choose Chat, Project, File, or Computer next to the composer. Clear conversation wipes the transcript, Chat memory, and pending Computer approvals."
                    />
                ) : (
                    messages.map((message) => (
                        <ChatMessageItem
                            key={message.id}
                            message={message}
                            approvalBusy={approvalBusyId === message.approval?.id}
                            onApprove={(approvalId) =>
                                void handleApproval(approvalId, "approve")
                            }
                            onReject={(approvalId) =>
                                void handleApproval(approvalId, "reject")
                            }
                        />
                    ))
                )}

                {busy ? (
                    <p className="chat-working" aria-live="polite">
                        Generating response…
                    </p>
                ) : null}

                {saveError ? (
                    <div className="banner banner-error" role="alert">
                        <strong>Conversation could not be saved.</strong>
                        <p>{saveError}</p>
                    </div>
                ) : null}

                {error ? (
                    <div className="banner banner-error" role="alert">
                        <strong>Could not complete that request</strong>
                        <p>{error}</p>
                    </div>
                ) : null}
            </div>

            <ChatComposer
                contextMode={contextMode}
                onContextModeChange={setContextMode}
                busy={busy || loadingHistory || approvalBusyId !== null}
                onSend={handleSend}
            />
        </section>
    );
}
