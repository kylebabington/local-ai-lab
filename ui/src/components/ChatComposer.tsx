import { useId, useRef, type FormEvent, type KeyboardEvent } from "react";

import type { ChatContextMode } from "../types";
import { ContextSelector } from "./ContextSelector";

interface ChatComposerProps {
    contextMode: ChatContextMode;
    onContextModeChange: (mode: ChatContextMode) => void;
    busy: boolean;
    onSend: (message: string) => void;
}

export function ChatComposer({
    contextMode,
    onContextModeChange,
    busy,
    onSend,
}: ChatComposerProps) {
    const fieldId = useId();
    const formRef = useRef<HTMLFormElement>(null);

    function submit(event?: FormEvent<HTMLFormElement>) {
        event?.preventDefault();

        const form = formRef.current;

        if (!form) {
            return;
        }

        const data = new FormData(form);
        const message = String(data.get("message") ?? "").trim();

        if (!message || busy) {
            return;
        }

        onSend(message);
        form.reset();

        const textarea = form.querySelector("textarea");
        textarea?.focus();
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.nativeEvent.isComposing) {
            return;
        }

        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    }

    return (
        <form
            ref={formRef}
            className="chat-composer"
            onSubmit={submit}
            aria-label="Send a message"
            aria-busy={busy}
        >
            <ContextSelector
                value={contextMode}
                onChange={onContextModeChange}
                disabled={busy}
            />

            <div className="chat-composer-main">
                <label className="visually-hidden" htmlFor={fieldId}>
                    Ask your computer anything
                </label>
                <textarea
                    id={fieldId}
                    name="message"
                    className="chat-composer-input"
                    placeholder="Ask your computer anything..."
                    rows={2}
                    disabled={busy}
                    onKeyDown={onKeyDown}
                />
                <button
                    type="submit"
                    className="chat-composer-send"
                    disabled={busy}
                >
                    {busy ? "Working" : "Send"}
                </button>
            </div>

            <p className="chat-composer-hint">
                Enter to send · Shift+Enter for a new line
            </p>
        </form>
    );
}
