"""Read process/window state for one explicitly supplied local process ID."""
import argparse, ctypes, json
from ctypes import wintypes
import psutil
parser = argparse.ArgumentParser(); parser.add_argument('--pid', type=int, required=True); args = parser.parse_args()
try:
    process = psutil.Process(args.pid)
    descendants = process.children(recursive=True)
    process_ids = {args.pid, *[child.pid for child in descendants]}
    children = [{'pid': child.pid, 'name': child.name()} for child in descendants]
except psutil.NoSuchProcess:
    process = None; process_ids = {args.pid}; children = []
windows = []; user = ctypes.WinDLL('user32', use_last_error=True)
callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user.EnumWindows.argtypes = [callback, wintypes.LPARAM]
user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user.IsWindowVisible.argtypes = [wintypes.HWND]; user.IsWindowVisible.restype = wintypes.BOOL
user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
@callback
def collect(handle, _):
    process = wintypes.DWORD(); user.GetWindowThreadProcessId(handle, ctypes.byref(process))
    if process.value in process_ids and user.IsWindowVisible(handle):
        title = ctypes.create_unicode_buffer(256); klass = ctypes.create_unicode_buffer(128); rect = wintypes.RECT()
        user.GetWindowTextW(handle, title, len(title)); user.GetClassNameW(handle, klass, len(klass)); user.GetWindowRect(handle, ctypes.byref(rect))
        windows.append({'pid': process.value, 'title': title.value, 'class': klass.value, 'width': rect.right-rect.left, 'height': rect.bottom-rect.top})
    return True
user.EnumWindows(collect, 0)
try:
    process = psutil.Process(args.pid)
    helpers = [window for window in windows if window['class'] == 'Tao Thread Event Target' and not window['title'] and window['width'] == 16 and window['height'] == 16]
    result = {'pid': args.pid, 'alive': process.is_running(), 'visibleWindows': len(windows)-len(helpers), 'internalEventTargets': len(helpers), 'windows': windows, 'children': children}
except psutil.NoSuchProcess: result = {'pid': args.pid, 'alive': False, 'visibleWindows': len(windows), 'children': []}
print(json.dumps(result))
