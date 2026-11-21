#include <windows.h>
#include <shobjidl.h>
#include <wrl/client.h>
#include <cstdio>
#include <cwchar>
#include <memory>

using Microsoft::WRL::ComPtr;

struct Failure {
    const char* operation;
    HRESULT result;
};

static void check(HRESULT result, const char* operation) {
    if (FAILED(result)) throw Failure{operation, result};
}

static void selectDirectory(int argc, wchar_t** argv) {
    ComPtr<IFileOpenDialog> dialog;
    check(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                           IID_PPV_ARGS(&dialog)), "CoCreateInstance");
    FILEOPENDIALOGOPTIONS options;
    check(dialog->GetOptions(&options), "GetOptions");
    check(dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST |
                             FOS_NOCHANGEDIR | FOS_DONTADDTORECENT), "SetOptions");
    check(dialog->SetTitle(argv[1]), "SetTitle");
    check(dialog->SetOkButtonLabel(argv[2]), "SetOkButtonLabel");
    if (argc == 4) {
        ComPtr<IShellItem> start;
        check(SHCreateItemFromParsingName(argv[3], nullptr, IID_PPV_ARGS(&start)), "ParseStartFolder");
        check(dialog->SetFolder(start.Get()), "SetFolder");
    }

    // The Web host has no browser HWND. Keep the dialog independent of other applications.
    const HRESULT shown = dialog->Show(nullptr);
    if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return;
    check(shown, "Show");
    ComPtr<IShellItem> item;
    check(dialog->GetResult(&item), "GetResult");
    PWSTR rawPath = nullptr;
    check(item->GetDisplayName(SIGDN_FILESYSPATH, &rawPath), "GetDisplayName");
    const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> path(rawPath, CoTaskMemFree);
    const DWORD bytes = static_cast<DWORD>(std::wcslen(path.get()) * sizeof(wchar_t));
    DWORD written = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), path.get(), bytes, &written, nullptr))
        throw Failure{"WriteFile", HRESULT_FROM_WIN32(GetLastError())};
    if (!bytes || written != bytes) throw Failure{"WriteFile", E_FAIL};
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 3 && argc != 4) {
        std::fputs("Usage: directory-picker.exe TITLE CONFIRM_LABEL [START_DIRECTORY]\n", stderr);
        return 2;
    }
    const HRESULT init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    int status = 0;
    try {
        check(init, "CoInitializeEx");
        selectDirectory(argc, argv);
    } catch (const Failure& failure) {
        std::fprintf(stderr, "%s: 0x%08lX\n", failure.operation, static_cast<unsigned long>(failure.result));
        status = 1;
    }
    if (SUCCEEDED(init)) CoUninitialize();
    return status;
}
