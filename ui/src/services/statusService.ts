/**
 * Backend / Ollama health for the header.
 *
 * GET /api/health through the Vite proxy.
 * Green / "Local AI connected" only when ready === true.
 */

import { DISPLAY_MODEL, type ConnectionStatus, type HealthResponse } from "../types";

export interface HealthSnapshot {
    status: ConnectionStatus;
    label: string;
    detail: string | null;
    modelName: string;
    ready: boolean;
}

const DISCONNECTED: HealthSnapshot = {
    status: "disconnected",
    label: "Backend unavailable",
    detail: "Start the API with npm run server",
    modelName: DISPLAY_MODEL,
    ready: false,
};

export async function fetchHealth(): Promise<HealthSnapshot> {
    let response: Response;

    try {
        response = await fetch("/api/health");
    } catch {
        return DISCONNECTED;
    }

    let data: HealthResponse;

    try {
        data = (await response.json()) as HealthResponse;
    } catch {
        return DISCONNECTED;
    }

    const modelName = data.chatModel?.name ?? DISPLAY_MODEL;

    if (data.ollama !== "connected") {
        return {
            status: "ollama-disconnected",
            label: "Backend connected",
            detail: "Ollama unavailable",
            modelName,
            ready: false,
        };
    }

    if (data.ready !== true) {
        const missing = [];

        if (!data.chatModel?.available) {
            missing.push(data.chatModel?.name ?? "chat model");
        }

        if (!data.embeddingModel?.available) {
            missing.push(data.embeddingModel?.name ?? "embedding model");
        }

        return {
            status: "model-missing",
            label: "Backend connected",
            detail:
                missing.length > 0
                    ? `Missing ${missing.join(" · ")}`
                    : "Required model missing",
            modelName,
            ready: false,
        };
    }

    return {
        status: "ready",
        label: "Local AI connected",
        detail: null,
        modelName,
        ready: true,
    };
}
