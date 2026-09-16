import { ToolActionCard } from "./ToolActionCard";
import type { ChatMessage, PendingApproval, ToolAction } from "../types";

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
        summary: "This action will not run until you approve it.",
        details,
        status: status ?? "pending",
        permission: approval.permission,
        busy,
    };
}

export function ChatMessageItem({
    message,
    approvalBusy = false,
    onApprove,
    onReject,
}: ChatMessageItemProps) {
    const sources = message.sources ?? [];
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
            {sources.length > 0 ? (
                <details className="chat-sources">
                    <summary>Sources · {sources.length}</summary>
                    <ul>
                        {sources.map((source, index) => (
                            <li key={`${source.filePath}-${source.startLine}-${index}`}>
                                <span className="chat-sources-path">{source.filePath}</span>
                                <span className="chat-sources-meta">
                                    Lines {source.startLine}–{source.endLine}
                                    {typeof source.similarity === "number"
                                        ? ` · Similarity ${source.similarity.toFixed(2)}`
                                        : ""}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </article>
    );
}
