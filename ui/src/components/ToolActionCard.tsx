import { useState } from "react";

import type { ToolAction, ToolActionStatus } from "../types";

interface ToolActionCardProps {
    action: ToolAction;
    onApprove: (
        id: string,
        decision?: {
            acknowledgeIncompleteScan?: boolean;
            authorizeHydrateCloudFiles?: boolean;
        },
    ) => void;
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

    if (status === "expired") {
        return "Expired";
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
    const [incompleteAck, setIncompleteAck] = useState(false);
    const needsAck = action.requiresIncompleteAck === true;
    const buttonsDisabled =
        !pending || busy || (needsAck && !incompleteAck);

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

            {action.originalsUntouched ? (
                <p className="tool-action-card-summary">{action.originalsUntouched}</p>
            ) : null}

            {needsAck && pending ? (
                <label className="tool-action-card-summary">
                    <input
                        type="checkbox"
                        checked={incompleteAck}
                        disabled={busy}
                        onChange={(event) =>
                            setIncompleteAck(event.target.checked)
                        }
                    />{" "}
                    I understand this plan came from an incomplete scan and is
                    not exhaustive.
                </label>
            ) : null}

            <footer className="tool-action-card-footer">
                <p className="tool-action-card-status" aria-live="polite">
                    {statusLabel(action.status, busy)}
                </p>
                <div className="tool-action-card-actions">
                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={buttonsDisabled}
                        onClick={() =>
                            onApprove(action.id, {
                                acknowledgeIncompleteScan: needsAck
                                    ? incompleteAck
                                    : undefined,
                            })
                        }
                    >
                        Approve
                    </button>
                    <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!pending || busy}
                        onClick={() => onReject(action.id)}
                    >
                        Reject
                    </button>
                </div>
            </footer>
        </article>
    );
}
