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

export type ToolActionStatus =
    | "pending"
    | "approved"
    | "rejected"
    | "expired";

export type AgentStatus = "complete" | "approval_required";

export interface RagSource {
    filePath: string;
    startLine: number;
    endLine: number;
    similarity: number;
}

export interface FileRagSource {
    sourceType: "file";
    filePath: string;
    name: string;
    rootId: string;
    chunkIndex: number;
    similarity: number;
    pageStart?: number;
    pageEnd?: number;
}

export interface MemorySource {
    sourceType: "memory";
    memoryId: string;
    chunkId: string;
    similarity: number;
    startedAt: string | null;
    endedAt: string | null;
    contextModes: ChatContextMode[];
    preview: string;
}

export type ChatSource = RagSource | FileRagSource | MemorySource;

export interface ToolUseLine {
    tool: string;
    summary: string;
}

export interface TransferPreview {
    manifestId: string;
    manifestHash: string;
    destination: {
        volumeId: string | null;
        mount: string;
        label?: string | null;
        folderName: string;
        fileSystem?: string | null;
        freeBytes?: number | null;
    };
    entryCount: number;
    estimatedTransferBytes: number;
    estimatedFreeBytesRemaining: number | null;
    complete: boolean;
    incomplete: OffloadPlan["incomplete"];
    requiresIncompleteAck: boolean;
    originalsUntouched: string;
    entries: Array<{
        id: string;
        sourcePath: string;
        destinationPath: string;
        sizeBytes: number;
        safety: OffloadSafety;
        concerns: string[];
    }>;
    dependencyWarnings: Array<{ entryId: string; text: string }>;
}

export interface PendingApproval {
    id: string;
    tool: string;
    permission: ToolPermission;
    reason: string;
    arguments: Record<string, unknown>;
    requiresIncompleteAck?: boolean;
    transferPreview?: TransferPreview | null;
    standalone?: boolean;
    manifestId?: string | null;
    manifestHash?: string | null;
    expiresAt?: string;
}

export interface StorageTransfer {
    transferId: string;
    status: string;
    manifestId: string;
    manifestHash: string;
    entryCount: number;
    completedFiles: number;
    failedFiles: number;
    skippedFiles: number;
    bytesTransferred: number;
    bytesTotal: number;
    verifiedBytes: number;
    currentFile: string | null;
    bytesPerSecond: number;
    estimatedSecondsRemaining: number | null;
    destination: {
        volumeId: string | null;
        mount: string;
        folderName: string;
        offloadRoot: string;
    };
    completeScan: boolean;
    message: string;
    failureCode: string | null;
    failureMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
    files: Array<{
        entryId: string;
        state: string;
        sizeBytes: number;
        relativePath: string;
        failureCode: string | null;
        failureMessage: string | null;
    }>;
}

export type ReclaimEligibility =
    | "eligible_for_review"
    | "requires_manual_review"
    | "excluded"
    | "verification_failed";

export interface ReclaimIntegrityField {
    status: string;
    reason: string | null;
}

export interface ReclaimCandidate {
    entryId: string;
    sourcePath: string;
    destinationPath: string;
    sizeBytes: number;
    eligibility: ReclaimEligibility;
    copyIntegrity: ReclaimIntegrityField;
    sourceIntegrity: ReclaimIntegrityField;
    destinationIntegrity: ReclaimIntegrityField;
    sourceAuthorization: ReclaimIntegrityField;
    dependencyConfidence: ReclaimIntegrityField;
    cloudReparseSafety: ReclaimIntegrityField;
    reasons: string[];
    manualReviewNeeds: string[];
    warnings: string[];
    estimatedRecoverableLogicalBytes: number;
    estimatedRecoverablePhysicalBytes: number | null;
    estimateConfidence: string;
    journalState: string;
    sourceHashVerified: boolean;
    destinationHashVerified: boolean;
}

export interface ReclaimJob {
    jobId: string;
    transferId: string;
    status: string;
    transferStatus: string;
    transferComplete: boolean;
    schemaVersion: number;
    manifestTrust: string;
    trustLimitations: string[];
    entryCount: number;
    processedFiles: number;
    currentFile: string | null;
    currentEntryId: string | null;
    startedAt: string;
    finishedAt: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    cancelRequested: boolean;
    progress: {
        completed: number;
        total: number;
        percent: number;
    };
    estimates: {
        logicalBytesCopiedAndVerifiedInJournal: number;
        logicalBytesIndependentlyReverified: number;
        potentiallyRemovableLogicalBytes: number;
        estimatedPhysicallyRecoverableBytes: number | null;
        estimateConfidence: string;
        bytesActuallyReclaimed: number;
        notes: string[];
    };
    counts: {
        eligible_for_review: number;
        requires_manual_review: number;
        excluded: number;
        verification_failed: number;
        reverified: number;
    };
    message: string;
    interpretationLimits: string[];
    candidates: ReclaimCandidate[];
    bytesActuallyReclaimed: number;
}

export interface ChatMessage {
    id: string;
    role: MessageRole;
    content: string;
    createdAt: string | null;
    contextMode?: ChatContextMode;
    sources?: ChatSource[];
    toolUses?: ToolUseLine[];
    approval?: PendingApproval | null;
    approvalStatus?: ToolActionStatus;
}

export interface ChatRequest {
    message: string;
    contextMode: ChatContextMode;
    excludeMessageIds?: string[];
}

export interface ChatResponse {
    answer: string;
    sources?: ChatSource[];
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
    requiresIncompleteAck?: boolean;
    originalsUntouched?: string | null;
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
    status: AgentStatus | "transfer_started" | "transfer_failed";
    answer?: string;
    activity?: AgentActivityItem[];
    approval?: PendingApproval;
    transfer?: {
        transferId?: string;
        status?: string;
        [key: string]: unknown;
    };
    error?: string;
    errorCode?: string;
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

export interface FileContentIndexIssue {
    name: string;
    relativePath: string;
    status: string;
    code: string;
    message: string;
}

export interface FileContentIndexStatus {
    inventoryExists: boolean;
    inventoryScannedAt: string | null;
    inventoryFiles: number;
    indexExists: boolean;
    indexedAt: string | null;
    embeddingModel: string;
    extractorVersion: number | null;
    indexedFiles: number;
    reusedFiles: number;
    chunkCount: number;
    supportedFiles: number;
    unsupportedFiles: number;
    staleFiles: number;
    tooLargeFiles: number;
    noTextFiles: number;
    errorFiles: number;
    unsafeFiles: number;
    indexing: boolean;
    issueCount: number;
    issues: FileContentIndexIssue[];
}

export interface FileSemanticMatch {
    sourceType: "file";
    filePath: string;
    name: string;
    rootId: string;
    chunkIndex: number;
    similarity: number;
    pageStart?: number;
    pageEnd?: number;
    preview: string;
}

export interface ConversationMemoryStatus {
    indexExists: boolean;
    indexedAt: string | null;
    transcriptMessages: number;
    currentConversationId?: string | null;
    currentMessages?: number;
    archivedConversations?: number;
    totalConversations?: number;
    memoryUnits: number;
    chunks: number;
    stale: boolean;
    embeddingModel: string;
    syncRunning?: boolean;
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

export interface StorageSuggestion {
    id: string;
    label: string;
    path: string;
    available: boolean;
}

export interface StorageGrant {
    id: string;
    path: string;
    addedAt: string;
    expiresAt: string;
}

export interface StorageDiscovery {
    path: string;
    complete: boolean;
    filesVisited: number;
    directoriesVisited: number;
    totalBytes: number | null;
    truncated: boolean;
    timedOut: boolean;
    cancelled: boolean;
    queriedAt: string;
}

export interface StorageSession {
    grants: StorageGrant[];
    suggestions: StorageSuggestion[];
    discovery: StorageDiscovery | null;
    scanning: boolean;
}

export type OffloadSafety =
    | "likely_portable"
    | "review_required"
    | "excluded";

export interface StorageVolume {
    mount: string;
    label: string | null;
    fileSystem: string | null;
    totalBytes: number;
    freeBytes: number | null;
    usedPercent: number | null;
    driveType: string | null;
    busType: string | null;
    classification: "internal" | "removable" | "external" | "unknown";
    confidence: string;
    uncertainty: string | null;
    volumeId: string | null;
    volumeSerialNumber: string | null;
    diskUniqueId: string | null;
    identityConfidence: string;
}

export interface StorageDriveSnapshot {
    volumes: StorageVolume[];
    queriedAt?: string;
    interpretationLimits?: string[];
}

export interface OffloadPlanEntry {
    id: string;
    sourcePath: string;
    destinationPath: string;
    relativePath: string;
    sizeBytes: number;
    mtime: string;
    safety: OffloadSafety;
    dependencyConcerns: string[];
    concerns: string[];
    destinationConflict: string | null;
    selectable: boolean;
    grantId: string;
}

export interface OffloadPlan {
    id: string;
    createdAt: string;
    complete: boolean;
    incomplete: {
        truncated: boolean;
        timedOut: boolean;
        cancelled: boolean;
        limit: string | null;
    } | null;
    destination: {
        volumeId: string | null;
        mount: string;
        label: string | null;
        fileSystem: string | null;
        freeBytes: number | null;
        totalBytes: number | null;
        classification: string;
        folderName: string;
    };
    candidateCount: number;
    selectableCount: number;
    estimatedTransferBytes: number;
    potentialRecoverableBytesAfterVerifiedRemoval: number;
    estimatesNote: string;
    destinationCapacityWarning: string | null;
    conflicts: unknown[];
    invalidated: boolean;
    invalidReason: string | null;
    entries: OffloadPlanEntry[];
    lockedManifestId: string | null;
}

export interface LockedManifest {
    manifestId: string;
    hash: string;
    planId: string;
    complete: boolean;
    incomplete: OffloadPlan["incomplete"];
    entryCount: number;
    estimatedTransferBytes: number;
    potentialRecoverableBytesAfterVerifiedRemoval: number;
    estimatesNote: string;
    destination: OffloadPlan["destination"];
    entries: OffloadPlanEntry[];
    copyAvailable: boolean;
    message: string;
}

export const DISPLAY_MODEL = "qwen3:4b-instruct";

export const DEFAULT_SETTINGS: AppSettings = {
    selectedModel: DISPLAY_MODEL,
    theme: "dark",
    responseDetail: "balanced",
    motion: "system",
};
