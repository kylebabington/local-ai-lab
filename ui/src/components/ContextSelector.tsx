import type { ChatContextMode } from "../types";

interface ContextSelectorProps {
    value: ChatContextMode;
    onChange: (mode: ChatContextMode) => void;
    disabled?: boolean;
}

const OPTIONS: {
    value: ChatContextMode;
    label: string;
    enabled: boolean;
    note?: string;
}[] = [
    { value: "chat", label: "Chat", enabled: true },
    { value: "project", label: "Project", enabled: true },
    { value: "computer", label: "Computer", enabled: true },
    { value: "file", label: "File", enabled: false, note: "Phase 4+" },
];

export function ContextSelector({
    value,
    onChange,
    disabled = false,
}: ContextSelectorProps) {
    return (
        <div className="context-selector">
            <label className="context-selector-label" htmlFor="chat-context-mode">
                Context
            </label>
            <select
                id="chat-context-mode"
                className="context-selector-select"
                value={value}
                disabled={disabled}
                onChange={(event) => {
                    const next = event.target.value as ChatContextMode;
                    const option = OPTIONS.find((item) => item.value === next);

                    if (option?.enabled) {
                        onChange(next);
                    }
                }}
            >
                {OPTIONS.map((option) => (
                    <option
                        key={option.value}
                        value={option.value}
                        disabled={!option.enabled}
                    >
                        {option.note
                            ? `${option.label} — ${option.note}`
                            : option.label}
                    </option>
                ))}
            </select>
        </div>
    );
}
