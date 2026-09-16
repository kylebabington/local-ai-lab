// =========================================================
// lib/tools/registry.js
//
// Tool definitions, permission levels, and hostile-input
// argument validation. Schema is enforced before any executor.
// =========================================================


import {
    listDirectory,
    getFileInfo,
    searchFiles,
    readTextFile,
    createDirectory,
    copyFile,
    moveFile,
    renameFile,
    getPublicRoots,
} from "./filesystem.js";


export const PERMISSION_READ = "read";
export const PERMISSION_APPROVAL = "approval";
export const PERMISSION_HIGH_RISK = "high-risk";


function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function requireString(args, field, maxLength = 4096) {
    const value = args[field];

    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`"${field}" must be a non-empty string.`);
    }

    const trimmed = value.trim();

    if (trimmed.length > maxLength) {
        throw new Error(`"${field}" is too long.`);
    }

    return trimmed;
}


function requireReason(args) {
    return requireString(args, "reason", 500);
}


function optionalBoolean(args, field, fallback) {
    if (!(field in args) || args[field] === undefined) {
        return fallback;
    }

    if (typeof args[field] !== "boolean") {
        throw new Error(`"${field}" must be a boolean.`);
    }

    return args[field];
}


function optionalInteger(args, field, fallback, min, max) {
    if (!(field in args) || args[field] === undefined) {
        return fallback;
    }

    const value = args[field];

    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`"${field}" must be an integer.`);
    }

    if (value < min || value > max) {
        throw new Error(`"${field}" must be between ${min} and ${max}.`);
    }

    return value;
}


function rejectUnknownKeys(args, allowed) {
    const extra = Object.keys(args).filter((key) => !allowed.includes(key));

    if (extra.length > 0) {
        throw new Error(`Unexpected argument(s): ${extra.join(", ")}.`);
    }
}


function validateListDirectory(args) {
    rejectUnknownKeys(args, ["path", "recursive", "maxDepth"]);
    return {
        path: requireString(args, "path"),
        recursive: optionalBoolean(args, "recursive", false),
        maxDepth: optionalInteger(args, "maxDepth", 2, 0, 4),
    };
}


function validateGetFileInfo(args) {
    rejectUnknownKeys(args, ["path"]);
    return { path: requireString(args, "path") };
}


function validateSearchFiles(args) {
    rejectUnknownKeys(args, ["query", "root", "maxResults"]);
    return {
        query: requireString(args, "query"),
        root: requireString(args, "root"),
        maxResults: optionalInteger(args, "maxResults", 50, 1, 50),
    };
}


function validateReadTextFile(args) {
    rejectUnknownKeys(args, ["path"]);
    return { path: requireString(args, "path") };
}


function validateCreateDirectory(args) {
    rejectUnknownKeys(args, ["path", "reason"]);
    return {
        path: requireString(args, "path"),
        reason: requireReason(args),
    };
}


function validateCopyFile(args) {
    rejectUnknownKeys(args, ["source", "destination", "reason"]);
    return {
        source: requireString(args, "source"),
        destination: requireString(args, "destination"),
        reason: requireReason(args),
    };
}


function validateMoveFile(args) {
    rejectUnknownKeys(args, ["source", "destination", "reason"]);
    return {
        source: requireString(args, "source"),
        destination: requireString(args, "destination"),
        reason: requireReason(args),
    };
}


function validateRenameFile(args) {
    rejectUnknownKeys(args, ["source", "destination", "reason"]);
    return {
        source: requireString(args, "source"),
        destination: requireString(args, "destination"),
        reason: requireReason(args),
    };
}


const TOOLS = [
    {
        name: "list_directory",
        permission: PERMISSION_READ,
        summary: "List files and folders inside an allowed directory.",
        description:
            "List entries in a directory inside the allowed filesystem roots. " +
            "Set recursive true to walk children. maxDepth is capped at 4.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Directory to list." },
                recursive: {
                    type: "boolean",
                    description: "Walk subdirectories. Default false.",
                },
                maxDepth: {
                    type: "integer",
                    description: "Maximum recursion depth. Default 2, max 4.",
                },
            },
            required: ["path"],
        },
        validate: validateListDirectory,
        execute: listDirectory,
    },
    {
        name: "get_file_info",
        permission: PERMISSION_READ,
        summary: "Get name, type, size, and modified time for a file or folder.",
        description:
            "Return metadata for a file or directory inside the allowed roots.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File or directory path." },
            },
            required: ["path"],
        },
        validate: validateGetFileInfo,
        execute: getFileInfo,
    },
    {
        name: "search_files",
        permission: PERMISSION_READ,
        summary: "Search file and folder names under an allowed directory.",
        description:
            "Case-insensitive name search under an allowed directory. " +
            "maxResults is capped at 50.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Text to search for." },
                root: { type: "string", description: "Directory to search under." },
                maxResults: {
                    type: "integer",
                    description: "Maximum matches to return. Default 50, max 50.",
                },
            },
            required: ["query", "root"],
        },
        validate: validateSearchFiles,
        execute: searchFiles,
    },
    {
        name: "read_text_file",
        permission: PERMISSION_READ,
        summary: "Read a UTF-8 text file inside the allowed roots.",
        description:
            "Read a reasonably sized text file. Binary files, secrets, " +
            "and oversized files are rejected.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Text file to read." },
            },
            required: ["path"],
        },
        validate: validateReadTextFile,
        execute: readTextFile,
    },
    {
        name: "create_directory",
        permission: PERMISSION_APPROVAL,
        summary: "Create a new empty directory. Does not overwrite.",
        description:
            "Create one new directory. The destination must not already exist. " +
            "Requires user approval. Always include a short reason.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Directory to create." },
                reason: {
                    type: "string",
                    description: "Why this directory should be created.",
                },
            },
            required: ["path", "reason"],
        },
        validate: validateCreateDirectory,
        execute: createDirectory,
    },
    {
        name: "copy_file",
        permission: PERMISSION_APPROVAL,
        summary: "Copy a file to a new path. Does not overwrite.",
        description:
            "Copy a file to a destination that does not already exist. " +
            "Requires user approval. Always include a short reason.",
        parameters: {
            type: "object",
            properties: {
                source: { type: "string", description: "Existing file to copy." },
                destination: { type: "string", description: "New destination path." },
                reason: {
                    type: "string",
                    description: "Why this file should be copied.",
                },
            },
            required: ["source", "destination", "reason"],
        },
        validate: validateCopyFile,
        execute: copyFile,
    },
    {
        name: "move_file",
        permission: PERMISSION_APPROVAL,
        summary: "Move a file to a new path. Does not overwrite.",
        description:
            "Move a file to a destination that does not already exist. " +
            "Requires user approval. Always include a short reason.",
        parameters: {
            type: "object",
            properties: {
                source: { type: "string", description: "Existing file to move." },
                destination: { type: "string", description: "New destination path." },
                reason: {
                    type: "string",
                    description: "Why this file should be moved.",
                },
            },
            required: ["source", "destination", "reason"],
        },
        validate: validateMoveFile,
        execute: moveFile,
    },
    {
        name: "rename_file",
        permission: PERMISSION_APPROVAL,
        summary: "Rename a file. Does not overwrite.",
        description:
            "Rename a file to a destination that does not already exist. " +
            "Requires user approval. Always include a short reason.",
        parameters: {
            type: "object",
            properties: {
                source: { type: "string", description: "Existing file to rename." },
                destination: { type: "string", description: "New file path." },
                reason: {
                    type: "string",
                    description: "Why this file should be renamed.",
                },
            },
            required: ["source", "destination", "reason"],
        },
        validate: validateRenameFile,
        execute: renameFile,
    },
];


const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));


const HIGH_RISK_TOOLS = [
    {
        name: "delete_path",
        permission: PERMISSION_HIGH_RISK,
        summary: "Delete a file or folder.",
        description: "Not enabled. Destructive deletes are blocked.",
        parameters: { type: "object", properties: {} },
        available: false,
    },
    {
        name: "overwrite_file",
        permission: PERMISSION_HIGH_RISK,
        summary: "Overwrite an existing file.",
        description: "Not enabled. Overwrites are blocked.",
        parameters: { type: "object", properties: {} },
        available: false,
    },
    {
        name: "run_shell",
        permission: PERMISSION_HIGH_RISK,
        summary: "Run a shell command.",
        description: "Not enabled. Arbitrary commands are blocked.",
        parameters: { type: "object", properties: {} },
        available: false,
    },
    {
        name: "install_software",
        permission: PERMISSION_HIGH_RISK,
        summary: "Install software on this machine.",
        description: "Not enabled. Installers are blocked.",
        parameters: { type: "object", properties: {} },
        available: false,
    },
];


function publicTool(tool, available) {
    return {
        name: tool.name,
        permission: tool.permission,
        summary: tool.summary,
        description: tool.description,
        parameters: tool.parameters,
        available,
    };
}


export function listTools() {
    return [
        ...TOOLS.map((tool) => publicTool(tool, true)),
        ...HIGH_RISK_TOOLS.map((tool) => publicTool(tool, false)),
    ];
}


export function getOllamaToolDefinitions() {
    return TOOLS.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}


export function getTool(name) {
    if (typeof name !== "string" || !TOOLS_BY_NAME.has(name)) {
        throw new Error("Unknown tool.");
    }

    return TOOLS_BY_NAME.get(name);
}


/**
 * Validate hostile tool arguments against the registry schema.
 *
 * @param {string} name
 * @param {unknown} rawArgs
 */
export function validateToolArguments(name, rawArgs) {
    const tool = getTool(name);

    if (!isPlainObject(rawArgs)) {
        throw new Error("Tool arguments must be an object.");
    }

    return tool.validate(rawArgs);
}


export async function executeTool(name, rawArgs) {
    const tool = getTool(name);
    const args = validateToolArguments(name, rawArgs);
    const result = await tool.execute(args);
    return { tool, args, result };
}


export function describeAllowedRoots() {
    return getPublicRoots();
}


export function permissionLabel(permission) {
    if (permission === PERMISSION_READ) {
        return "auto";
    }

    if (permission === PERMISSION_APPROVAL) {
        return "approval";
    }

    return "blocked";
}
