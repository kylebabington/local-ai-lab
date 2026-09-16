import { apiRequest } from "./http";
import type { AgentResponse, PendingApproval } from "../types";

export async function sendAgentMessage(message: string): Promise<AgentResponse> {
    const trimmed = message.trim();

    if (!trimmed) {
        throw new Error("Message cannot be empty.");
    }

    return apiRequest<AgentResponse>("/api/agent", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: trimmed }),
    });
}

export async function listApprovals(): Promise<PendingApproval[]> {
    const data = await apiRequest<{ approvals?: PendingApproval[] }>(
        "/api/approvals",
    );
    return data.approvals ?? [];
}

export async function approveAction(id: string): Promise<AgentResponse> {
    return apiRequest<AgentResponse>(`/api/approvals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });
}

export async function rejectAction(id: string): Promise<AgentResponse> {
    return apiRequest<AgentResponse>(`/api/approvals/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });
}
