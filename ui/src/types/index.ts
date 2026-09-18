export type AppSection =
    | "chat"
    | "projects"
    | "files"
    | "memory"
    | "tools"
    | "activity"
    | "settings";

export type MessageRole = "user" | "assistant" | "system";

export type ChatContextMode = "chat" | "project" | "computer" | "file";

export type ThemePreference = "dark" | "light";

export type ResponseDetail = "concise" | "balanced" | "detailed";

export type MotionPreference = "system" | "reduce" | "allow";

export type ConnectionStatus =
    | "ready"
    | "model-missing"
    | "ollama-disconnected"
    | "disconnected";

export type ToolPermission =
    | "read"
    | "approval"
    | "high-risk";

export type ToolPermissionLevel = "read-only" | "approval-required" | "high-risk";

export type ToolActionStatus = "pending" | "approved" | "rejected";

export type AgentStatus = "complete" | "approval_required";

export interface RagSource {
    filePath: string;
    startLine: number;
    endLine: number;
    similarity: number;
}

export interface ToolUseLine {
    tool: string;
    summary: string;
}

export interface PendingApproval {
    id: string;
    tool: string;
    permission: ToolPermission;
    reason: string;
    arguments: Record<string, unknown>;
}

export interface ChatMessage {
    id: string;
    role: MessageRole;
    content: string;
    createdAt: string | null;
    sources?: RagSource[];
    toolUses?: ToolUseLine[];
    approval?: PendingApproval | null;
    approvalStatus?: ToolActionStatus;
}

export interface ChatRequest {
    message: string;
    contextMode: ChatContextMode;
}

export interface ChatResponse {
    answer: string;
    sources?: RagSource[];
}

export interface HealthResponse {
    ok: boolean;
    backend: "connected";
    ollama: "connected" | "disconnected";
    ready: boolean;
    chatModel: {
        name: string;
        available: boolean;
    };
    embeddingModel: {
        name: string;
        available: boolean;
    };
}

export interface Project {
    id: string;
    name: string;
    path: string;
    indexedAt: string | null;
}

export interface ToolDefinition {
    name: string;
    permission: ToolPermission;
    summary: string;
    description: string;
    parameters: Record<string, unknown>;
    available: boolean;
}

export interface Tool {
    id: string;
    name: string;
    description: string;
    permissionLevel: ToolPermissionLevel;
}

export interface ToolAction {
    id: string;
    title: string;
    summary: string;
    details: { label: string; value: string }[];
    status: ToolActionStatus;
    permission?: string;
    busy?: boolean;
}

export interface ActivityEntry {
    id: string;
    timestamp: string;
    type: string;
    tool: string | null;
    status: string;
    summary: string;
    details: Record<string, unknown> | null;
}

export interface AgentActivityItem {
    tool: string;
    summary: string;
}

export interface AgentResponse {
    status: AgentStatus;
    answer?: string;
    activity?: AgentActivityItem[];
    approval?: PendingApproval;
}

export interface AppSettings {
    selectedModel: string;
    theme: ThemePreference;
    responseDetail: ResponseDetail;
    motion: MotionPreference;
}

export interface FileRoot {
    id: string;
    path: string;
    realPath: string;
}

export interface FileInventoryEntry {
    rootId: string;
    absolutePath: string;
    relativePath: string;
    name: string;
    extension: string;
    size: number;
    mtimeMs: number;
    modifiedAt: string;
    fingerprint: string;
}

export interface FileInventorySummary {
    fileCount: number;
    totalBytes: number;
    skippedCount: number;
    errorCount: number;
    truncated: boolean;
    truncationReason: string | null;
}

export interface FileInventoryStatus {
    roots: FileRoot[];
    rootCount: number;
    inventoryExists: boolean;
    scannedAt: string | null;
    fileCount: number;
    totalBytes: number;
    skippedCount: number;
    errorCount: number;
    truncated: boolean;
    truncationReason: string | null;
    scanning: boolean;
}

export type FileSearchSort = "name" | "modified" | "size";

export type FileSearchDirection = "asc" | "desc";

export interface FileSearchParams {
    query?: string;
    rootId?: string;
    extension?: string;
    limit?: number;
    offset?: number;
    sort?: FileSearchSort;
    direction?: FileSearchDirection;
}

export interface FileSearchResponse {
    total: number;
    offset: number;
    limit: number;
    files: FileInventoryEntry[];
}

export const DISPLAY_MODEL = "qwen3:4b-instruct";

export const DEFAULT_SETTINGS: AppSettings = {
    selectedModel: DISPLAY_MODEL,
    theme: "dark",
    responseDetail: "balanced",
    motion: "system",
};
