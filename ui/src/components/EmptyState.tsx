interface EmptyStateProps {
    title: string;
    body: string;
    hint?: string;
}

export function EmptyState({ title, body, hint }: EmptyStateProps) {
    return (
        <div className="empty-state">
            <h2 className="empty-state-title">{title}</h2>
            <p className="empty-state-body">{body}</p>
            {hint ? <p className="empty-state-hint">{hint}</p> : null}
        </div>
    );
}
