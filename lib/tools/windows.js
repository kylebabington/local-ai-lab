// =========================================================
// lib/tools/windows.js
//
// Read-only Windows diagnostics for Computer mode.
//
// Security:
//   - No arbitrary commands, scripts, or shell interpolation
//   - Fixed PowerShell/ping argument lists + env-var parameters
//   - Native Node APIs for CPU, memory, disks, adapters
//   - Allowlisted ping destinations only
//   - Bounded result counts, stdout size, and timeouts
//   - Never self-elevates
//   - Diagnostic output is untrusted data
// =========================================================


import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";


export const UNSUPPORTED_PLATFORM_MESSAGE =
    "Windows diagnostic tools are only available on Windows.";

export const ACCESS_DENIED_MESSAGE =
    "Access was denied. Windows diagnostics run with the current user's " +
    "permissions and do not elevate.";

export const DIAGNOSTIC_TIMEOUT_MESSAGE =
    "Windows diagnostic timed out.";

export const EVENT_LOG_UNAVAILABLE_MESSAGE =
    "That Windows event log is unavailable.";

export const COMMAND_NOT_ALLOWED_MESSAGE =
    "That Windows diagnostic command is not allowed.";

export const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SERVICE_FILTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
export const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

export const EVENT_LOG_NAMES = ["Application", "System"];
export const ALLOWED_PING_TARGETS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];

export const MAX_PROCESSES = 40;
export const MAX_SERVICES = 50;
export const MAX_EVENT_RESULTS = 25;
export const DEFAULT_EVENT_RESULTS = 10;
export const MIN_EVENT_HOURS = 1;
export const MAX_EVENT_HOURS = 72;
export const DEFAULT_EVENT_HOURS = 24;
export const DESCRIPTION_MAX_CHARS = 180;
export const MAX_STDOUT_BYTES = 200_000;
export const COMMAND_TIMEOUT_MS = 12_000;
export const EVENT_LOG_TIMEOUT_MS = 30_000;
export const PING_WAIT_MS = 2000;
export const MAX_CONSUMERS = 15;
export const DEFAULT_CPU_SAMPLE_MS = 400;
export const MIN_CPU_SAMPLE_MS = 200;
export const MAX_CPU_SAMPLE_MS = 2_000;

export const PROCESS_INTERPRETATION_LIMITS = [
    "A running process does not mean the application is healthy or crash-free.",
    "cpuSeconds is cumulative processor time since the process started, not current CPU utilization.",
    "status responding only means the main window is not marked hung right now.",
];

export const CONSUMER_INTERPRETATION_LIMITS = [
    "cpuPercentSampled is estimated utilization during a short sample, as a percent of one logical processor.",
    "cpuSecondsCumulative is total processor time since the process started, not current utilization.",
    "Process presence and memory size do not prove an application is healthy or crash-free.",
];

const ALLOWED_EXECUTABLES = new Set(["powershell.exe", "ping.exe"]);
const HOSTILE_NAME_CHARS = /[*?[\]$`;&|<>(){}!\\/"'\n\r\t,]/;

const PS_PREFIX = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
];

const PS_PREAMBLE =
    "$ProgressPreference = 'SilentlyContinue'; " +
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false";

function psCommand(body) {
    return `${PS_PREAMBLE}; ${body}`;
}

export const PS_COMMANDS = {
    processesTop: psCommand(
        "Get-Process | Sort-Object WorkingSet64 -Descending | " +
            `Select-Object -First ${MAX_PROCESSES} ` +
            "Name, Id, CPU, WorkingSet64, StartTime, Responding | " +
            "ConvertTo-Json -Compress",
    ),
    processesByName: psCommand(
        "$name = $env:LOCAL_AI_WIN_PROCESS_NAME; " +
            "if (-not $name) { exit 0 }; " +
            "Get-Process -Name $name -ErrorAction SilentlyContinue | " +
            `Select-Object -First ${MAX_PROCESSES} ` +
            "Name, Id, CPU, WorkingSet64, StartTime, Responding | " +
            "ConvertTo-Json -Compress",
    ),
    eventLog: psCommand(
        "$log = $env:LOCAL_AI_WIN_LOG_NAME; " +
            "$max = [int]$env:LOCAL_AI_WIN_MAX; " +
            "$provider = $env:LOCAL_AI_WIN_PROVIDER; " +
            "$start = [DateTimeOffset]::Parse(" +
            "$env:LOCAL_AI_WIN_START, " +
            "[Globalization.CultureInfo]::InvariantCulture).LocalDateTime; " +
            "$end = [DateTimeOffset]::Parse(" +
            "$env:LOCAL_AI_WIN_END, " +
            "[Globalization.CultureInfo]::InvariantCulture).LocalDateTime; " +
            "$hash = @{ LogName = $log; StartTime = $start; EndTime = $end; Level = 1,2,3 }; " +
            "if ($provider) { $hash['ProviderName'] = $provider }; " +
            "try { " +
            "Get-WinEvent -FilterHashtable $hash -MaxEvents $max -ErrorAction Stop | " +
            "Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, " +
            "@{N='Message';E={ " +
            "  if ($null -eq $_.Message) { '' } " +
            "  else { $_.Message.Substring(0, [Math]::Min(200, $_.Message.Length)) } " +
            "}} | ConvertTo-Json -Compress " +
            "} catch { " +
            "$id = [string]$_.FullyQualifiedErrorId; " +
            "$msg = [string]$_.Exception.Message; " +
            "if ($id -like 'NoMatchingEventsFound*') { Write-Output '[]'; exit 0 }; " +
            "if ($id -like '*UnauthorizedAccess*' -or $msg -match 'access is denied') { exit 5 }; " +
            "if ($id -like '*EventLogNotFound*' -or $msg -match 'does not exist') { exit 3 }; " +
            "exit 2 " +
            "}",
    ),
    resourceConsumers: psCommand(
        "$sample = [int]$env:LOCAL_AI_WIN_SAMPLE_MS; " +
            "if ($sample -lt 200) { $sample = 400 }; " +
            "$first = @(Get-Process | Select-Object Id, Name, CPU, WorkingSet64); " +
            "Start-Sleep -Milliseconds $sample; " +
            "$second = @(Get-Process | Select-Object Id, Name, CPU, WorkingSet64); " +
            "$map = @{}; " +
            "foreach ($p in $first) { $map[[string]$p.Id] = $p }; " +
            "$out = @(); " +
            "foreach ($p in $second) { " +
            "$prev = $map[[string]$p.Id]; " +
            "$cpu1 = if ($null -ne $prev -and $null -ne $prev.CPU) { [double]$prev.CPU } else { $null }; " +
            "$cpu2 = if ($null -ne $p.CPU) { [double]$p.CPU } else { $null }; " +
            "$delta = if ($null -ne $cpu1 -and $null -ne $cpu2) { $cpu2 - $cpu1 } else { $null }; " +
            "$out += [pscustomobject]@{ " +
            "Name = $p.Name; Id = $p.Id; CPU = $cpu2; CpuDelta = $delta; " +
            "WorkingSet64 = $p.WorkingSet64 " +
            "} " +
            "}; " +
            "$out | ConvertTo-Json -Compress",
    ),
    servicesTop: psCommand(
        "Get-Service -ErrorAction SilentlyContinue | " +
            `Select-Object -First ${MAX_SERVICES} ` +
            "Name, DisplayName, Status, StartType | ConvertTo-Json -Compress",
    ),
    servicesByName: psCommand(
        "$name = $env:LOCAL_AI_WIN_SERVICE_NAME; " +
            "if (-not $name) { exit 0 }; " +
            "Get-Service -Name $name -ErrorAction SilentlyContinue | " +
            "Select-Object Name, DisplayName, Status, StartType | " +
            "ConvertTo-Json -Compress",
    ),
    dnsServers: psCommand(
        "Get-DnsClientServerAddress -AddressFamily IPv4 " +
            "-ErrorAction SilentlyContinue | " +
            "Where-Object { $_.ServerAddresses -and $_.ServerAddresses.Count -gt 0 } | " +
            "Select-Object InterfaceAlias, ServerAddresses | ConvertTo-Json -Compress",
    ),
    externalDrives: psCommand(
        "$rows = @(); " +
            "try { " +
            "$disks = @(Get-Disk -ErrorAction Stop); " +
            "foreach ($disk in $disks) { " +
            "$parts = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.DriveLetter }); " +
            "foreach ($part in $parts) { " +
            "$letter = [string]$part.DriveLetter; " +
            "if (-not $letter) { continue }; " +
            "$vol = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue; " +
            "if (-not $vol) { continue }; " +
            "$rows += [pscustomobject]@{ " +
            "Mount = ($letter + ':\\'); " +
            "Label = [string]$vol.FileSystemLabel; " +
            "FileSystem = [string]$vol.FileSystem; " +
            "TotalBytes = [int64]$vol.Size; " +
            "FreeBytes = [int64]$vol.SizeRemaining; " +
            "DriveType = [string]$vol.DriveType; " +
            "BusType = [string]$disk.BusType; " +
            "VolumeSerialNumber = [string]$vol.UniqueId; " +
            "DiskUniqueId = [string]$disk.UniqueId; " +
            "DiskNumber = [int]$disk.Number " +
            "} " +
            "} " +
            "} " +
            "} catch { " +
            "$logical = @(Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction SilentlyContinue); " +
            "foreach ($d in $logical) { " +
            "if (-not $d.DeviceID) { continue }; " +
            "$rows += [pscustomobject]@{ " +
            "Mount = ([string]$d.DeviceID + '\\'); " +
            "Label = [string]$d.VolumeName; " +
            "FileSystem = [string]$d.FileSystem; " +
            "TotalBytes = [int64]$d.Size; " +
            "FreeBytes = [int64]$d.FreeSpace; " +
            "DriveType = [string]$d.DriveType; " +
            "BusType = ''; " +
            "VolumeSerialNumber = [string]$d.VolumeSerialNumber; " +
            "DiskUniqueId = ''; " +
            "DiskNumber = $null " +
            "} " +
            "} " +
            "}; " +
            "$rows | ConvertTo-Json -Compress",
    ),
};

const ALLOWED_PS_COMMANDS = new Set(Object.values(PS_COMMANDS));

let runWindowsCommand = defaultRunWindowsCommand;
let platformOverride = null;
let cpuSampleDelayMs = 150;
let nowOverrideMs = null;


function currentPlatform() {
    return platformOverride ?? process.platform;
}


function nowDate() {
    return nowOverrideMs == null ? new Date() : new Date(nowOverrideMs);
}


function queryTimeWindow(hours) {
    const windowEnd = nowDate();
    const windowStart = new Date(windowEnd.getTime() - hours * 60 * 60 * 1000);
    let timeZone = "UTC";

    try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        timeZone = "UTC";
    }

    return {
        windowStart,
        windowEnd,
        timeZone,
        utcOffsetMinutes: -windowEnd.getTimezoneOffset(),
    };
}


function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function assertWindows() {
    if (currentPlatform() !== "win32") {
        throw Object.assign(new Error(UNSUPPORTED_PLATFORM_MESSAGE), {
            code: "UNSUPPORTED_PLATFORM",
        });
    }
}


function throwAccessDenied() {
    throw Object.assign(new Error(ACCESS_DENIED_MESSAGE), {
        code: "ACCESS_DENIED",
    });
}


function looksLikeAccessDenied(text, exitCode) {
    if (exitCode === 5) {
        return true;
    }

    const blob = String(text ?? "").toLowerCase();
    return (
        blob.includes("access is denied") ||
        blob.includes("access denied") ||
        blob.includes("unauthorizedaccess")
    );
}


function requireOptionalString(args, field, maxLength) {
    if (!(field in args) || args[field] === undefined) {
        return undefined;
    }

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


function assertSafeToken(value, field, pattern) {
    if (HOSTILE_NAME_CHARS.test(value) || !pattern.test(value)) {
        throw new Error(`"${field}" has an invalid format.`);
    }
}


function stripExeSuffix(name) {
    return name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name;
}


export function validateInspectProcesses(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, ["name"]);

    const validated = {};
    const name = requireOptionalString(args, "name", 64);

    if (name !== undefined) {
        const processName = stripExeSuffix(name);
        assertSafeToken(processName, "name", PROCESS_NAME_PATTERN);
        validated.name = processName;
    }

    return validated;
}


export function validateInspectEventLog(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, ["logName", "provider", "hours", "maxResults"]);

    const logRaw = requireOptionalString(args, "logName", 32) ?? "Application";
    const logName = EVENT_LOG_NAMES.find(
        (name) => name.toLowerCase() === logRaw.toLowerCase(),
    );

    if (!logName) {
        throw new Error('"logName" must be Application or System.');
    }

    const validated = {
        logName,
        hours: optionalInteger(
            args,
            "hours",
            DEFAULT_EVENT_HOURS,
            MIN_EVENT_HOURS,
            MAX_EVENT_HOURS,
        ),
        maxResults: optionalInteger(
            args,
            "maxResults",
            DEFAULT_EVENT_RESULTS,
            1,
            MAX_EVENT_RESULTS,
        ),
    };

    const provider = requireOptionalString(args, "provider", 128);

    if (provider !== undefined) {
        assertSafeToken(provider, "provider", PROVIDER_PATTERN);
        validated.provider = provider;
    }

    return validated;
}


export function validateInspectSystemHealth(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, []);
    return {};
}


export function validateInspectServices(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, ["name", "nameContains"]);

    const name = requireOptionalString(args, "name", 64);
    const nameContains = requireOptionalString(args, "nameContains", 64);

    if (name !== undefined && nameContains !== undefined) {
        throw new Error('Use either "name" or "nameContains", not both.');
    }

    const validated = {};

    if (name !== undefined) {
        assertSafeToken(name, "name", SERVICE_NAME_PATTERN);
        validated.name = name;
    }

    if (nameContains !== undefined) {
        assertSafeToken(nameContains, "nameContains", SERVICE_FILTER_PATTERN);
        validated.nameContains = nameContains;
    }

    return validated;
}


export function validateInspectNetwork(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, ["destination"]);

    const destination = requireOptionalString(args, "destination", 16);

    if (destination === undefined) {
        return {};
    }

    if (!ALLOWED_PING_TARGETS.includes(destination)) {
        throw new Error(
            '"destination" must be one of: ' +
                `${ALLOWED_PING_TARGETS.join(", ")}.`,
        );
    }

    return { destination };
}


export function validateInspectResourceConsumers(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, ["sampleMs"]);

    return {
        sampleMs: optionalInteger(
            args,
            "sampleMs",
            DEFAULT_CPU_SAMPLE_MS,
            MIN_CPU_SAMPLE_MS,
            MAX_CPU_SAMPLE_MS,
        ),
    };
}


export function validateInspectExternalDrives(args) {
    if (!isPlainObject(args)) {
        throw new Error("Tool arguments must be an object.");
    }

    rejectUnknownKeys(args, []);
    return {};
}


/**
 * Classify a Windows volume for offload destination selection.
 * Never claims certainty when BusType/DriveType are missing.
 *
 * @param {{ driveType?: string|null, busType?: string|null }} input
 */
export function classifyDrive(input) {
    const driveType = String(input?.driveType ?? "").trim().toLowerCase();
    const busType = String(input?.busType ?? "").trim().toLowerCase();

    const removable =
        driveType === "2" ||
        driveType === "removable";
    const fixed =
        driveType === "3" ||
        driveType === "fixed" ||
        driveType === "local disk";
    const usb = busType === "usb" || busType === "4";
    const knownInternalBus =
        busType === "nvme" ||
        busType === "sata" ||
        busType === "raid" ||
        busType === "scsi" ||
        busType === "sas" ||
        busType === "ide" ||
        busType === "17" ||
        busType === "11";

    if (removable) {
        return {
            classification: "removable",
            confidence: busType ? "high" : "medium",
            uncertainty: busType
                ? null
                : "Bus type was not reported; treated as removable from DriveType.",
        };
    }

    if (fixed && usb) {
        return {
            classification: "external",
            confidence: "high",
            uncertainty: null,
        };
    }

    if (fixed && knownInternalBus) {
        return {
            classification: "internal",
            confidence: "high",
            uncertainty: null,
        };
    }

    if (fixed && !busType) {
        return {
            classification: "unknown",
            confidence: "low",
            uncertainty:
                "Fixed volume without BusType. Do not assume it is an external drive.",
        };
    }

    if (usb) {
        return {
            classification: "external",
            confidence: "medium",
            uncertainty: "USB bus reported without a clear removable DriveType.",
        };
    }

    return {
        classification: "unknown",
        confidence: "low",
        uncertainty:
            "Could not determine whether this volume is internal, removable, or external.",
    };
}


function volumeIdentity(row) {
    const serial =
        typeof row.VolumeSerialNumber === "string" && row.VolumeSerialNumber.trim()
            ? row.VolumeSerialNumber.trim()
            : null;
    const diskId =
        typeof row.DiskUniqueId === "string" && row.DiskUniqueId.trim()
            ? row.DiskUniqueId.trim()
            : null;
    const mount = typeof row.Mount === "string" ? row.Mount : "";

    if (serial || diskId) {
        return {
            volumeId: [diskId, serial].filter(Boolean).join("|"),
            volumeSerialNumber: serial,
            diskUniqueId: diskId,
            identityConfidence: serial && diskId ? "high" : "medium",
        };
    }

    return {
        volumeId: mount ? `mount:${mount}` : null,
        volumeSerialNumber: null,
        diskUniqueId: null,
        identityConfidence: "low",
    };
}


export function pingArgs(destination) {
    if (!ALLOWED_PING_TARGETS.includes(destination)) {
        throw new Error('"destination" is not allowlisted.');
    }

    return ["-n", "1", "-w", String(PING_WAIT_MS), destination];
}


export function powershellArgs(command) {
    if (!ALLOWED_PS_COMMANDS.has(command)) {
        throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
    }

    return [...PS_PREFIX, command];
}


export function assertAllowedCommandSpec(spec) {
    if (!spec || typeof spec !== "object") {
        throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
    }

    const executable = path.basename(String(spec.executable ?? "")).toLowerCase();

    if (!ALLOWED_EXECUTABLES.has(executable)) {
        throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
    }

    const args = Array.isArray(spec.args) ? spec.args : [];

    if (executable === "powershell.exe") {
        if (args.length !== PS_PREFIX.length + 1) {
            throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
        }

        for (let i = 0; i < PS_PREFIX.length; i += 1) {
            if (args[i] !== PS_PREFIX[i]) {
                throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
            }
        }

        if (!ALLOWED_PS_COMMANDS.has(args[PS_PREFIX.length])) {
            throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
        }

        return;
    }

    if (args.length !== 5 || args[0] !== "-n" || args[1] !== "1") {
        throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
    }

    if (args[2] !== "-w" || args[3] !== String(PING_WAIT_MS)) {
        throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
    }

    if (!ALLOWED_PING_TARGETS.includes(args[4])) {
        throw new Error(COMMAND_NOT_ALLOWED_MESSAGE);
    }
}


function decodeStdout(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.toString("utf16le");
    }

    if (buffer.length > 4 && buffer[1] === 0 && buffer[3] === 0) {
        return buffer.toString("utf16le");
    }

    return buffer.toString("utf8");
}


function defaultRunWindowsCommand(spec) {
    assertAllowedCommandSpec(spec);

    const timeoutMs = spec.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const maxBytes = spec.maxBytes ?? MAX_STDOUT_BYTES;
    const envExtra = spec.env && typeof spec.env === "object" ? spec.env : {};

    return new Promise((resolve, reject) => {
        const child = spawn(spec.executable, spec.args, {
            env: { ...process.env, ...envExtra },
            windowsHide: true,
            shell: false,
        });

        const stdoutChunks = [];
        const stderrChunks = [];
        let total = 0;
        let settled = false;

        const timer = setTimeout(() => {
            child.kill();
            finish(Object.assign(new Error(DIAGNOSTIC_TIMEOUT_MESSAGE), {
                code: "TIMEOUT",
            }));
        }, timeoutMs);

        function finish(error, result) {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);

            if (error) {
                error.code = error.code ?? "DIAGNOSTIC_FAILED";
                reject(error);
                return;
            }

            resolve(result);
        }

        child.stdout.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                child.kill();
                finish(new Error("Windows diagnostic output exceeded the size limit."));
                return;
            }
            stdoutChunks.push(chunk);
        });

        child.stderr.on("data", (chunk) => {
            if (stderrChunks.length < 8) {
                stderrChunks.push(chunk);
            }
        });

        child.on("error", (error) => {
            finish(error);
        });

        child.on("close", (exitCode) => {
            const stdout = decodeStdout(Buffer.concat(stdoutChunks));
            const stderr = decodeStdout(Buffer.concat(stderrChunks));
            finish(null, {
                stdout,
                stderr,
                exitCode: exitCode ?? 1,
            });
        });
    });
}


async function runAllowedCommand(spec) {
    const result = await runWindowsCommand(spec);
    const stdout = result?.stdout ?? "";
    const stderr = result?.stderr ?? "";
    const exitCode = result?.exitCode ?? 0;

    if (looksLikeAccessDenied(`${stdout}\n${stderr}`, exitCode)) {
        throwAccessDenied();
    }

    if (exitCode === 3) {
        throw Object.assign(new Error(EVENT_LOG_UNAVAILABLE_MESSAGE), {
            code: "UNAVAILABLE",
        });
    }

    if (exitCode !== 0) {
        throw Object.assign(
            new Error("Windows diagnostic failed."),
            { code: "DIAGNOSTIC_FAILED" },
        );
    }

    return stdout;
}


function parseJsonArray(text) {
    const trimmed = String(text ?? "").replace(/^\uFEFF/, "").trim();

    if (!trimmed) {
        return [];
    }

    let parsed;

    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error("Windows diagnostic returned unreadable output.");
    }

    if (Array.isArray(parsed)) {
        return parsed;
    }

    if (parsed && typeof parsed === "object") {
        return [parsed];
    }

    return [];
}


export function sanitizeDescription(text) {
    if (typeof text !== "string") {
        return "";
    }

    let value = text.replace(/\s+/g, " ").trim();
    value = value.replace(/[A-Za-z]:\\[^\s]{6,}/g, "[path]");
    value = value.replace(/\/(?:Users|home|var|etc|Windows)[^\s]{3,}/gi, "[path]");
    value = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
    value = value.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]");

    if (value.length > DESCRIPTION_MAX_CHARS) {
        return `${value.slice(0, DESCRIPTION_MAX_CHARS - 1)}…`;
    }

    return value;
}


function toIso(value) {
    if (!value) {
        return null;
    }

    if (typeof value === "string") {
        const microsoft = value.match(/\/Date\((\d+)\)\//);
        if (microsoft) {
            return toIso(Number(microsoft[1]));
        }
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toISOString();
}


function asFiniteNumber(value) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}


function readCpuSnapshot() {
    let idle = 0;
    let total = 0;

    for (const cpu of os.cpus()) {
        const times = cpu.times;
        idle += times.idle;
        total += times.user + times.nice + times.sys + times.idle + times.irq;
    }

    return { idle, total };
}


async function measureCpuPercent() {
    const first = readCpuSnapshot();

    if (cpuSampleDelayMs > 0) {
        await new Promise((resolve) => {
            setTimeout(resolve, cpuSampleDelayMs);
        });
    }

    const second = readCpuSnapshot();
    const idle = second.idle - first.idle;
    const total = second.total - first.total;

    if (total <= 0) {
        return null;
    }

    return Math.round((1 - idle / total) * 1000) / 10;
}


async function inspectDisks() {
    if (typeof fs.statfs !== "function") {
        return [];
    }

    const mounts =
        currentPlatform() === "win32"
            ? [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `${letter}:\\`)
            : ["/"];

    const disks = [];

    for (const mount of mounts) {
        try {
            const stats = await fs.statfs(mount);
            const blockSize = asFiniteNumber(stats.bsize) ?? 0;
            const totalBytes = blockSize * (asFiniteNumber(stats.blocks) ?? 0);
            const freeBytes = blockSize * (asFiniteNumber(stats.bavail) ?? 0);

            if (totalBytes <= 0) {
                continue;
            }

            disks.push({
                mount,
                totalBytes,
                freeBytes,
                usedPercent: Math.round((1 - freeBytes / totalBytes) * 1000) / 10,
            });
        } catch {
            // Drive letter or mount is absent.
        }
    }

    return disks;
}


function collectAdapters() {
    const collected = [];
    const interfaces = os.networkInterfaces();

    for (const [name, entries] of Object.entries(interfaces)) {
        if (!Array.isArray(entries)) {
            continue;
        }

        for (const entry of entries) {
            collected.push({
                name,
                family: entry.family === 6 || entry.family === "IPv6" ? "IPv6" : "IPv4",
                address: typeof entry.address === "string" ? entry.address : null,
                internal: entry.internal === true,
            });
        }
    }

    return collected;
}


async function runPowerShell(command, env, timeoutMs = COMMAND_TIMEOUT_MS) {
    return runAllowedCommand({
        executable: "powershell.exe",
        args: powershellArgs(command),
        env,
        timeoutMs,
        maxBytes: MAX_STDOUT_BYTES,
    });
}


export async function inspectProcesses(args) {
    assertWindows();
    const { name } = validateInspectProcesses(args ?? {});

    const stdout = name
        ? await runPowerShell(PS_COMMANDS.processesByName, {
            LOCAL_AI_WIN_PROCESS_NAME: name,
        })
        : await runPowerShell(PS_COMMANDS.processesTop, {});

    const rows = parseJsonArray(stdout);
    const processes = [];

    for (const row of rows) {
        if (processes.length >= MAX_PROCESSES) {
            break;
        }

        if (!row || typeof row !== "object") {
            continue;
        }

        const processName = typeof row.Name === "string" ? row.Name : "";

        if (!processName) {
            continue;
        }

        const responding =
            typeof row.Responding === "boolean" ? row.Responding : null;

        processes.push({
            name: processName,
            pid: asFiniteNumber(row.Id),
            cpuSeconds: asFiniteNumber(row.CPU),
            memoryBytes: asFiniteNumber(row.WorkingSet64),
            startedAt: toIso(row.StartTime),
            status:
                responding === true
                    ? "responding"
                    : responding === false
                        ? "not_responding"
                        : "unknown",
        });
    }

    return {
        untrusted: true,
        truncated: !name && processes.length >= MAX_PROCESSES,
        name: name ?? null,
        processes,
        interpretationLimits: [...PROCESS_INTERPRETATION_LIMITS],
    };
}


export async function inspectEventLog(args) {
    assertWindows();
    const { logName, provider, hours, maxResults } = validateInspectEventLog(
        args ?? {},
    );
    const { windowStart, windowEnd, timeZone, utcOffsetMinutes } =
        queryTimeWindow(hours);

    const stdout = await runPowerShell(
        PS_COMMANDS.eventLog,
        {
            LOCAL_AI_WIN_LOG_NAME: logName,
            LOCAL_AI_WIN_HOURS: String(hours),
            LOCAL_AI_WIN_START: windowStart.toISOString(),
            LOCAL_AI_WIN_END: windowEnd.toISOString(),
            LOCAL_AI_WIN_MAX: String(maxResults),
            LOCAL_AI_WIN_PROVIDER: provider ?? "",
        },
        EVENT_LOG_TIMEOUT_MS,
    );

    const rows = parseJsonArray(stdout);
    const events = [];
    const startMs = windowStart.getTime();
    const endMs = windowEnd.getTime();

    for (const row of rows) {
        if (events.length >= maxResults) {
            break;
        }

        if (!row || typeof row !== "object") {
            continue;
        }

        const time = toIso(row.TimeCreated);
        const timeMs = time ? Date.parse(time) : Number.NaN;

        if (!Number.isFinite(timeMs) || timeMs < startMs || timeMs > endMs) {
            continue;
        }

        events.push({
            time,
            id: asFiniteNumber(row.Id),
            severity:
                typeof row.LevelDisplayName === "string"
                    ? row.LevelDisplayName
                    : "Unknown",
            source:
                typeof row.ProviderName === "string" ? row.ProviderName : "",
            description: sanitizeDescription(row.Message),
        });
    }

    return {
        untrusted: true,
        tool: "inspect_event_log",
        logName,
        hours,
        provider: provider ?? null,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        timeZone,
        utcOffsetMinutes,
        queriedAt: windowEnd.toISOString(),
        truncated: events.length >= maxResults,
        events,
    };
}


export async function inspectSystemHealth(args) {
    assertWindows();
    validateInspectSystemHealth(args ?? {});

    const totalBytes = os.totalmem();
    const availableBytes = os.freemem();
    const cpuPercent = await measureCpuPercent();
    const disks = await inspectDisks();
    const memoryUsedPercent =
        totalBytes > 0
            ? Math.round((1 - availableBytes / totalBytes) * 1000) / 10
            : null;

    const pressure = [];

    function pushPressure(resource, percent, mount) {
        if (typeof percent !== "number" || !Number.isFinite(percent)) {
            return;
        }

        let severity = null;
        if (percent >= 90) {
            severity = "high";
        } else if (percent >= 75) {
            severity = "medium";
        }

        if (!severity) {
            return;
        }

        const entry = { resource, percent, severity };
        if (mount) {
            entry.mount = mount;
        }
        pressure.push(entry);
    }

    pushPressure("cpu", cpuPercent);
    pushPressure("memory", memoryUsedPercent);

    for (const disk of disks) {
        pushPressure("disk", disk.usedPercent, disk.mount);
    }

    return {
        untrusted: true,
        os: {
            platform: os.platform(),
            type: os.type(),
            release: os.release(),
            arch: os.arch(),
            uptimeSeconds: Math.round(os.uptime()),
        },
        cpu: {
            percent: cpuPercent,
            logicalProcessors: os.cpus().length,
        },
        memory: {
            totalBytes,
            availableBytes,
            usedPercent: memoryUsedPercent,
        },
        disks,
        pressure,
        interpretationLimits: [
            "These metrics are a snapshot. They do not identify which process or folder is responsible.",
            "Disk usedPercent is volume capacity, not a recursive scan of files.",
        ],
    };
}


function mapService(row) {
    if (!row || typeof row !== "object") {
        return null;
    }

    const name = typeof row.Name === "string" ? row.Name : "";

    if (!name) {
        return null;
    }

    return {
        name,
        displayName:
            typeof row.DisplayName === "string" ? row.DisplayName : name,
        status: typeof row.Status === "string" ? row.Status : String(row.Status ?? "Unknown"),
        startType:
            typeof row.StartType === "string"
                ? row.StartType
                : row.StartType == null
                    ? null
                    : String(row.StartType),
    };
}


export async function inspectServices(args) {
    assertWindows();
    const { name, nameContains } = validateInspectServices(args ?? {});

    const stdout = name
        ? await runPowerShell(PS_COMMANDS.servicesByName, {
            LOCAL_AI_WIN_SERVICE_NAME: name,
        })
        : await runPowerShell(PS_COMMANDS.servicesTop, {});

    const mapped = parseJsonArray(stdout)
        .map(mapService)
        .filter(Boolean);

    const needle = nameContains ? nameContains.toLowerCase() : null;
    const services = [];

    for (const service of mapped) {
        if (needle) {
            const haystack =
                `${service.name} ${service.displayName}`.toLowerCase();
            if (!haystack.includes(needle)) {
                continue;
            }
        }

        services.push(service);

        if (services.length >= MAX_SERVICES) {
            break;
        }
    }

    return {
        untrusted: true,
        name: name ?? null,
        nameContains: nameContains ?? null,
        truncated: !name && mapped.length >= MAX_SERVICES,
        services,
    };
}


function mapConsumerRow(row, sampleMs) {
    if (!row || typeof row !== "object") {
        return null;
    }

    const processName = typeof row.Name === "string" ? row.Name : "";

    if (!processName) {
        return null;
    }

    const cpuDelta = asFiniteNumber(row.CpuDelta);
    const sampleSeconds = sampleMs / 1000;
    const cpuPercentSampled =
        cpuDelta != null && sampleSeconds > 0
            ? Math.round((cpuDelta / sampleSeconds) * 1000) / 10
            : null;

    return {
        name: processName,
        pid: asFiniteNumber(row.Id),
        workingSetBytes: asFiniteNumber(row.WorkingSet64),
        cpuSecondsCumulative: asFiniteNumber(row.CPU),
        cpuPercentSampled,
        sampleMs,
    };
}


export async function inspectResourceConsumers(args) {
    assertWindows();
    const { sampleMs } = validateInspectResourceConsumers(args ?? {});

    const stdout = await runPowerShell(PS_COMMANDS.resourceConsumers, {
        LOCAL_AI_WIN_SAMPLE_MS: String(sampleMs),
    });

    const mapped = parseJsonArray(stdout)
        .map((row) => mapConsumerRow(row, sampleMs))
        .filter(Boolean);

    const byMemory = [...mapped]
        .sort(
            (left, right) =>
                (right.workingSetBytes ?? 0) - (left.workingSetBytes ?? 0),
        )
        .slice(0, MAX_CONSUMERS);

    const byCpu = [...mapped]
        .filter((item) => item.cpuPercentSampled != null)
        .sort(
            (left, right) =>
                (right.cpuPercentSampled ?? 0) - (left.cpuPercentSampled ?? 0),
        )
        .slice(0, MAX_CONSUMERS);

    return {
        untrusted: true,
        sampleMs,
        truncated: mapped.length > MAX_CONSUMERS,
        byMemory,
        byCpu,
        interpretationLimits: [...CONSUMER_INTERPRETATION_LIMITS],
    };
}


export async function inspectExternalDrives(args) {
    assertWindows();
    validateInspectExternalDrives(args ?? {});

    const stdout = await runPowerShell(PS_COMMANDS.externalDrives, {});
    const rows = parseJsonArray(stdout);
    const volumes = [];

    for (const row of rows) {
        if (!row || typeof row !== "object") {
            continue;
        }

        const mount = typeof row.Mount === "string" ? row.Mount : "";

        if (!/^[A-Za-z]:\\$/.test(mount)) {
            continue;
        }

        const totalBytes = asFiniteNumber(row.TotalBytes);
        const freeBytes = asFiniteNumber(row.FreeBytes);

        if (!totalBytes || totalBytes <= 0) {
            continue;
        }

        const classified = classifyDrive({
            driveType: row.DriveType,
            busType: row.BusType,
        });
        const identity = volumeIdentity(row);

        volumes.push({
            mount,
            label:
                typeof row.Label === "string" && row.Label.trim()
                    ? row.Label.trim()
                    : null,
            fileSystem:
                typeof row.FileSystem === "string" && row.FileSystem.trim()
                    ? row.FileSystem.trim()
                    : null,
            totalBytes,
            freeBytes: freeBytes ?? null,
            usedPercent:
                freeBytes != null && totalBytes > 0
                    ? Math.round((1 - freeBytes / totalBytes) * 1000) / 10
                    : null,
            driveType:
                row.DriveType == null ? null : String(row.DriveType),
            busType:
                typeof row.BusType === "string" && row.BusType.trim()
                    ? row.BusType.trim()
                    : null,
            classification: classified.classification,
            confidence: classified.confidence,
            uncertainty: classified.uncertainty,
            volumeId: identity.volumeId,
            volumeSerialNumber: identity.volumeSerialNumber,
            diskUniqueId: identity.diskUniqueId,
            identityConfidence: identity.identityConfidence,
            diskNumber: asFiniteNumber(row.DiskNumber),
        });
    }

    return {
        untrusted: true,
        tool: "inspect_external_drives",
        queriedAt: new Date().toISOString(),
        volumes,
        interpretationLimits: [
            "classification is best-effort from DriveType and BusType.",
            "identityConfidence=low means the volume may not be revalidated reliably after remount.",
            "This tool does not grant scan access and does not walk folder contents.",
        ],
    };
}


function parsePingRtt(stdout) {
    const match = String(stdout).match(
        /(?:time[=<]|Average\s*=\s*)(\d+)\s*ms/i,
    );
    return match ? Number(match[1]) : null;
}


export async function inspectNetwork(args) {
    assertWindows();
    const { destination } = validateInspectNetwork(args ?? {});
    const adapters = collectAdapters();

    let dns = [];
    let dnsError = null;

    try {
        const stdout = await runPowerShell(PS_COMMANDS.dnsServers, {});
        dns = parseJsonArray(stdout).map((row) => ({
            interface:
                typeof row.InterfaceAlias === "string" ? row.InterfaceAlias : "",
            servers: Array.isArray(row.ServerAddresses)
                ? row.ServerAddresses.filter((item) => typeof item === "string")
                : [],
        })).filter((item) => item.interface || item.servers.length > 0);
    } catch (error) {
        dnsError =
            error?.code === "ACCESS_DENIED"
                ? ACCESS_DENIED_MESSAGE
                : "Could not read DNS configuration.";
    }

    let connectivity = null;

    if (destination) {
        try {
            const pingResult = await runWindowsCommand({
                executable: "ping.exe",
                args: pingArgs(destination),
                env: {},
                timeoutMs: COMMAND_TIMEOUT_MS,
                maxBytes: 16_000,
            });
            const stdout = pingResult?.stdout ?? "";
            const stderr = pingResult?.stderr ?? "";
            const exitCode = pingResult?.exitCode ?? 1;

            if (looksLikeAccessDenied(`${stdout}\n${stderr}`, exitCode)) {
                throwAccessDenied();
            }

            const reachable =
                exitCode === 0 &&
                (/ttl=/i.test(stdout) || /Average\s*=/i.test(stdout));

            connectivity = {
                destination,
                reachable,
                roundTripMs: parsePingRtt(stdout),
            };
        } catch (error) {
            if (error?.code === "ACCESS_DENIED") {
                throw error;
            }

            connectivity = {
                destination,
                reachable: false,
                roundTripMs: null,
            };
        }
    }

    const result = {
        untrusted: true,
        adapters,
        dns,
        connectivity,
    };

    if (dnsError) {
        result.dnsError = dnsError;
    }

    return result;
}


/** Test helpers — not for production routes. */
export const _test = {
    setRunWindowsCommand(fn) {
        runWindowsCommand = fn ?? defaultRunWindowsCommand;
    },
    setPlatform(value) {
        platformOverride = value;
    },
    setCpuSampleDelayMs(value) {
        cpuSampleDelayMs = Number.isInteger(value) ? value : 150;
    },
    setNow(value) {
        nowOverrideMs = value == null ? null : Number(value);
    },
    reset() {
        runWindowsCommand = defaultRunWindowsCommand;
        platformOverride = null;
        cpuSampleDelayMs = 150;
        nowOverrideMs = null;
    },
    defaultRunWindowsCommand,
    parseJsonArray,
};
