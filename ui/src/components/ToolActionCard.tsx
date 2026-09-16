import type { ToolAction, ToolActionStatus } from "../types";

interface ToolActionCardProps {
    action: ToolAction;
    onApprove: (id: string) => void;
    onReject: (id: string) => void;
}

function statusLabel(status: ToolActionStatus, busy: boolean): string {
    if (busy) {
        return "Working…";
    }

    if (status === "approved") {
        return "Approved";
    }

    if (status === "rejected") {
        return "Rejected";
    }

    return "Awaiting decision";
}

export function ToolActionCard({
    action,
    onApprove,
    onReject,
}: ToolActionCardProps) {
    const pending = action.status === "pending";
    const busy = Boolean(action.busy);
    const buttonsDisabled = !pending || busy;

    return (
        <article className={`tool-action-card status-${action.status}`}>
            <header className="tool-action-card-header">
                <div>
                    <h3 className="tool-action-card-title">{action.title}</h3>
                    <p className="tool-action-card-summary">{action.summary}</p>
                </div>
                {action.permission ? (
                    <span className="chat-message-badge">{action.permission}</span>
                ) : null}
            </header>

            <dl className="tool-action-card-details">
                {action.details.map((detail) => (
                    <div key={detail.label} className="tool-action-card-row">
                        <dt>{detail.label}</dt>
                        <dd>{detail.value}</dd>
                    </div>
                ))}
            </dl>

            <footer className="tool-action-card-footer">
                <p className="tool-action-card-status" aria-live="polite">
                    {statusLabel(action.status, busy)}
                </p>
                <div className="tool-action-card-actions">
                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={buttonsDisabled}
                        onClick={() => onApprove(action.id)}
                    >
                        Approve
                    </button>
                    <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={buttonsDisabled}
                        onClick={() => onReject(action.id)}
                    >
                        Reject
                    </button>
                </div>
            </footer>
        </article>
    );
}
