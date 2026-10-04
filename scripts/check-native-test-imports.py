from pathlib import Path
import ctypes
import pefile

binary=Path('apps/geod-agent-desktop/src-tauri/target/debug/deps/geod_agent_desktop_lib-599ce6964fa901bd.exe')
pe=pefile.PE(str(binary),fast_load=True)
pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT']])
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.LoadLibraryW.argtypes=[ctypes.c_wchar_p];kernel.LoadLibraryW.restype=ctypes.c_void_p
kernel.GetProcAddress.argtypes=[ctypes.c_void_p,ctypes.c_char_p];kernel.GetProcAddress.restype=ctypes.c_void_p
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    module=kernel.LoadLibraryW(entry.dll.decode())
    missing=[symbol.name.decode() for symbol in entry.imports if symbol.name and not kernel.GetProcAddress(module,symbol.name)] if module else ['LOAD_FAILED']
    if missing:print(entry.dll.decode(),missing)
