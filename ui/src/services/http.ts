/**
 * Shared fetch helper for the local Node API.
 * Pages must not call this directly.
 */

interface ApiErrorBody {
    error?: {
        message?: string;
    };
}

export class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

export function isConversationChangedError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 409;
}

function messageForHttpStatus(status: number, serverMessage?: string): string {
    if (serverMessage && serverMessage.trim()) {
        return serverMessage.trim();
    }

    if (status === 502 || status === 504) {
        return `Local API proxy error (${status}). The UI reached Vite, but the backend at 127.0.0.1:3001 did not respond. Check that npm run server is running and review the API terminal for crashes.`;
    }

    if (status === 503) {
        return "Local API is temporarily unavailable (503).";
    }

    return `Request failed (${status}).`;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;

    try {
        response = await fetch(path, {
            credentials: "same-origin",
            ...init,
        });
    } catch {
        throw new Error(
            "Could not reach the local API through the Vite proxy. Confirm the UI and API are both running (npm run server on 127.0.0.1:3001, npm run dev in ui/).",
        );
    }

    let data: unknown = null;
    let parsedJson = false;

    try {
        data = await response.json();
        parsedJson = true;
    } catch {
        parsedJson = false;
    }

    if (!response.ok) {
        const body = parsedJson ? (data as ApiErrorBody) : null;
        throw new ApiError(
            messageForHttpStatus(response.status, body?.error?.message),
            response.status,
        );
    }

    if (!parsedJson) {
        throw new Error("The local API returned an invalid response.");
    }

    return data as T;
}
