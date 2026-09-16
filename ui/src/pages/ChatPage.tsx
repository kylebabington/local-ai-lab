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
    clearChatHistory,
    createId,
    loadChatHistory,
    sendChatMessage,
} from "../services/chatService";
import type {
    AgentResponse,
    ChatContextMode,
    ChatMessage,
    PendingApproval,
} from "../types";

function applyAgentResponse(
    current: ChatMessage[],
    response: AgentResponse,
    pendingId?: string,
): ChatMessage[] {
    const next = [...current];
    const toolUses = response.activity ?? [];
    const previousCount = pendingId
        ? (next.find((message) => message.approval?.id === pendingId)?.toolUses
              ?.length ?? 0)
        : 0;
    const newUses = toolUses.slice(previousCount);

    if (response.status === "approval_required" && response.approval) {
        next.push({
            id: createId(),
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            toolUses: newUses,
            approval: response.approval,
            approvalStatus: "pending",
        });
        return next;
    }

    next.push({
        id: createId(),
        role: "assistant",
        content: response.answer ?? "",
        createdAt: new Date().toISOString(),
        toolUses: newUses,
    });

    return next;
}

function kickerForMode(mode: ChatContextMode): string {
    if (mode === "computer") {
        return "Computer mode is session-only · read tools run immediately · changes need approval";
    }

    if (mode === "project") {
        return "Project answers are session-only and are not written to chat-history.json";
    }

    return "Normal chat is saved on the backend · Project and Computer stays off that file";
}

export function ChatPage() {
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [computerMessages, setComputerMessages] = useState<ChatMessage[]>([]);
    const [contextMode, setContextMode] = useState<ChatContextMode>("chat");
    const [busy, setBusy] = useState(false);
    const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
    const [loadingHistory, setLoadingHistory] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const logRef = useRef<HTMLDivElement>(null);
    const computer = contextMode === "computer";
    const messages = computer ? computerMessages : chatMessages;

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const history = await loadChatHistory();

                if (!cancelled) {
                    setChatMessages(history);
                    setHistoryError(null);
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
        if (!computer) {
            return;
        }

        let cancelled = false;

        async function restoreApprovals() {
            try {
                const approvals = await listApprovals();

                if (cancelled || approvals.length === 0) {
                    return;
                }

                setComputerMessages((current) => mergeRestoredApprovals(current, approvals));
            } catch {
                // Keep the session usable if pending-approval restore fails.
            }
        }

        void restoreApprovals();

        return () => {
            cancelled = true;
        };
    }, [computer]);

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
    }, [messages, busy, error, loadingHistory, computer]);

    async function handleSend(text: string) {
        const userMessage: ChatMessage = {
            id: createId(),
            role: "user",
            content: text,
            createdAt: new Date().toISOString(),
        };

        if (computer) {
            setComputerMessages((current) => [...current, userMessage]);
        } else {
            setChatMessages((current) => [...current, userMessage]);
        }

        setBusy(true);
        setError(null);

        try {
            if (computer) {
                const response = await sendAgentMessage(text);
                setComputerMessages((current) => applyAgentResponse(current, response));
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
                    sources: response.sources,
                };

                setChatMessages((current) => [...current, assistantMessage]);
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

        try {
            if (computer) {
                setComputerMessages([]);
            } else {
                await clearChatHistory();
                setChatMessages([]);
                setHistoryError(null);
            }
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

        setComputerMessages((current) =>
            current.map((message) =>
                message.approval?.id === id
                    ? {
                          ...message,
                          approvalStatus:
                              decision === "approve" ? "approved" : "rejected",
                      }
                    : message,
            ),
        );

        try {
            const response =
                decision === "approve"
                    ? await approveAction(id)
                    : await rejectAction(id);

            setComputerMessages((current) =>
                applyAgentResponse(current, response, id),
            );
        } catch (caught) {
            setComputerMessages((current) =>
                current.map((message) =>
                    message.approval?.id === id
                        ? { ...message, approvalStatus: "pending" }
                        : message,
                ),
            );
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not update that approval.",
            );
        } finally {
            setApprovalBusyId(null);
        }
    }

    const empty =
        !loadingHistory && messages.length === 0 && !busy && !historyError;
    const heading = computer ? "Computer" : "Chat";

    return (
        <section className="page page-chat" aria-labelledby="chat-heading">
            <div className="page-toolbar">
                <div>
                    <h1 id="chat-heading">{heading}</h1>
                    <p className="page-kicker">{kickerForMode(contextMode)}</p>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void handleClear()}
                    disabled={busy || (messages.length === 0 && !error)}
                >
                    Clear conversation
                </button>
            </div>

            <div className="chat-log" ref={logRef} tabIndex={0} aria-label="Conversation">
                {loadingHistory && !computer ? (
                    <p className="chat-working" aria-live="polite">
                        Loading conversation…
                    </p>
                ) : null}

                {historyError && !computer ? (
                    <div className="banner banner-error" role="alert">
                        <strong>Could not load history</strong>
                        <p>{historyError}</p>
                    </div>
                ) : null}

                {empty ? (
                    <EmptyState
                        title={computer ? "Ask your computer to look around" : "Ask your computer"}
                        body={
                            computer
                                ? "Computer mode can list, search, and read files in allowed folders. Creating, copying, moving, or renaming waits for your approval. These turns are not saved to chat-history.json."
                                : "Normal chat uses the local Node API and Qwen. Project mode searches the indexed codebase and does not write those turns into chat-history.json."
                        }
                        hint={
                            computer
                                ? "Read tools run on their own. File context is still a later phase."
                                : "Choose Chat, Project, or Computer next to the composer. File context is still a later phase."
                        }
                    />
                ) : (
                    messages.map((message) => (
                        <ChatMessageItem
                            key={message.id}
                            message={message}
                            approvalBusy={approvalBusyId === message.approval?.id}
                            onApprove={(id) => void handleApproval(id, "approve")}
                            onReject={(id) => void handleApproval(id, "reject")}
                        />
                    ))
                )}

                {busy ? (
                    <p className="chat-working" aria-live="polite">
                        Generating response…
                    </p>
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
                busy={busy || (!computer && loadingHistory) || approvalBusyId !== null}
                onSend={handleSend}
            />
        </section>
    );
}

function mergeRestoredApprovals(
    current: ChatMessage[],
    approvals: PendingApproval[],
): ChatMessage[] {
    const existing = new Set(
        current
            .map((message) => message.approval?.id)
            .filter((id): id is string => Boolean(id)),
    );
    const extras: ChatMessage[] = [];

    for (const approval of approvals) {
        if (existing.has(approval.id)) {
            continue;
        }

        extras.push({
            id: `approval-${approval.id}`,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            approval,
            approvalStatus: "pending",
        });
    }

    return extras.length > 0 ? [...current, ...extras] : current;
}
