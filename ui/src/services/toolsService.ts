import { apiRequest } from "./http";
import type { ToolDefinition } from "../types";

export async function fetchTools(): Promise<{
    allowedRoots: string[];
    tools: ToolDefinition[];
}> {
    const data = await apiRequest<{
        allowedRoots?: string[];
        tools?: ToolDefinition[];
    }>("/api/tools");

    return {
        allowedRoots: data.allowedRoots ?? [],
        tools: data.tools ?? [],
    };
}
