"""Trace the loader of one local Rust test executable; no registry changes."""
import argparse, ctypes as c, json, time
from ctypes import wintypes as w
from pathlib import Path

parser = argparse.ArgumentParser(); parser.add_argument('binary', type=Path); args = parser.parse_args()
binary = args.binary.resolve(); assert binary.name.startswith('geod_agent_desktop_lib-') and binary.suffix == '.exe'
K = c.WinDLL('kernel32', use_last_error=True); N = c.WinDLL('ntdll')
class Startup(c.Structure):
    _fields_ = [('cb',w.DWORD),('lpReserved',w.LPWSTR),('lpDesktop',w.LPWSTR),('lpTitle',w.LPWSTR),('dwX',w.DWORD),('dwY',w.DWORD),('dwXSize',w.DWORD),('dwYSize',w.DWORD),('dwXCountChars',w.DWORD),('dwYCountChars',w.DWORD),('dwFillAttribute',w.DWORD),('dwFlags',w.DWORD),('wShowWindow',w.WORD),('cbReserved2',w.WORD),('lpReserved2',c.c_void_p),('hStdInput',w.HANDLE),('hStdOutput',w.HANDLE),('hStdError',w.HANDLE)]
class Process(c.Structure): _fields_ = [('hProcess',w.HANDLE),('hThread',w.HANDLE),('dwProcessId',w.DWORD),('dwThreadId',w.DWORD)]
class ExceptionRecord(c.Structure):
    _fields_ = [('code',w.DWORD),('flags',w.DWORD),('record',c.c_void_p),('address',c.c_void_p),('count',w.DWORD),('information',c.c_size_t*15)]
class Exception(c.Structure): _fields_ = [('record',ExceptionRecord),('firstChance',w.DWORD)]
class CreateInfo(c.Structure):
    _fields_ = [('file',w.HANDLE),('process',w.HANDLE),('thread',w.HANDLE),('base',c.c_void_p),('offset',w.DWORD),('size',w.DWORD),('tls',c.c_void_p),('start',c.c_void_p),('imageName',c.c_void_p),('unicode',w.WORD)]
class LoadInfo(c.Structure): _fields_ = [('file',w.HANDLE),('base',c.c_void_p),('offset',w.DWORD),('size',w.DWORD),('imageName',c.c_void_p),('unicode',w.WORD)]
class DebugText(c.Structure): _fields_ = [('data',c.c_void_p),('unicode',w.WORD),('length',w.WORD)]
class Payload(c.Union): _fields_ = [('exception',Exception),('create',CreateInfo),('load',LoadInfo),('text',DebugText),('exit',w.DWORD),('raw',c.c_byte*160)]
class Event(c.Structure): _fields_ = [('code',w.DWORD),('pid',w.DWORD),('tid',w.DWORD),('data',Payload)]
class Basic(c.Structure): _fields_ = [('reserved1',c.c_void_p),('peb',c.c_void_p),('reserved2',c.c_void_p*2),('pid',c.c_size_t),('reserved3',c.c_void_p)]
K.CreateProcessW.argtypes=[w.LPCWSTR,w.LPWSTR,c.c_void_p,c.c_void_p,w.BOOL,w.DWORD,c.c_void_p,w.LPCWSTR,c.POINTER(Startup),c.POINTER(Process)]; K.CreateProcessW.restype=w.BOOL
K.WaitForDebugEvent.argtypes=[c.POINTER(Event),w.DWORD]; K.WaitForDebugEvent.restype=w.BOOL
K.ContinueDebugEvent.argtypes=[w.DWORD,w.DWORD,w.DWORD]; K.ContinueDebugEvent.restype=w.BOOL
K.ReadProcessMemory.argtypes=[w.HANDLE,c.c_void_p,c.c_void_p,c.c_size_t,c.POINTER(c.c_size_t)]; K.ReadProcessMemory.restype=w.BOOL
K.WriteProcessMemory.argtypes=K.ReadProcessMemory.argtypes; K.WriteProcessMemory.restype=w.BOOL
K.GetFinalPathNameByHandleW.argtypes=[w.HANDLE,w.LPWSTR,w.DWORD,w.DWORD]; K.GetFinalPathNameByHandleW.restype=w.DWORD
K.CloseHandle.argtypes=[w.HANDLE]; K.TerminateProcess.argtypes=[w.HANDLE,w.UINT]
N.NtQueryInformationProcess.argtypes=[w.HANDLE,w.ULONG,c.c_void_p,w.ULONG,c.c_void_p]
K.SetErrorMode(0x0001|0x0002|0x8000)
startup=Startup(); startup.cb=c.sizeof(startup); process=Process(); command=c.create_unicode_buffer(f'"{binary}" --list')
if not K.CreateProcessW(str(binary),command,None,None,False,0x2|0x08000000,None,str(binary.parent),c.byref(startup),c.byref(process)): raise c.WinError(c.get_last_error())
report={'binary':binary.name,'loaderSnapsEnabled':False,'dlls':[],'debugText':[],'exceptions':[]}; deadline=time.monotonic()+30; exited=False
def read(address,length):
    buf=c.create_string_buffer(length); actual=c.c_size_t()
    return bytes(buf[:actual.value]) if K.ReadProcessMemory(process.hProcess,address,buf,length,c.byref(actual)) else b''
try:
    while time.monotonic()<deadline:
        event=Event()
        if not K.WaitForDebugEvent(c.byref(event),1000): continue
        continuation=0x00010002
        if event.code==3:
            basic=Basic()
            if N.NtQueryInformationProcess(process.hProcess,0,c.byref(basic),c.sizeof(basic),None)==0:
                old=int.from_bytes(read(basic.peb+0xBC,4),'little'); flag=w.DWORD(old|0x2); actual=c.c_size_t()
                report['loaderSnapsEnabled']=bool(K.WriteProcessMemory(process.hProcess,basic.peb+0xBC,c.byref(flag),4,c.byref(actual)))
            if event.data.create.file: K.CloseHandle(event.data.create.file)
        elif event.code==6:
            value=c.create_unicode_buffer(4096)
            if event.data.load.file:
                if K.GetFinalPathNameByHandleW(event.data.load.file,value,len(value),0): report['dlls'].append(value.value)
                K.CloseHandle(event.data.load.file)
        elif event.code==8:
            data=read(event.data.text.data,event.data.text.length*(2 if event.data.text.unicode else 1))
            report['debugText'].append(data.decode('utf-16-le' if event.data.text.unicode else 'utf-8',errors='replace').rstrip('\0'))
        elif event.code==1:
            code=event.data.exception.record.code; report['exceptions'].append({'code':hex(code),'firstChance':bool(event.data.exception.firstChance)})
            if code not in [0x80000003,0x80000004]: continuation=0x80010001
        elif event.code==5:
            report['exitCode']=hex(event.data.exit); exited=True
        K.ContinueDebugEvent(event.pid,event.tid,continuation)
        if exited: break
    if not exited: report['timeout']=True; K.TerminateProcess(process.hProcess,1)
finally:
    K.CloseHandle(process.hThread); K.CloseHandle(process.hProcess)
output=Path('artifacts/product-gaps-20261004/native-test-loader.json'); output.parent.mkdir(parents=True,exist_ok=True); output.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({'exitCode':report.get('exitCode'),'loaderSnapsEnabled':report['loaderSnapsEnabled'],'lastMessages':report['debugText'][-20:],'exceptions':report['exceptions']}))
