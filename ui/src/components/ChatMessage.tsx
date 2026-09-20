import { ToolActionCard } from "./ToolActionCard";
import { isFileRagSource, isMemorySource } from "../services/chatService";
import type {
    ChatMessage,
    ChatSource,
    MemorySource,
    PendingApproval,
    ToolAction,
} from "../types";

interface ChatMessageItemProps {
    message: ChatMessage;
    approvalBusy?: boolean;
    onApprove?: (id: string) => void;
    onReject?: (id: string) => void;
}

function roleLabel(role: ChatMessage["role"]): string {
    if (role === "user") {
        return "You";
    }

    if (role === "system") {
        return "System";
    }

    return "Assistant";
}

function modeLabel(mode: ChatMessage["contextMode"]): string | null {
    if (!mode) {
        return null;
    }

    if (mode === "chat") {
        return "Chat";
    }

    if (mode === "project") {
        return "Project";
    }

    if (mode === "file") {
        return "File";
    }

    return "Computer";
}

function approvalToAction(
    approval: PendingApproval,
    status: ChatMessage["approvalStatus"],
    busy: boolean,
): ToolAction {
    const details: { label: string; value: string }[] = [];

    if (approval.reason) {
        details.push({ label: "Reason", value: approval.reason });
    }

    for (const [label, value] of Object.entries(approval.arguments)) {
        if (label === "reason") {
            continue;
        }

        details.push({
            label,
            value: typeof value === "string" ? value : JSON.stringify(value),
        });
    }

    return {
        id: approval.id,
        title: approval.tool,
        summary:
            status === "expired"
                ? "This approval is no longer available."
                : "This action will not run until you approve it.",
        details,
        status: status ?? "pending",
        permission: approval.permission,
        busy,
    };
}

function sourceMeta(source: ChatSource): string {
    if (isMemorySource(source)) {
        const parts: string[] = [];
        const modes = (source.contextModes ?? [])
            .map((mode) => modeLabel(mode) ?? mode)
            .join(", ");
        if (modes) {
            parts.push(modes);
        }
        if (typeof source.similarity === "number") {
            parts.push(`Similarity ${source.similarity.toFixed(2)}`);
        }
        return parts.join(" · ");
    }

    if (isFileRagSource(source)) {
        const parts: string[] = [];

        if (
            typeof source.pageStart === "number" &&
            typeof source.pageEnd === "number"
        ) {
            parts.push(
                source.pageStart === source.pageEnd
                    ? `Page ${source.pageStart}`
                    : `Pages ${source.pageStart}–${source.pageEnd}`,
            );
        } else {
            parts.push(`Chunk ${source.chunkIndex}`);
        }

        if (typeof source.similarity === "number") {
            parts.push(`Similarity ${source.similarity.toFixed(2)}`);
        }

        return parts.join(" · ");
    }

    const parts = [`Lines ${source.startLine}–${source.endLine}`];

    if (typeof source.similarity === "number") {
        parts.push(`Similarity ${source.similarity.toFixed(2)}`);
    }

    return parts.join(" · ");
}

function sourceKey(source: ChatSource, index: number): string {
    if (isMemorySource(source)) {
        return `memory-${source.chunkId}-${index}`;
    }

    if (isFileRagSource(source)) {
        return `file-${source.filePath}-${source.chunkIndex}-${index}`;
    }

    return `${source.filePath}-${source.startLine}-${index}`;
}

function memoryDateLabel(source: MemorySource): string {
    const stamp = source.startedAt ?? source.endedAt;
    if (!stamp) {
        return "Unknown date";
    }

    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) {
        return "Unknown date";
    }

    return date.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function memoryModeLabel(source: MemorySource): string {
    const modes = (source.contextModes ?? [])
        .map((mode) => modeLabel(mode) ?? mode)
        .filter(Boolean);
    return modes.length > 0 ? modes.join(", ") : "Chat";
}

export function ChatMessageItem({
    message,
    approvalBusy = false,
    onApprove,
    onReject,
}: ChatMessageItemProps) {
    const sources = message.sources ?? [];
    const memorySources = sources.filter(isMemorySource);
    const otherSources = sources.filter((source) => !isMemorySource(source));
    const toolUses = message.toolUses ?? [];
    const hasTime = Boolean(message.createdAt);
    const approval = message.approval;

    return (
        <article
            className={`chat-message chat-message-${message.role}`}
            aria-label={`${roleLabel(message.role)} message`}
        >
            <header className="chat-message-meta">
                <span className="chat-message-role">{roleLabel(message.role)}</span>
                {modeLabel(message.contextMode) ? (
                    <span className="chat-message-badge">
                        {modeLabel(message.contextMode)}
                    </span>
                ) : null}
                {hasTime ? (
                    <time
                        className="chat-message-time"
                        dateTime={message.createdAt ?? undefined}
                    >
                        {new Date(message.createdAt as string).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                        })}
                    </time>
                ) : null}
            </header>
            {toolUses.length > 0 ? (
                <ul className="chat-tool-uses">
                    {toolUses.map((use, index) => (
                        <li key={`${use.tool}-${index}`}>{use.summary}</li>
                    ))}
                </ul>
            ) : null}
            {message.content ? (
                <p className="chat-message-content">{message.content}</p>
            ) : null}
            {approval && onApprove && onReject ? (
                <ToolActionCard
                    action={approvalToAction(
                        approval,
                        message.approvalStatus,
                        approvalBusy && message.approvalStatus === "pending",
                    )}
                    onApprove={onApprove}
                    onReject={onReject}
                />
            ) : null}
            {memorySources.length > 0 ? (
                <details className="chat-sources chat-memory-sources">
                    <summary>Memory · {memorySources.length}</summary>
                    <ul>
                        {memorySources.map((source, index) => (
                            <li key={sourceKey(source, index)}>
                                <span className="chat-sources-path">
                                    {memoryDateLabel(source)} · {memoryModeLabel(source)}
                                </span>
                                <span className="chat-sources-meta">
                                    {source.preview || sourceMeta(source)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
            {otherSources.length > 0 ? (
                <details className="chat-sources">
                    <summary>Sources · {otherSources.length}</summary>
                    <ul>
                        {otherSources.map((source, index) => (
                            <li key={sourceKey(source, index)}>
                                <span className="chat-sources-path">
                                    {"filePath" in source ? source.filePath : ""}
                                </span>
                                <span className="chat-sources-meta">
                                    {sourceMeta(source)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </article>
    );
}
