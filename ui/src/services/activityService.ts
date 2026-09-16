import { apiRequest } from "./http";
import type { ActivityEntry } from "../types";

export async function fetchActivity(limit = 50): Promise<ActivityEntry[]> {
    const data = await apiRequest<{ entries?: ActivityEntry[] }>(
        `/api/activity?limit=${encodeURIComponent(String(limit))}`,
    );
    return data.entries ?? [];
}
