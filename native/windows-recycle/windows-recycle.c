/*
 * Local AI Lab — pinned Windows Recycle Bin helper (Milestone D2).
 *
 * Single-purpose: recycle OR restore one absolute file path via IFileOperation.
 * Never permanently deletes. Never elevates. Never accepts path lists from argv
 * for bulk deletion — one path via LOCAL_AI_RECYCLE_PATH (or restore pair).
 *
 * Provenance: built from repository source only. Node verifies the exe SHA-256
 * against the pinned build manifest before launch.
 *
 * Compile (x64):
 *   cl /nologo /O2 /W3 /DUNICODE /D_UNICODE windows-recycle.c ole32.lib shell32.lib shlwapi.lib user32.lib /Fe:windows-recycle.exe
 */

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define INITGUID

#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <strsafe.h>
#include <stdio.h>
#include <stdint.h>

#ifndef FOF_SILENT
#define FOF_SILENT 0x0004
#endif
#ifndef FOF_NOCONFIRMATION
#define FOF_NOCONFIRMATION 0x0010
#endif
#ifndef FOF_NOERRORUI
#define FOF_NOERRORUI 0x0400
#endif
#ifndef FOFX_RECYCLEONDELETE
#define FOFX_RECYCLEONDELETE 0x00080000
#endif
#ifndef FOFX_ADDUNDORECORD
#define FOFX_ADDUNDORECORD 0x20000000
#endif
#ifndef FOFX_EARLYFAILURE
#define FOFX_EARLYFAILURE 0x00100000
#endif

/* Transfer source flags used by PreDeleteItem (shobjidl_core.h /
 * _TRANSFER_SOURCE_FLAGS). Prefer SDK values from shobjidl.h when present.
 * TSF_NO_SECURITY is 0x8 — do NOT confuse with recycle-if-possible (0x80). */
#ifndef TSF_NO_SECURITY
#define TSF_NO_SECURITY 0x00000008
#endif
#ifndef TSF_DELETE_RECYCLE_IF_POSSIBLE
#define TSF_DELETE_RECYCLE_IF_POSSIBLE 0x00000080
#endif

/* Fail closed at compile time if constants drift (same class of bug as the
 * historical 0x08/0x80 mix-up that allowed permanent deletion). */
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(
    TSF_DELETE_RECYCLE_IF_POSSIBLE == 0x00000080,
    "TSF_DELETE_RECYCLE_IF_POSSIBLE must be 0x80"
);
_Static_assert(
    TSF_NO_SECURITY == 0x00000008,
    "TSF_NO_SECURITY must be 0x8"
);
#elif defined(_MSC_VER)
C_ASSERT(TSF_DELETE_RECYCLE_IF_POSSIBLE == 0x00000080);
C_ASSERT(TSF_NO_SECURITY == 0x00000008);
#endif

#define HELPER_VERSION "local-ai-lab-windows-recycle/1.0.0"
#define MAX_JSON 4096

typedef struct RecycleSink {
    IFileOperationProgressSinkVtbl *lpVtbl;
    LONG ref;
    BOOL recyclePossible;
    BOOL preDeleteSeen;
    BOOL postDeleteSeen;
    HRESULT hrDelete;
    BOOL newlyCreatedPresent;
    WCHAR recycleParsingName[MAX_PATH * 2];
    WCHAR errorDetail[512];
} RecycleSink;

static void json_escape(const WCHAR *src, char *dst, size_t dstSize) {
    size_t o = 0;
    if (!src) {
        dst[0] = '\0';
        return;
    }
    for (size_t i = 0; src[i] && o + 2 < dstSize; i++) {
        unsigned int c = (unsigned int)src[i];
        if (c == '"' || c == '\\') {
            if (o + 3 >= dstSize) break;
            dst[o++] = '\\';
            dst[o++] = (char)c;
        } else if (c < 0x20 || c > 0x7E) {
            if (o + 7 >= dstSize) break;
            o += (size_t)sprintf_s(dst + o, dstSize - o, "\\u%04x", c & 0xFFFF);
        } else {
            dst[o++] = (char)c;
        }
    }
    dst[o] = '\0';
}

static void emit_json(
    const char *outcome,
    BOOL recycled,
    BOOL permanentlyRemoved,
    BOOL aborted,
    int hr,
    const WCHAR *detail,
    const WCHAR *recyclePath,
    const WCHAR *path
) {
    char detailUtf8[1024];
    char recycleUtf8[1024];
    char pathUtf8[1024];
    json_escape(detail, detailUtf8, sizeof(detailUtf8));
    json_escape(recyclePath, recycleUtf8, sizeof(recycleUtf8));
    json_escape(path, pathUtf8, sizeof(pathUtf8));
    printf(
        "{\"helperVersion\":\"%s\",\"outcome\":\"%s\",\"recycled\":%s,"
        "\"permanentlyRemoved\":%s,\"aborted\":%s,\"hr\":%d,"
        "\"detail\":\"%s\",\"recyclePath\":\"%s\",\"path\":\"%s\"}\n",
        HELPER_VERSION,
        outcome,
        recycled ? "true" : "false",
        permanentlyRemoved ? "true" : "false",
        aborted ? "true" : "false",
        hr,
        detailUtf8,
        recycleUtf8,
        pathUtf8
    );
    fflush(stdout);
}

/* --- IFileOperationProgressSink --- */

static HRESULT STDMETHODCALLTYPE Sink_QueryInterface(
    IFileOperationProgressSink *This, REFIID riid, void **ppv
) {
    RecycleSink *sink = (RecycleSink *)This;
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &IID_IFileOperationProgressSink)) {
        *ppv = This;
        InterlockedIncrement(&sink->ref);
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE Sink_AddRef(IFileOperationProgressSink *This) {
    RecycleSink *sink = (RecycleSink *)This;
    return (ULONG)InterlockedIncrement(&sink->ref);
}

static ULONG STDMETHODCALLTYPE Sink_Release(IFileOperationProgressSink *This) {
    RecycleSink *sink = (RecycleSink *)This;
    LONG ref = InterlockedDecrement(&sink->ref);
    if (ref == 0) {
        free(sink);
    }
    return (ULONG)ref;
}

static HRESULT STDMETHODCALLTYPE Sink_StartOperations(IFileOperationProgressSink *This) {
    (void)This;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_FinishOperations(
    IFileOperationProgressSink *This, HRESULT hrResult
) {
    (void)This;
    (void)hrResult;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PreRenameItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem,
    LPCWSTR pszNewName
) {
    (void)This; (void)dwFlags; (void)psiItem; (void)pszNewName;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PostRenameItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem,
    LPCWSTR pszNewName, HRESULT hrRename, IShellItem *psiNewlyCreated
) {
    (void)This; (void)dwFlags; (void)psiItem; (void)pszNewName;
    (void)hrRename; (void)psiNewlyCreated;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PreMoveItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem,
    IShellItem *psiDestinationFolder, LPCWSTR pszNewName
) {
    (void)This; (void)dwFlags; (void)psiItem; (void)psiDestinationFolder;
    (void)pszNewName;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PostMoveItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem,
    IShellItem *psiDestinationFolder, LPCWSTR pszNewName, HRESULT hrMove,
    IShellItem *psiNewlyCreated
) {
    (void)This; (void)dwFlags; (void)psiItem; (void)psiDestinationFolder;
    (void)pszNewName; (void)hrMove; (void)psiNewlyCreated;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PreCopyItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem,
    IShellItem *psiDestinationFolder, LPCWSTR pszNewName
) {
    (void)This; (void)dwFlags; (void)psiItem; (void)psiDestinationFolder;
    (void)pszNewName;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PostCopyItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem,
    IShellItem *psiDestinationFolder, LPCWSTR pszNewName, HRESULT hrCopy,
    IShellItem *psiNewlyCreated
) {
    (void)This; (void)dwFlags; (void)psiItem; (void)psiDestinationFolder;
    (void)pszNewName; (void)hrCopy; (void)psiNewlyCreated;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PreDeleteItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem
) {
    RecycleSink *sink = (RecycleSink *)This;
    (void)psiItem;
    sink->preDeleteSeen = TRUE;
    if (!(dwFlags & TSF_DELETE_RECYCLE_IF_POSSIBLE)) {
        sink->recyclePossible = FALSE;
        StringCchCopyW(
            sink->errorDetail,
            ARRAYSIZE(sink->errorDetail),
            L"PreDeleteItem: recycle not possible for this item; aborting to avoid permanent deletion."
        );
        return E_ABORT;
    }
    sink->recyclePossible = TRUE;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PostDeleteItem(
    IFileOperationProgressSink *This, DWORD dwFlags, IShellItem *psiItem,
    HRESULT hrDelete, IShellItem *psiNewlyCreated
) {
    RecycleSink *sink = (RecycleSink *)This;
    (void)dwFlags;
    (void)psiItem;
    sink->postDeleteSeen = TRUE;
    sink->hrDelete = hrDelete;
    sink->newlyCreatedPresent = (psiNewlyCreated != NULL);

    if (psiNewlyCreated) {
        PWSTR name = NULL;
        if (SUCCEEDED(IShellItem_GetDisplayName(
                psiNewlyCreated, SIGDN_DESKTOPABSOLUTEPARSING, &name
            )) && name) {
            StringCchCopyW(
                sink->recycleParsingName,
                ARRAYSIZE(sink->recycleParsingName),
                name
            );
            CoTaskMemFree(name);
        }
    } else {
        StringCchCopyW(
            sink->errorDetail,
            ARRAYSIZE(sink->errorDetail),
            L"PostDeleteItem: psiNewlyCreated is null (item was fully deleted, not recycled)."
        );
    }
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PreNewItem(
    IFileOperationProgressSink *This, DWORD dwFlags,
    IShellItem *psiDestinationFolder, LPCWSTR pszNewName
) {
    (void)This; (void)dwFlags; (void)psiDestinationFolder; (void)pszNewName;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PostNewItem(
    IFileOperationProgressSink *This, DWORD dwFlags,
    IShellItem *psiDestinationFolder, LPCWSTR pszNewName, LPCWSTR pszTemplateName,
    DWORD dwFileAttributes, HRESULT hrNew, IShellItem *psiNewItem
) {
    (void)This; (void)dwFlags; (void)psiDestinationFolder; (void)pszNewName;
    (void)pszTemplateName; (void)dwFileAttributes; (void)hrNew; (void)psiNewItem;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_UpdateProgress(
    IFileOperationProgressSink *This, UINT iWorkTotal, UINT iWorkSoFar
) {
    (void)This; (void)iWorkTotal; (void)iWorkSoFar;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_ResetTimer(IFileOperationProgressSink *This) {
    (void)This;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_PauseTimer(IFileOperationProgressSink *This) {
    (void)This;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Sink_ResumeTimer(IFileOperationProgressSink *This) {
    (void)This;
    return S_OK;
}

static IFileOperationProgressSinkVtbl g_sinkVtbl = {
    Sink_QueryInterface,
    Sink_AddRef,
    Sink_Release,
    Sink_StartOperations,
    Sink_FinishOperations,
    Sink_PreRenameItem,
    Sink_PostRenameItem,
    Sink_PreMoveItem,
    Sink_PostMoveItem,
    Sink_PreCopyItem,
    Sink_PostCopyItem,
    Sink_PreDeleteItem,
    Sink_PostDeleteItem,
    Sink_PreNewItem,
    Sink_PostNewItem,
    Sink_UpdateProgress,
    Sink_ResetTimer,
    Sink_PauseTimer,
    Sink_ResumeTimer,
};

static RecycleSink *create_sink(void) {
    RecycleSink *sink = (RecycleSink *)calloc(1, sizeof(RecycleSink));
    if (!sink) return NULL;
    sink->lpVtbl = &g_sinkVtbl;
    sink->ref = 1;
    sink->hrDelete = E_FAIL;
    return sink;
}

static BOOL path_is_reparse(const WCHAR *path) {
    DWORD attrs = GetFileAttributesW(path);
    if (attrs == INVALID_FILE_ATTRIBUTES) return FALSE;
    return (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

static BOOL validate_regular_file(const WCHAR *path, WCHAR *err, size_t errChars) {
    WIN32_FILE_ATTRIBUTE_DATA data;
    DWORD attrs;

    if (!path || !path[0]) {
        StringCchCopyW(err, errChars, L"Empty path.");
        return FALSE;
    }
    if (wcschr(path, L'/') && path[1] != L'\\') {
        /* Allow normal Windows paths; reject obvious oddities later via GetFileAttributes. */
    }

    attrs = GetFileAttributesW(path);
    if (attrs == INVALID_FILE_ATTRIBUTES) {
        StringCchPrintfW(err, errChars, L"GetFileAttributes failed (%lu).", GetLastError());
        return FALSE;
    }
    if (attrs & FILE_ATTRIBUTE_DIRECTORY) {
        StringCchCopyW(err, errChars, L"Target is a directory.");
        return FALSE;
    }
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) {
        StringCchCopyW(err, errChars, L"Target is a reparse point.");
        return FALSE;
    }
    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &data)) {
        StringCchPrintfW(err, errChars, L"GetFileAttributesEx failed (%lu).", GetLastError());
        return FALSE;
    }
    if (data.nFileSizeHigh != 0) {
        /* Still allow large files; identity check uses low/high when provided. */
    }
    return TRUE;
}

static BOOL identity_matches(const WCHAR *path, WCHAR *err, size_t errChars) {
    WCHAR sizeEnv[64];
    WCHAR mtimeEnv[64];
    WIN32_FILE_ATTRIBUTE_DATA data;
    ULARGE_INTEGER size;
    ULARGE_INTEGER mtime;
    ULONGLONG expectSize = 0;
    ULONGLONG expectMtime = 0;
    BOOL checkSize = FALSE;
    BOOL checkMtime = FALSE;

    DWORD n = GetEnvironmentVariableW(L"LOCAL_AI_RECYCLE_EXPECT_SIZE", sizeEnv, ARRAYSIZE(sizeEnv));
    if (n > 0 && n < ARRAYSIZE(sizeEnv)) {
        expectSize = _wcstoui64(sizeEnv, NULL, 10);
        checkSize = TRUE;
    }
    n = GetEnvironmentVariableW(L"LOCAL_AI_RECYCLE_EXPECT_MTIME_MS", mtimeEnv, ARRAYSIZE(mtimeEnv));
    if (n > 0 && n < ARRAYSIZE(mtimeEnv)) {
        expectMtime = _wcstoui64(mtimeEnv, NULL, 10);
        checkMtime = TRUE;
    }

    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &data)) {
        StringCchPrintfW(err, errChars, L"Identity stat failed (%lu).", GetLastError());
        return FALSE;
    }

    size.HighPart = data.nFileSizeHigh;
    size.LowPart = data.nFileSizeLow;
    /* FILETIME is 100ns since 1601; convert to unix ms approximately for compare when provided. */
    mtime.HighPart = data.ftLastWriteTime.dwHighDateTime;
    mtime.LowPart = data.ftLastWriteTime.dwLowDateTime;

    if (checkSize && size.QuadPart != expectSize) {
        StringCchCopyW(err, errChars, L"File size changed before recycle.");
        return FALSE;
    }
    if (checkMtime) {
        /* Convert FILETIME to unix epoch ms. */
        ULONGLONG unixMs = (mtime.QuadPart / 10000ULL) - 11644473600000ULL;
        LONGLONG delta = (LONGLONG)unixMs - (LONGLONG)expectMtime;
        if (delta > 2 || delta < -2) {
            StringCchCopyW(err, errChars, L"File mtime changed before recycle.");
            return FALSE;
        }
    }
    return TRUE;
}

static int do_recycle(const WCHAR *path) {
    HRESULT hr;
    IFileOperation *op = NULL;
    IShellItem *item = NULL;
    RecycleSink *sink = NULL;
    BOOL aborted = FALSE;
    WCHAR err[512];
    DWORD flags;

    if (!validate_regular_file(path, err, ARRAYSIZE(err))) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)HRESULT_FROM_WIN32(ERROR_INVALID_DATA), err, NULL, path);
        return 2;
    }
    if (path_is_reparse(path)) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)E_FAIL, L"Reparse point refused.", NULL, path);
        return 2;
    }
    if (!identity_matches(path, err, ARRAYSIZE(err))) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)HRESULT_FROM_WIN32(ERROR_FILE_INVALID), err, NULL, path);
        return 2;
    }

    hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) {
        emit_json("indeterminate", FALSE, FALSE, FALSE, (int)hr, L"CoInitializeEx failed.", NULL, path);
        return 3;
    }

    hr = CoCreateInstance(
        &CLSID_FileOperation, NULL, CLSCTX_ALL, &IID_IFileOperation, (void **)&op
    );
    if (FAILED(hr) || !op) {
        emit_json("indeterminate", FALSE, FALSE, FALSE, (int)hr, L"CoCreateInstance(IFileOperation) failed.", NULL, path);
        CoUninitialize();
        return 3;
    }

    flags = FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD | FOF_NOERRORUI |
            FOF_NOCONFIRMATION | FOF_SILENT | FOFX_EARLYFAILURE;
    hr = IFileOperation_SetOperationFlags(op, flags);
    if (FAILED(hr)) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)hr, L"SetOperationFlags failed.", NULL, path);
        IFileOperation_Release(op);
        CoUninitialize();
        return 2;
    }

    hr = SHCreateItemFromParsingName(path, NULL, &IID_IShellItem, (void **)&item);
    if (FAILED(hr) || !item) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)hr, L"SHCreateItemFromParsingName failed.", NULL, path);
        IFileOperation_Release(op);
        CoUninitialize();
        return 2;
    }

    sink = create_sink();
    if (!sink) {
        emit_json("indeterminate", FALSE, FALSE, FALSE, (int)E_OUTOFMEMORY, L"Out of memory.", NULL, path);
        IShellItem_Release(item);
        IFileOperation_Release(op);
        CoUninitialize();
        return 3;
    }

    hr = IFileOperation_DeleteItem(op, item, (IFileOperationProgressSink *)sink);
    if (FAILED(hr)) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)hr, L"DeleteItem enqueue failed.", NULL, path);
        Sink_Release((IFileOperationProgressSink *)sink);
        IShellItem_Release(item);
        IFileOperation_Release(op);
        CoUninitialize();
        return 2;
    }

    hr = IFileOperation_PerformOperations(op);
    IFileOperation_GetAnyOperationsAborted(op, &aborted);

    /*
     * Interpret sink evidence. Never claim recycled without psiNewlyCreated.
     * Permanent-deletion evidence MUST win over aborted: GetAnyOperationsAborted
     * can be true after PostDeleteItem already observed a null psiNewlyCreated.
     */
    if (sink->postDeleteSeen && !sink->newlyCreatedPresent) {
        emit_json(
            "permanently_removed",
            FALSE,
            TRUE,
            aborted ? TRUE : FALSE,
            (int)(FAILED(sink->hrDelete) ? sink->hrDelete : hr),
            sink->errorDetail[0]
                ? sink->errorDetail
                : L"psiNewlyCreated was null; item appears permanently removed.",
            NULL,
            path
        );
        Sink_Release((IFileOperationProgressSink *)sink);
        IShellItem_Release(item);
        IFileOperation_Release(op);
        CoUninitialize();
        return 5;
    }

    if (aborted || hr == HRESULT_FROM_WIN32(ERROR_CANCELLED) || hr == E_ABORT) {
        emit_json(
            "aborted",
            FALSE,
            FALSE,
            TRUE,
            (int)hr,
            sink->errorDetail[0] ? sink->errorDetail : L"Operation aborted.",
            NULL,
            path
        );
        Sink_Release((IFileOperationProgressSink *)sink);
        IShellItem_Release(item);
        IFileOperation_Release(op);
        CoUninitialize();
        return 4;
    }

    if (!sink->postDeleteSeen) {
        emit_json(
            "indeterminate",
            FALSE,
            FALSE,
            FALSE,
            (int)hr,
            L"PostDeleteItem was not observed; cannot prove recycle.",
            NULL,
            path
        );
        Sink_Release((IFileOperationProgressSink *)sink);
        IShellItem_Release(item);
        IFileOperation_Release(op);
        CoUninitialize();
        return 3;
    }

    if (FAILED(sink->hrDelete)) {
        emit_json(
            "failed",
            FALSE,
            FALSE,
            FALSE,
            (int)sink->hrDelete,
            sink->errorDetail[0] ? sink->errorDetail : L"Delete HRESULT failed.",
            NULL,
            path
        );
        Sink_Release((IFileOperationProgressSink *)sink);
        IShellItem_Release(item);
        IFileOperation_Release(op);
        CoUninitialize();
        return 2;
    }

    if (!sink->newlyCreatedPresent || sink->recycleParsingName[0] == L'\0') {
        /* Defense in depth — should already have been caught above. */
        emit_json(
            "permanently_removed",
            FALSE,
            TRUE,
            FALSE,
            (int)sink->hrDelete,
            L"psiNewlyCreated was null or recycle path empty; item appears permanently removed.",
            NULL,
            path
        );
        Sink_Release((IFileOperationProgressSink *)sink);
        IShellItem_Release(item);
        IFileOperation_Release(op);
        CoUninitialize();
        return 5;
    }

    /* Positive recycle evidence. */
    emit_json(
        "recycled",
        TRUE,
        FALSE,
        FALSE,
        (int)sink->hrDelete,
        L"PostDeleteItem provided Recycle Bin item.",
        sink->recycleParsingName,
        path
    );

    Sink_Release((IFileOperationProgressSink *)sink);
    IShellItem_Release(item);
    IFileOperation_Release(op);
    CoUninitialize();
    return 0;
}

static int do_restore(const WCHAR *recyclePath, const WCHAR *destPath) {
    HRESULT hr;
    IFileOperation *op = NULL;
    IShellItem *src = NULL;
    IShellItem *destFolder = NULL;
    WCHAR parent[MAX_PATH * 2];
    WCHAR *slash;
    WCHAR err[512];
    BOOL aborted = FALSE;

    if (!recyclePath || !recyclePath[0] || !destPath || !destPath[0]) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)E_INVALIDARG, L"restore requires recycle and destination paths.", NULL, destPath);
        return 2;
    }

    StringCchCopyW(parent, ARRAYSIZE(parent), destPath);
    slash = wcsrchr(parent, L'\\');
    if (!slash) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)E_INVALIDARG, L"Invalid destination path.", NULL, destPath);
        return 2;
    }
    *slash = L'\0';

    /* Destination must not already exist. */
    if (GetFileAttributesW(destPath) != INVALID_FILE_ATTRIBUTES) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)HRESULT_FROM_WIN32(ERROR_FILE_EXISTS), L"Restore destination already exists.", NULL, destPath);
        return 2;
    }

    hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) {
        emit_json("indeterminate", FALSE, FALSE, FALSE, (int)hr, L"CoInitializeEx failed.", recyclePath, destPath);
        return 3;
    }

    hr = CoCreateInstance(&CLSID_FileOperation, NULL, CLSCTX_ALL, &IID_IFileOperation, (void **)&op);
    if (FAILED(hr) || !op) {
        emit_json("indeterminate", FALSE, FALSE, FALSE, (int)hr, L"CoCreateInstance failed.", recyclePath, destPath);
        CoUninitialize();
        return 3;
    }

    IFileOperation_SetOperationFlags(
        op,
        FOFX_ADDUNDORECORD | FOF_NOERRORUI | FOF_NOCONFIRMATION | FOF_SILENT | FOFX_EARLYFAILURE
    );

    hr = SHCreateItemFromParsingName(recyclePath, NULL, &IID_IShellItem, (void **)&src);
    if (FAILED(hr) || !src) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)hr, L"Cannot open recycle item.", recyclePath, destPath);
        IFileOperation_Release(op);
        CoUninitialize();
        return 2;
    }

    hr = SHCreateItemFromParsingName(parent, NULL, &IID_IShellItem, (void **)&destFolder);
    if (FAILED(hr) || !destFolder) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)hr, L"Cannot open restore parent folder.", recyclePath, destPath);
        IShellItem_Release(src);
        IFileOperation_Release(op);
        CoUninitialize();
        return 2;
    }

    hr = IFileOperation_MoveItem(op, src, destFolder, wcsrchr(destPath, L'\\') + 1, NULL);
    if (FAILED(hr)) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)hr, L"MoveItem enqueue failed.", recyclePath, destPath);
        IShellItem_Release(destFolder);
        IShellItem_Release(src);
        IFileOperation_Release(op);
        CoUninitialize();
        return 2;
    }

    hr = IFileOperation_PerformOperations(op);
    IFileOperation_GetAnyOperationsAborted(op, &aborted);

    IShellItem_Release(destFolder);
    IShellItem_Release(src);
    IFileOperation_Release(op);
    CoUninitialize();

    if (aborted || FAILED(hr)) {
        emit_json(
            aborted ? "aborted" : "failed",
            FALSE,
            FALSE,
            aborted,
            (int)hr,
            L"Restore move failed.",
            recyclePath,
            destPath
        );
        return aborted ? 4 : 2;
    }

    if (GetFileAttributesW(destPath) == INVALID_FILE_ATTRIBUTES) {
        emit_json("indeterminate", FALSE, FALSE, FALSE, (int)E_FAIL, L"Restore reported success but destination missing.", recyclePath, destPath);
        return 3;
    }

    emit_json("restored", FALSE, FALSE, FALSE, (int)S_OK, L"Restored from Recycle Bin.", recyclePath, destPath);
    (void)err;
    return 0;
}

static int do_probe(const WCHAR *path) {
    /*
     * Probe: validate that PreDeleteItem would see recycle-possible by
     * creating a temporary sibling file is NOT done here (side effects).
     * Instead report volume path and whether the path looks like a local
     * absolute file without reparse — Node performs volume-level checks.
     */
    WCHAR err[512];
    if (!validate_regular_file(path, err, ARRAYSIZE(err))) {
        emit_json("unsupported", FALSE, FALSE, FALSE, (int)E_FAIL, err, NULL, path);
        return 2;
    }
    emit_json("probe_ok", FALSE, FALSE, FALSE, (int)S_OK, L"Path looks like a regular local file.", NULL, path);
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    WCHAR path[MAX_PATH * 2];
    WCHAR restoreDest[MAX_PATH * 2];
    WCHAR mode[64];
    DWORD n;

    n = GetEnvironmentVariableW(L"LOCAL_AI_RECYCLE_MODE", mode, ARRAYSIZE(mode));
    if (n == 0 || n >= ARRAYSIZE(mode)) {
        StringCchCopyW(mode, ARRAYSIZE(mode), L"recycle");
    }

    n = GetEnvironmentVariableW(L"LOCAL_AI_RECYCLE_PATH", path, ARRAYSIZE(path));
    if (n == 0 || n >= ARRAYSIZE(path)) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)E_INVALIDARG, L"LOCAL_AI_RECYCLE_PATH missing.", NULL, NULL);
        return 2;
    }

    /* Ignore argv paths for mutation — only env-controlled exact path. */
    (void)argc;
    (void)argv;

    if (_wcsicmp(mode, L"probe") == 0) {
        return do_probe(path);
    }
    if (_wcsicmp(mode, L"restore") == 0) {
        n = GetEnvironmentVariableW(L"LOCAL_AI_RECYCLE_RESTORE_DEST", restoreDest, ARRAYSIZE(restoreDest));
        if (n == 0 || n >= ARRAYSIZE(restoreDest)) {
            emit_json("failed", FALSE, FALSE, FALSE, (int)E_INVALIDARG, L"LOCAL_AI_RECYCLE_RESTORE_DEST missing.", path, NULL);
            return 2;
        }
        return do_restore(path, restoreDest);
    }
    if (_wcsicmp(mode, L"recycle") != 0) {
        emit_json("failed", FALSE, FALSE, FALSE, (int)E_INVALIDARG, L"Unknown LOCAL_AI_RECYCLE_MODE.", NULL, path);
        return 2;
    }

    return do_recycle(path);
}
