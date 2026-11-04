// =========================================================
// scripts/build-windows-recycle.js
//
// Deterministic build of the pinned Recycle Bin helper from
// repository source. Writes windows-recycle.exe + provenance
// manifest (SHA-256 of the exe and source).
// =========================================================


import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = path.join(ROOT, "native", "windows-recycle");
const SOURCE = path.join(NATIVE_DIR, "windows-recycle.c");
const EXE = path.join(NATIVE_DIR, "windows-recycle.exe");
const MANIFEST = path.join(NATIVE_DIR, "windows-recycle.provenance.json");
const HELPER_VERSION = "local-ai-lab-windows-recycle/1.0.0";


async function sha256File(filePath) {
    const buf = await fs.readFile(filePath);
    return createHash("sha256").update(buf).digest("hex");
}


function findVcvars() {
    const vswhere = path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe",
    );
    const found = spawnSync(
        vswhere,
        [
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ],
        { encoding: "utf8", windowsHide: true },
    );
    if (found.status !== 0 || !found.stdout.trim()) {
        return null;
    }
    const install = found.stdout.trim();
    const vcvars = path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
    return vcvars;
}


async function main() {
    if (process.platform !== "win32") {
        console.error("Windows only.");
        process.exitCode = 1;
        return;
    }

    await fs.access(SOURCE);
    const vcvars = findVcvars();
    if (!vcvars) {
        console.error("Visual Studio Build Tools with C++ tools not found.");
        process.exitCode = 2;
        return;
    }

    const bat = path.join(NATIVE_DIR, "_build_helper.cmd");
    const batBody =
        `@echo off\r\n` +
        `call "${vcvars}" || exit /b 1\r\n` +
        `cd /d "${NATIVE_DIR}"\r\n` +
        `cl /nologo /O2 /W3 /DUNICODE /D_UNICODE /Fe:windows-recycle.exe windows-recycle.c ole32.lib shell32.lib shlwapi.lib user32.lib\r\n` +
        `exit /b %ERRORLEVEL%\r\n`;
    await fs.writeFile(bat, batBody, "utf8");

    const built = spawnSync("cmd.exe", ["/d", "/c", bat], {
        encoding: "utf8",
        windowsHide: true,
        cwd: NATIVE_DIR,
    });
    try {
        await fs.unlink(bat);
    } catch {
        // ignore
    }

    if (built.status !== 0) {
        console.error(built.stdout || "");
        console.error(built.stderr || "");
        console.error("Helper build failed.");
        process.exitCode = 3;
        return;
    }

    const sourceHash = await sha256File(SOURCE);
    const exeHash = await sha256File(EXE);
    const provenance = {
        helperVersion: HELPER_VERSION,
        builtAt: new Date().toISOString(),
        sourcePath: "native/windows-recycle/windows-recycle.c",
        sourceSha256: sourceHash,
        exePath: "native/windows-recycle/windows-recycle.exe",
        exeSha256: exeHash,
        toolchain: "msvc-vcvars64",
        notes: [
            "Executable must be launched only from this repository path.",
            "Node verifies exeSha256 before every launch.",
        ],
    };
    await fs.writeFile(MANIFEST, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    console.log(`Built ${EXE}`);
    console.log(`exeSha256=${exeHash}`);
    console.log(`Wrote ${MANIFEST}`);
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
