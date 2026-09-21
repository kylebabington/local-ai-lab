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
    return (
        error instanceof ApiError &&
        error.status === 409
    );
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;

    try {
        response = await fetch(path, init);
    } catch {
        throw new Error(
            "Could not reach the local API. Start it with npm run server.",
        );
    }

    let data: unknown = null;

    try {
        data = await response.json();
    } catch {
        if (!response.ok) {
            throw new ApiError(`Request failed (${response.status}).`, response.status);
        }

        throw new Error("The local API returned an invalid response.");
    }

    if (!response.ok) {
        const body = data as ApiErrorBody;
        throw new ApiError(
            body.error?.message ?? `Request failed (${response.status}).`,
            response.status,
        );
    }

    return data as T;
}
