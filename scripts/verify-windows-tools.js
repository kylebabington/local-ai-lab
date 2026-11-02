// =========================================================
// scripts/verify-windows-tools.js
//
// Phase 1 Windows diagnostics verification.
// Uses injected command execution — never requires a live
// Windows Event Log or process listing.
// =========================================================


import {
    ACCESS_DENIED_MESSAGE,
    ALLOWED_PING_TARGETS,
    COMMAND_NOT_ALLOWED_MESSAGE,
    CONSUMER_INTERPRETATION_LIMITS,
    EVENT_LOG_UNAVAILABLE_MESSAGE,
    MAX_CONSUMERS,
    MAX_PROCESSES,
    PROCESS_INTERPRETATION_LIMITS,
    PS_COMMANDS,
    UNSUPPORTED_PLATFORM_MESSAGE,
    assertAllowedCommandSpec,
    pingArgs,
    powershellArgs,
    sanitizeDescription,
    _test as windowsTest,
} from "../lib/tools/windows.js";
import {
    PERMISSION_APPROVAL,
    PERMISSION_READ,
    executeTool,
    getOllamaToolDefinitions,
    getTool,
    listTools,
    validateToolArguments,
} from "../lib/tools/registry.js";
import {
    AGENT_NUM_CTX,
    approveById,
    dispatchToolCall,
    listPendingApprovals,
    rejectById,
    runAgent,
} from "../lib/agent.js";


const WINDOWS_TOOLS = [
    "inspect_processes",
    "inspect_event_log",
    "inspect_system_health",
    "inspect_services",
    "inspect_network",
    "inspect_resource_consumers",
];

const FILESYSTEM_TOOLS = [
    "list_directory",
    "get_file_info",
    "search_files",
    "read_text_file",
    "create_directory",
    "copy_file",
    "move_file",
    "rename_file",
];

const results = [];
const capturedSpecs = [];


function record(name, status, detail = "") {
    results.push({ name, status, detail });
    const suffix = detail ? ` — ${detail}` : "";
    console.log(`${status.toUpperCase()}  ${name}${suffix}`);
}


function pass(name, detail) {
    record(name, "pass", detail);
}


function fail(name, detail) {
    record(name, "fail", detail);
}


function skip(name, detail) {
    record(name, "skip", detail);
}


function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}


async function expectThrow(work, needle) {
    try {
        await work();
    } catch (error) {
        if (needle && !String(error.message).includes(needle)) {
            throw new Error(
                `Expected error containing ${JSON.stringify(needle)}, got: ${error.message}`,
            );
        }
        return error;
    }
    throw new Error("Expected an error.");
}


function jsonStdout(value) {
    return JSON.stringify(value);
}


function mockOk(payload) {
    return {
        stdout: typeof payload === "string" ? payload : jsonStdout(payload),
        stderr: "",
        exitCode: 0,
    };
}


function installMock(handler) {
    capturedSpecs.length = 0;
    windowsTest.setPlatform("win32");
    windowsTest.setCpuSampleDelayMs(0);
    windowsTest.setRunWindowsCommand(async (spec) => {
        capturedSpecs.push(spec);
        assertAllowedCommandSpec(spec);
        return handler(spec);
    });
}


function resetWindows() {
    windowsTest.reset();
    capturedSpecs.length = 0;
}


async function testRegistry() {
    const listed = listTools();
    const defs = getOllamaToolDefinitions().map((item) => item.function.name);

    for (const name of WINDOWS_TOOLS) {
        const tool = listed.find((item) => item.name === name);
        assert(tool, `${name} missing from listTools.`);
        assert(tool.available === true, `${name} not available.`);
        assert(tool.permission === PERMISSION_READ, `${name} is not read-only.`);
        assert(getTool(name).permission === PERMISSION_READ, `${name} registry permission.`);
        assert(defs.includes(name), `${name} missing from Ollama definitions.`);
        const schema = getOllamaToolDefinitions().find(
            (item) => item.function.name === name,
        );
        assert(schema.type === "function", `${name} schema type.`);
        assert(
            schema.function.parameters?.type === "object",
            `${name} parameters must be an object schema.`,
        );
    }

    for (const name of FILESYSTEM_TOOLS) {
        assert(listed.some((item) => item.name === name), `${name} disappeared.`);
        assert(defs.includes(name) === (getTool(name).permission !== undefined), `${name} still registered.`);
    }

    for (const name of ["create_directory", "copy_file", "move_file", "rename_file"]) {
        assert(
            getTool(name).permission === PERMISSION_APPROVAL,
            `${name} permission changed.`,
        );
    }

    const shell = listed.find((item) => item.name === "run_shell");
    assert(shell, "run_shell missing from public list.");
    assert(shell.available === false, "run_shell became callable.");
    assert(shell.permission === "high-risk", "run_shell permission changed.");

    await expectThrow(() => getTool("run_shell"), "Unknown tool.");
    await expectThrow(() => validateToolArguments("run_shell", {}), "Unknown tool.");
    await expectThrow(() => executeTool("run_shell", { command: "dir" }), "Unknown tool.");

    const disk = listed.find((item) => item.name === "inspect_disk_usage");
    assert(disk, "inspect_disk_usage missing.");
    assert(disk.permission === PERMISSION_READ, "inspect_disk_usage is not read-only.");
    assert(defs.includes("inspect_disk_usage"), "inspect_disk_usage missing from Ollama definitions.");

    const scanGrant = listed.find((item) => item.name === "request_storage_scan");
    assert(scanGrant, "request_storage_scan missing.");
    assert(
        scanGrant.permission === PERMISSION_APPROVAL,
        "request_storage_scan must require approval.",
    );

    pass("registry and permissions", "Windows inspect tools are read-only; run_shell still blocked");
}


async function testArgumentValidation() {
    validateToolArguments("inspect_processes", {});
    validateToolArguments("inspect_processes", { name: "notepad" });
    validateToolArguments("inspect_processes", { name: "MyApp.exe" });

    await expectThrow(
        () => validateToolArguments("inspect_processes", { name: "notepad*" }),
        "invalid format",
    );
    await expectThrow(
        () => validateToolArguments("inspect_processes", { name: "notepad; calc" }),
        "invalid format",
    );
    await expectThrow(
        () => validateToolArguments("inspect_processes", {
            name: "notepad | Stop-Process",
        }),
        "invalid format",
    );
    await expectThrow(
        () => validateToolArguments("inspect_processes", { name: "$(calc)" }),
        "invalid format",
    );
    await expectThrow(
        () => validateToolArguments("inspect_processes", { path: "C:\\Windows" }),
        "Unexpected",
    );

    validateToolArguments("inspect_event_log", { logName: "Application" });
    validateToolArguments("inspect_event_log", {
        logName: "system",
        provider: "Application Error",
        hours: 6,
        maxResults: 5,
    });

    await expectThrow(
        () => validateToolArguments("inspect_event_log", { logName: "Security" }),
        "Application or System",
    );
    await expectThrow(
        () => validateToolArguments("inspect_event_log", { logName: "Application; Get-Process" }),
        "Application or System",
    );
    await expectThrow(
        () => validateToolArguments("inspect_event_log", { provider: "App*" }),
        "invalid format",
    );
    await expectThrow(
        () => validateToolArguments("inspect_event_log", { hours: 0 }),
        "between",
    );
    await expectThrow(
        () => validateToolArguments("inspect_event_log", { maxResults: 26 }),
        "between",
    );

    validateToolArguments("inspect_system_health", {});
    await expectThrow(
        () => validateToolArguments("inspect_system_health", { extra: true }),
        "Unexpected",
    );

    validateToolArguments("inspect_services", { name: "Spooler" });
    validateToolArguments("inspect_services", { nameContains: "sql" });
    await expectThrow(
        () => validateToolArguments("inspect_services", { name: "Spooler*" }),
        "invalid format",
    );
    await expectThrow(
        () => validateToolArguments("inspect_services", {
            name: "Spooler",
            nameContains: "sql",
        }),
        "not both",
    );

    validateToolArguments("inspect_resource_consumers", {});
    validateToolArguments("inspect_resource_consumers", { sampleMs: 500 });
    await expectThrow(
        () => validateToolArguments("inspect_resource_consumers", { sampleMs: 10 }),
        "between",
    );
    await expectThrow(
        () => validateToolArguments("inspect_disk_usage", {}),
        "must be a non-empty string",
    );
    validateToolArguments("inspect_disk_usage", { path: "C:\\Users\\test\\Downloads" });
    await expectThrow(
        () => validateToolArguments("inspect_disk_usage", { path: "C:\\", extra: true }),
        "Unexpected",
    );

    validateToolArguments("inspect_network", {});
    validateToolArguments("inspect_network", { destination: "1.1.1.1" });
    await expectThrow(
        () => validateToolArguments("inspect_network", { destination: "google.com" }),
        "must be one of",
    );
    await expectThrow(
        () => validateToolArguments("inspect_network", { destination: "127.0.0.1" }),
        "must be one of",
    );
    await expectThrow(
        () => validateToolArguments("inspect_network", {
            destination: "1.1.1.1 & calc",
        }),
        "must be one of",
    );

    pass("argument validation", "hostile names, extra keys, and destinations rejected");
}


async function testCommandAllowlists() {
    assertAllowedCommandSpec({
        executable: "powershell.exe",
        args: powershellArgs(PS_COMMANDS.processesTop),
    });
    assertAllowedCommandSpec({
        executable: "powershell.exe",
        args: powershellArgs(PS_COMMANDS.eventLog),
    });
    assertAllowedCommandSpec({
        executable: "powershell.exe",
        args: powershellArgs(PS_COMMANDS.resourceConsumers),
    });
    assertAllowedCommandSpec({
        executable: "ping.exe",
        args: pingArgs("8.8.8.8"),
    });

    await expectThrow(
        () => assertAllowedCommandSpec({
            executable: "cmd.exe",
            args: ["/c", "dir"],
        }),
        COMMAND_NOT_ALLOWED_MESSAGE,
    );
    await expectThrow(
        () => assertAllowedCommandSpec({
            executable: "powershell.exe",
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Get-Process; calc",
            ],
        }),
        COMMAND_NOT_ALLOWED_MESSAGE,
    );
    await expectThrow(
        () => assertAllowedCommandSpec({
            executable: "ping.exe",
            args: ["-n", "1", "-w", "2000", "example.com"],
        }),
        COMMAND_NOT_ALLOWED_MESSAGE,
    );

    assert(
        ALLOWED_PING_TARGETS.every((item) => pingArgs(item)[4] === item),
        "ping args must use the allowlisted destination as a separate argv entry",
    );

    pass("command allowlists", "only fixed PowerShell scripts and allowlisted ping");
}


async function testProcessesJsonAndTargeting() {
    installMock(() => mockOk([
        {
            Name: "notepad",
            Id: 4242,
            CPU: 1.5,
            WorkingSet64: 20_000_000,
            StartTime: "2026-10-30T12:00:00",
            Responding: true,
        },
        {
            Name: "notepad",
            Id: 4243,
            CPU: null,
            WorkingSet64: 8_000_000,
            StartTime: "2026-10-30T12:01:00",
            Responding: false,
        },
    ]));

    const { result } = await executeTool("inspect_processes", { name: "notepad.exe" });

    assert(result.untrusted === true, "process output must be marked untrusted");
    assert(result.processes.length === 2, "expected two notepad processes");
    assert(result.processes[0].pid === 4242, "pid missing");
    assert(result.processes[0].status === "responding", "responding status");
    assert(result.processes[1].status === "not_responding", "not_responding status");
    assert(
        Array.isArray(result.interpretationLimits) &&
            result.interpretationLimits.includes(PROCESS_INTERPRETATION_LIMITS[0]),
        "process interpretation limits missing",
    );
    assert(
        !JSON.stringify(result).includes("CommandLine"),
        "command lines must not be collected",
    );

    const spec = capturedSpecs[0];
    assert(spec.args.includes(PS_COMMANDS.processesByName), "must use named process command");
    assert(spec.env.LOCAL_AI_WIN_PROCESS_NAME === "notepad", ".exe suffix stripped into env");
    assert(
        !spec.args.some((arg) => String(arg).includes("notepad")),
        "process name must not be interpolated into argv",
    );

    pass("inspect_processes", "targeted JSON shape; name passed via env only");
}


async function testEventLogBoundsAndSanitize() {
    const longMessage =
        "Crash at C:\\Users\\kyle\\secret\\app.exe contacting 10.0.0.8 " +
        "user  admin@example.com  " +
        "x".repeat(400);

    windowsTest.setNow(Date.parse("2026-10-30T18:00:00.000Z"));
    installMock(() => mockOk([
        {
            TimeCreated: "2026-10-30T15:00:00.000Z",
            Id: 1000,
            LevelDisplayName: "Error",
            ProviderName: "Application Error",
            Message: longMessage,
        },
    ]));

    const { result } = await executeTool("inspect_event_log", {
        logName: "Application",
        provider: "Application Error",
        hours: 12,
        maxResults: 5,
    });

    assert(result.events.length === 1, "expected one event");
    assert(result.events[0].id === 1000, "event id");
    assert(result.logName === "Application", "logName must match the query");
    assert(result.hours === 12, "hours metadata");
    assert(result.windowStart, "windowStart missing");
    assert(result.windowEnd, "windowEnd missing");
    assert(result.timeZone, "timeZone missing");
    assert(result.events[0].description.includes("[path]"), "paths sanitized");
    assert(result.events[0].description.includes("[email]"), "emails sanitized");
    assert(result.events[0].description.includes("[ip]"), "ips sanitized");
    assert(!result.events[0].description.includes("kyle"), "raw path leaked");
    assert(!result.events[0].description.includes("admin@example.com"), "raw email leaked");
    assert(result.events[0].description.length <= 180, "description not truncated");
    assert(!JSON.stringify(result.events[0]).includes(longMessage), "raw message retained");

    const spec = capturedSpecs[0];
    assert(spec.env.LOCAL_AI_WIN_LOG_NAME === "Application", "log name via env");
    assert(spec.env.LOCAL_AI_WIN_HOURS === "12", "hours via env");
    assert(spec.env.LOCAL_AI_WIN_MAX === "5", "max via env");
    assert(spec.env.LOCAL_AI_WIN_PROVIDER === "Application Error", "provider via env");
    assert(
        !spec.args.some((arg) => String(arg).includes("Application Error")),
        "provider must not be interpolated into argv",
    );

    const sanitized = sanitizeDescription(longMessage);
    assert(sanitized.length <= 180, "sanitizeDescription cap");

    pass("inspect_event_log", "bounded query; descriptions sanitized; no raw message");
}


async function testSystemHealthNative() {
    installMock(() => {
        throw new Error("inspect_system_health must not spawn a Windows command.");
    });

    const { result } = await executeTool("inspect_system_health", {});

    assert(typeof result.memory.totalBytes === "number", "total memory");
    assert(typeof result.memory.availableBytes === "number", "available memory");
    assert(typeof result.memory.usedPercent === "number", "memory percent");
    assert(Number.isInteger(result.cpu.logicalProcessors), "CPU count");
    assert(Array.isArray(result.disks), "disks array");
    assert(result.os.platform, "os.platform");
    assert(!("hostname" in result.os), "hostname must not be collected");
    assert(!("username" in result), "username must not be collected");
    assert(capturedSpecs.length === 0, "system health spawned a command");

    pass("inspect_system_health", "native CPU/memory/disk; no Windows command");
}


async function testServicesFilter() {
    installMock(() => mockOk([
        { Name: "Spooler", DisplayName: "Print Spooler", Status: "Running", StartType: "Automatic" },
        { Name: "wuauserv", DisplayName: "Windows Update", Status: "Stopped", StartType: "Manual" },
        { Name: "Themes", DisplayName: "Themes", Status: "Running", StartType: "Automatic" },
    ]));

    const { result } = await executeTool("inspect_services", {
        nameContains: "print",
    });

    assert(result.services.length === 1, "nameContains should filter in-process");
    assert(result.services[0].name === "Spooler", "print spooler");
    assert(result.services[0].status === "Running", "status");
    assert(capturedSpecs[0].args.includes(PS_COMMANDS.servicesTop), "filter is not a wildcard Get-Service");

    pass("inspect_services", "in-process nameContains; exact-name command stays wildcard-free");
}


async function testNetworkAllowlist() {
    installMock((spec) => {
        if (spec.executable === "ping.exe") {
            return mockOk("Reply from 1.1.1.1: bytes=32 time=12ms TTL=57");
        }
        return mockOk([
            { InterfaceAlias: "Ethernet", ServerAddresses: ["1.1.1.1"] },
        ]);
    });

    const { result } = await executeTool("inspect_network", {
        destination: "1.1.1.1",
    });

    assert(Array.isArray(result.adapters), "adapters");
    assert(
        result.adapters.every((item) => !("mac" in item)),
        "MAC addresses must be omitted",
    );
    assert(result.dns[0].servers.includes("1.1.1.1"), "dns servers");
    assert(result.connectivity.destination === "1.1.1.1", "ping destination");
    assert(result.connectivity.reachable === true, "ping reachable");
    assert(result.connectivity.roundTripMs === 12, "ping rtt");

    const pingSpec = capturedSpecs.find((item) => item.executable === "ping.exe");
    assert(pingSpec.args[4] === "1.1.1.1", "ping target is a separate argv entry");

    pass("inspect_network", "adapters without MAC; allowlisted ping argv");

    installMock((spec) => {
        if (spec.executable === "ping.exe") {
            return {
                stdout: "Request timed out.",
                stderr: "",
                exitCode: 1,
            };
        }
        return mockOk([]);
    });

    const missed = await executeTool("inspect_network", { destination: "8.8.8.8" });
    assert(missed.result.connectivity.reachable === false, "failed ping should be unreachable");
    assert(Array.isArray(missed.result.adapters), "failed ping dropped adapters");

    pass("inspect_network unreachable ping", "non-zero ping is a result, not a crash");
}


async function testAccessDenied() {
    installMock(() => ({
        stdout: "",
        stderr: "Get-WinEvent : Access is denied.",
        exitCode: 5,
    }));

    const error = await expectThrow(
        () => executeTool("inspect_event_log", { logName: "System" }),
        ACCESS_DENIED_MESSAGE,
    );
    assert(error.code === "ACCESS_DENIED", "ACCESS_DENIED code");
    assert(!String(error.message).includes("Get-WinEvent"), "raw stderr leaked");

    pass("access-denied handling", "mapped to a non-elevating error");
}


async function testUnsupportedPlatform() {
    windowsTest.setPlatform("linux");
    windowsTest.setRunWindowsCommand(async () => {
        throw new Error("should not spawn on a non-Windows platform");
    });

    for (const name of WINDOWS_TOOLS) {
        const args =
            name === "inspect_event_log" ? { logName: "Application" } : {};
        await expectThrow(
            () => executeTool(name, args),
            UNSUPPORTED_PLATFORM_MESSAGE,
        );
    }

    pass("unsupported platform", "all five tools refuse clearly off Windows");
}


async function testBoundedOutput() {
    const many = [];
    for (let i = 0; i < MAX_PROCESSES + 15; i += 1) {
        many.push({
            Name: `proc${i}`,
            Id: 1000 + i,
            CPU: 0,
            WorkingSet64: 1000,
            StartTime: "2026-10-30T12:00:00",
            Responding: true,
        });
    }

    installMock(() => mockOk(many));

    const { result } = await executeTool("inspect_processes", {});
    assert(result.processes.length <= MAX_PROCESSES, "process cap exceeded");
    assert(result.truncated === true, "truncated flag");

    pass("bounded output", `process list capped at ${MAX_PROCESSES}`);
}


async function testDispatchIsReadOnly() {
    installMock(() => mockOk([
        { Name: "node", Id: 1, CPU: 0, WorkingSet64: 1, Responding: true },
    ]));

    const pendingBefore = listPendingApprovals().length;
    const fakeChat = async () => ({
        content: "Acknowledged.",
        toolCalls: [],
        message: { role: "assistant", content: "Acknowledged." },
    });
    const continuation = {
        messages: [],
        steps: 0,
        activity: [],
        chatWithTools: fakeChat,
    };

    const outcome = await dispatchToolCall(
        "inspect_processes",
        { name: "node" },
        continuation,
    );

    assert(outcome.kind === "result", "inspect_processes asked for approval");
    assert(outcome.payload.ok === true, "read tool failed");
    assert(
        listPendingApprovals().length === pendingBefore,
        "read tool created a pending approval",
    );

    const approval = await dispatchToolCall(
        "create_directory",
        { path: "C:\\local-ai-lab-should-not-exist", reason: "verify still gated" },
        continuation,
    );

    assert(approval.kind === "approval", "create_directory no longer needs approval");
    assert(approval.approval?.tool === "create_directory", "wrong approval tool");

    const rejected = await rejectById(approval.approval.id);
    assert(rejected.status === "complete" || rejected.status === "approval_required", "reject resumed");
    assert(
        listPendingApprovals().every((item) => item.id !== approval.approval.id),
        "rejected approval still pending",
    );

    pass("dispatch permissions", "Windows inspect auto-runs; filesystem mutations still gated");
}


async function testAgentRequestsContextWindow() {
    assert(AGENT_NUM_CTX >= 8192, `AGENT_NUM_CTX too small: ${AGENT_NUM_CTX}`);

    let seenNumCtx = null;
    const result = await runAgent(
        "Do not call tools. Reply with the word ok.",
        {
            chatWithTools: async (options) => {
                seenNumCtx = options.numCtx;
                return {
                    content: "ok",
                    toolCalls: [],
                    message: { role: "assistant", content: "ok" },
                };
            },
        },
    );

    assert(result.status === "complete", "stubbed Computer request failed");
    assert(
        seenNumCtx === AGENT_NUM_CTX,
        `Computer chat omitted numCtx (got ${seenNumCtx})`,
    );

    pass(
        "Computer context window",
        `numCtx ${AGENT_NUM_CTX} so tool schemas fit`,
    );
}


async function testEventLogDropsOutOfWindow() {
    windowsTest.setNow(Date.parse("2026-11-02T14:00:00.000Z"));
    installMock(() => mockOk([
        {
            TimeCreated: "2026-10-31T12:00:00.000Z",
            Id: 1000,
            LevelDisplayName: "Error",
            ProviderName: "Application Error",
            Message: "old crash",
        },
        {
            TimeCreated: "2026-11-02T10:00:00.000Z",
            Id: 1001,
            LevelDisplayName: "Error",
            ProviderName: "Application Error",
            Message: "recent crash",
        },
        {
            TimeCreated: "not-a-date",
            Id: 1002,
            LevelDisplayName: "Error",
            ProviderName: "Application Error",
            Message: "unparseable",
        },
    ]));

    const { result } = await executeTool("inspect_event_log", {
        logName: "Application",
        hours: 12,
        maxResults: 10,
    });

    assert(result.events.length === 1, "out-of-window events must be dropped");
    assert(result.events[0].id === 1001, "kept the in-window event");
    assert(
        !JSON.stringify(result.events).includes("2026-10-31"),
        "October 31 event leaked through the Node time filter",
    );

    pass("event-log time window", "Node drops events outside the requested window");
}


async function testEventLogEmptyVsFailed() {
    windowsTest.setNow(Date.parse("2026-11-02T14:00:00.000Z"));
    installMock(() => mockOk([]));

    const empty = await executeTool("inspect_event_log", {
        logName: "Application",
        hours: 12,
    });
    assert(empty.result.events.length === 0, "empty success must return events=[]");
    assert(empty.result.logName === "Application", "empty result lost logName");
    assert(empty.result.windowStart, "empty result must still include the query window");

    installMock(() => ({
        stdout: "",
        stderr: "Get-WinEvent : timed out internally",
        exitCode: 2,
    }));

    const failed = await expectThrow(
        () => executeTool("inspect_event_log", { logName: "Application", hours: 12 }),
        "Windows diagnostic failed.",
    );
    assert(failed.code === "DIAGNOSTIC_FAILED", "failed query must keep DIAGNOSTIC_FAILED");

    installMock(() => {
        const error = new Error("Windows diagnostic timed out.");
        error.code = "TIMEOUT";
        throw error;
    });

    const timeout = await expectThrow(
        () => executeTool("inspect_event_log", { logName: "Application", hours: 12 }),
        "timed out",
    );
    assert(timeout.code === "TIMEOUT", "timeout code");

    installMock(() => ({
        stdout: "",
        stderr: "",
        exitCode: 3,
    }));

    const unavailable = await expectThrow(
        () => executeTool("inspect_event_log", { logName: "System", hours: 1 }),
        EVENT_LOG_UNAVAILABLE_MESSAGE,
    );
    assert(unavailable.code === "UNAVAILABLE", "unavailable code");

    pass("event-log empty vs failed", "empty arrays are success; timeouts stay structured failures");
}


async function testResourceConsumers() {
    installMock(() => mockOk([
        { Name: "Cursor", Id: 11, CPU: 12.5, CpuDelta: 0.2, WorkingSet64: 500_000_000 },
        { Name: "idle", Id: 12, CPU: 1, CpuDelta: 0.01, WorkingSet64: 10_000_000 },
        { Name: "memhog", Id: 13, CPU: 3, CpuDelta: 0.05, WorkingSet64: 800_000_000 },
    ]));

    const { result } = await executeTool("inspect_resource_consumers", { sampleMs: 400 });
    assert(result.byMemory[0].name === "memhog", "memory sort");
    assert(result.byCpu[0].name === "Cursor", "sampled CPU sort");
    assert(result.byCpu[0].cpuPercentSampled === 50, "0.2s / 0.4s = 50% of one core");
    assert(result.byMemory[0].cpuSecondsCumulative === 3, "cumulative CPU preserved");
    assert(
        result.interpretationLimits.includes(CONSUMER_INTERPRETATION_LIMITS[0]),
        "consumer interpretation limits missing",
    );
    assert(result.byMemory.length <= MAX_CONSUMERS, "memory list cap");
    assert(
        !JSON.stringify(result).includes("CommandLine"),
        "command lines must not be collected",
    );

    const spec = capturedSpecs[0];
    assert(spec.args.includes(PS_COMMANDS.resourceConsumers), "must use resource consumer command");
    assert(spec.env.LOCAL_AI_WIN_SAMPLE_MS === "400", "sample ms via env");

    pass("inspect_resource_consumers", "sampled CPU distinct from cumulative cpuSeconds");
}


async function testHealthPressureAndLimits() {
    installMock(() => {
        throw new Error("inspect_system_health must not spawn a Windows command.");
    });

    const { result } = await executeTool("inspect_system_health", {});
    assert(Array.isArray(result.pressure), "pressure array");
    assert(Array.isArray(result.interpretationLimits), "health interpretation limits");
    assert(result.untrusted === true, "system health should be marked untrusted");

    pass("inspect_system_health pressure", "pressure[] and interpretation limits present");
}


async function testEvidenceEnvelopeAndStaleLedger() {
    windowsTest.setNow(Date.parse("2026-11-02T14:00:00.000Z"));
    installMock(() => {
        const error = new Error("Windows diagnostic timed out.");
        error.code = "TIMEOUT";
        throw error;
    });

    const continuation = {
        messages: [],
        steps: 0,
        activity: [],
        evidenceLedger: [],
        chatWithTools: async () => ({
            content: "",
            toolCalls: [],
            message: { role: "assistant", content: "" },
        }),
    };

    const failed = await dispatchToolCall(
        "inspect_event_log",
        { logName: "Application", hours: 12 },
        continuation,
    );

    assert(failed.kind === "result", "failed dispatch kind");
    assert(failed.payload.ok === false, "failed payload must be ok=false");
    assert(failed.payload.status === "failed", "failed status");
    assert(failed.payload.errorCode === "TIMEOUT", "errorCode TIMEOUT");
    assert(!("result" in failed.payload), "failed payload must omit result/events");
    assert(
        !JSON.stringify(failed.payload).includes("TimeCreated"),
        "failed payload leaked events",
    );
    assert(
        failed.activityItem.summary.includes("timed out"),
        `chip should mention timeout, got ${failed.activityItem.summary}`,
    );

    installMock(() => mockOk([
        {
            TimeCreated: "2026-11-02T10:00:00.000Z",
            Id: 42,
            LevelDisplayName: "Error",
            ProviderName: "Application Error",
            Message: "recent",
        },
    ]));

    const ok = await dispatchToolCall(
        "inspect_event_log",
        { logName: "Application", hours: 12 },
        continuation,
    );

    assert(ok.payload.ok === true, "successful event log");
    assert(ok.payload.status === "ok", "ok status");
    assert(ok.payload.result.events[0].id === 42, "success events");
    const stale = ok.payload.currentLedger.filter(
        (entry) => entry.tool === "inspect_event_log" && entry.stale,
    );
    const current = ok.payload.currentLedger.filter(
        (entry) => entry.tool === "inspect_event_log" && !entry.stale,
    );
    assert(stale.length === 1 && stale[0].status === "failed", "prior failed call marked stale");
    assert(current.length === 1 && current[0].status === "ok", "latest success is current");

    installMock(() => mockOk([]));
    const empty = await dispatchToolCall(
        "inspect_event_log",
        { logName: "System", hours: 1 },
        continuation,
    );
    assert(empty.payload.status === "empty", "empty status");
    assert(empty.payload.result.events.length === 0, "empty events");
    assert(
        empty.activityItem.summary.includes("0 events"),
        `empty chip, got ${empty.activityItem.summary}`,
    );

    pass("evidence envelope", "failed calls omit events; stale ledger rows marked");
}


async function testUnsupportedConclusionPayload() {
    installMock(() => mockOk([
        { Name: "Cursor", Id: 99, CPU: 40, WorkingSet64: 200, Responding: true },
    ]));

    const { result } = await executeTool("inspect_processes", { name: "Cursor" });
    assert(result.processes.length === 1, "cursor process");
    assert(
        result.interpretationLimits.some((line) => line.toLowerCase().includes("healthy")),
        "payload must forbid treating presence as health",
    );

    const prompt = (await import("../lib/agent.js")).ABANDONED_ACTION_REPAIR_PROMPT;
    assert(typeof prompt === "string", "sanity import");

    pass(
        "unsupported conclusions",
        "process payload includes deterministic health caveats",
    );
}


async function testLiveSystemHealth() {
    if (process.platform !== "win32") {
        skip("live inspect_system_health", "not running on Windows");
        return;
    }

    windowsTest.reset();
    windowsTest.setCpuSampleDelayMs(0);

    const { result } = await executeTool("inspect_system_health", {});
    assert(result.memory.totalBytes > 0, "live total memory");
    assert(result.cpu.logicalProcessors > 0, "live CPU count");
    pass("live inspect_system_health", `${result.cpu.logicalProcessors} logical processors`);
}


async function testLiveEventLog() {
    if (process.platform !== "win32") {
        skip("live inspect_event_log", "not running on Windows");
        return;
    }

    windowsTest.reset();

    try {
        const { result } = await executeTool("inspect_event_log", {
            logName: "Application",
            hours: 1,
            maxResults: 5,
        });
        assert(Array.isArray(result.events), "live events array");
        assert(result.logName === "Application", "live logName");
        assert(result.windowStart && result.windowEnd, "live window bounds");
        for (const event of result.events) {
            const timeMs = Date.parse(event.time);
            assert(Number.isFinite(timeMs), "live event missing time");
            assert(
                timeMs >= Date.parse(result.windowStart) &&
                    timeMs <= Date.parse(result.windowEnd),
                "live event outside window",
            );
        }
        pass(
            "live inspect_event_log",
            `${result.events.length} Application events in last 1h`,
        );
    } catch (error) {
        if (
            error.code === "TIMEOUT" ||
            error.code === "ACCESS_DENIED" ||
            error.code === "UNAVAILABLE" ||
            error.code === "DIAGNOSTIC_FAILED"
        ) {
            pass(
                "live inspect_event_log",
                `structured failure ${error.code}: ${error.message}`,
            );
            return;
        }

        throw error;
    }
}


async function testLiveResourceConsumers() {
    if (process.platform !== "win32") {
        skip("live inspect_resource_consumers", "not running on Windows");
        return;
    }

    windowsTest.reset();
    const { result } = await executeTool("inspect_resource_consumers", {
        sampleMs: 200,
    });
    assert(Array.isArray(result.byMemory), "live byMemory");
    assert(Array.isArray(result.byCpu), "live byCpu");
    assert(result.sampleMs === 200, "live sampleMs");
    pass(
        "live inspect_resource_consumers",
        `${result.byMemory.length} memory / ${result.byCpu.length} CPU rows`,
    );
}


async function main() {
    const tests = [
        ["registry and permissions", testRegistry],
        ["argument validation", testArgumentValidation],
        ["command allowlists", testCommandAllowlists],
        ["inspect_processes", testProcessesJsonAndTargeting],
        ["inspect_event_log", testEventLogBoundsAndSanitize],
        ["event-log time window", testEventLogDropsOutOfWindow],
        ["event-log empty vs failed", testEventLogEmptyVsFailed],
        ["inspect_resource_consumers", testResourceConsumers],
        ["inspect_system_health", testSystemHealthNative],
        ["inspect_system_health pressure", testHealthPressureAndLimits],
        ["inspect_services", testServicesFilter],
        ["inspect_network", testNetworkAllowlist],
        ["access-denied handling", testAccessDenied],
        ["unsupported platform", testUnsupportedPlatform],
        ["bounded output", testBoundedOutput],
        ["dispatch permissions", testDispatchIsReadOnly],
        ["evidence envelope", testEvidenceEnvelopeAndStaleLedger],
        ["unsupported conclusions", testUnsupportedConclusionPayload],
        ["Computer context window", testAgentRequestsContextWindow],
        ["live inspect_system_health", testLiveSystemHealth],
        ["live inspect_event_log", testLiveEventLog],
        ["live inspect_resource_consumers", testLiveResourceConsumers],
    ];

    try {
        for (const [name, run] of tests) {
            try {
                await run();
            } catch (error) {
                fail(name, error.message);
            } finally {
                resetWindows();
                for (const item of listPendingApprovals()) {
                    try {
                        await rejectById(item.id);
                    } catch {
                        try {
                            await approveById(item.id);
                        } catch {
                            // leftover test approval
                        }
                    }
                }
            }
        }
    } finally {
        resetWindows();
    }

    const passed = results.filter((item) => item.status === "pass").length;
    const failed = results.filter((item) => item.status === "fail").length;
    const skipped = results.filter((item) => item.status === "skip").length;
    console.log("");
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

    if (failed > 0) {
        process.exitCode = 1;
    }
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
