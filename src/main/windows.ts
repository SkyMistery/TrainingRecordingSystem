import koffi from 'koffi'

/** A top-level window on the desktop, in physical screen pixels. */
export interface DesktopWindow {
  /** Window handle, stable while the window exists. */
  id: string
  exe: string
  title: string
  x: number
  y: number
  width: number
  height: number
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14
/** Process ids are reused: forget their executables now and then. */
const EXE_CACHE_MS = 10_000

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const dwmapi = koffi.load('dwmapi.dll')

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)')
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *proc, intptr_t lParam)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)')
const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)')
const GetWindowThreadProcessId = user32.func(
  'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'
)
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, void *text, int max)')
const DwmGetWindowAttribute = dwmapi.func(
  'long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attribute, void *value, uint32_t size)'
)
const OpenProcess = kernel32.func('void *__stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *size)'
)
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)')

const exeCache = new Map<number, string>()
let exeCacheTime = 0

/** Executable file name of a process ("Aurora.exe"), or "" if it can't be read. */
function processExe(pid: number): string {
  if (Date.now() - exeCacheTime > EXE_CACHE_MS) {
    exeCache.clear()
    exeCacheTime = Date.now()
  }
  let exe = exeCache.get(pid)
  if (exe !== undefined) return exe
  exe = ''
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (handle) {
    try {
      const buffer = Buffer.alloc(1024 * 2)
      const size = [1024]
      if (QueryFullProcessImageNameW(handle, 0, buffer, size)) {
        exe =
          buffer
            .toString('utf16le', 0, size[0] * 2)
            .split('\\')
            .pop() ?? ''
      }
    } finally {
      CloseHandle(handle)
    }
  }
  exeCache.set(pid, exe)
  return exe
}

function windowTitle(hwnd: unknown): string {
  const buffer = Buffer.alloc(512 * 2)
  const length = GetWindowTextW(hwnd, buffer, 512) as number
  return buffer.toString('utf16le', 0, length * 2)
}

/**
 * Windows shown on screen (visible, not minimised, not on another virtual
 * desktop), front to back. `wanted` filters by executable before the more
 * expensive calls; the app's own windows are left out.
 */
export function listDesktopWindows(wanted?: (exe: string) => boolean): DesktopWindow[] {
  const found: DesktopWindow[] = []
  const pidOut = [0]
  const rect = Buffer.alloc(16)
  const cloaked = Buffer.alloc(4)
  EnumWindows((hwnd: unknown) => {
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true
    GetWindowThreadProcessId(hwnd, pidOut)
    if (pidOut[0] === process.pid) return true
    const exe = processExe(pidOut[0])
    if (!exe || (wanted && !wanted(exe))) return true
    if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked.readUInt32LE(0) !== 0) return true
    // The visible frame, without the invisible resize borders and shadow; always physical pixels.
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0) return true
    const [left, top, right, bottom] = [0, 4, 8, 12].map((offset) => rect.readInt32LE(offset))
    if (right <= left || bottom <= top) return true
    found.push({
      id: String(hwnd),
      exe,
      title: windowTitle(hwnd),
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    })
    return true
  }, 0)
  return found
}
