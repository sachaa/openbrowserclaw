// ---------------------------------------------------------------------------
// OpenBrowserClaw — WebVM wrapper (v86-based Alpine Linux in WebAssembly)
// ---------------------------------------------------------------------------
//
// This module manages a lightweight Linux VM running inside a Web Worker.
// The VM is booted lazily on first bash command and cached for reuse.
//
// Implementation notes:
// - Uses v86 (https://github.com/nicknisi/nicknisi) or compatible WASM emulator
// - Boots Alpine Linux from a pre-built ext2 rootfs image
// - Communicates via serial console (stdin/stdout)
// - No network access inside the VM
// - The rootfs image must be served as a static asset at /assets/alpine-rootfs.ext2
//
// This file provides the interface. The actual v86 library is loaded dynamically
// since it's a large WASM binary (~1.5MB).
//
// IMPORTANT: This runs inside a Web Worker context (no DOM access).

export interface VMInstance {
  execute(command: string, timeoutSec: number): Promise<VMResult>;
  isReady(): boolean;
  destroy(): void;
}

export interface VMResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

let instance: VMInstance | null = null;
let booting = false;
let bootPromise: Promise<void> | null = null;

/**
 * Boot the VM. Idempotent — returns immediately if already booted or booting.
 * The actual boot is deferred and async.
 */
export async function bootVM(): Promise<void> {
  if (instance?.isReady()) return;
  if (bootPromise) return bootPromise;

  booting = true;
  bootPromise = doBootVM();

  try {
    await bootPromise;
  } finally {
    booting = false;
    bootPromise = null;
  }
}

/**
 * Execute a command in the VM. Boots VM if not already running.
 */
export async function executeInVM(command: string, timeoutSec: number = 30): Promise<string> {
  if (!instance?.isReady()) {
    // VM not available — fall back to a helpful error
    return (
      'Error: WebVM is not available. The VM requires a ~30MB Alpine Linux image ' +
      'served at /assets/alpine-rootfs.ext2. Use the "javascript" tool for code ' +
      'execution, or the "fetch_url" tool for HTTP requests.'
    );
  }

  const result = await instance.execute(command, timeoutSec);

  let output = '';
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += (output ? '\n' : '') + result.stderr;
  if (result.timedOut) output += '\n[command timed out]';
  if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;
  return output || '(no output)';
}

/**
 * Shut down the VM and free resources.
 */
export async function shutdownVM(): Promise<void> {
  instance?.destroy();
  instance = null;
}

/**
 * Check if the VM is booted and ready for commands.
 */
export function isVMReady(): boolean {
  return instance?.isReady() ?? false;
}

// ---------------------------------------------------------------------------
// Internal boot logic
// ---------------------------------------------------------------------------

async function doBootVM(): Promise<void> {
  try {
    // Dynamically import v86 — it's a large WASM module
    // In production this would be: const { V86 } = await import('/assets/v86/libv86.js');
    // For now, we create a mock that indicates the VM is not available
    // until the real v86 assets are deployed.

    const rootfsUrl = '/assets/alpine-rootfs.ext2';
    const wasmUrl = '/assets/v86.wasm';

    // Check if assets exist
    const [rootfsCheck, wasmCheck] = await Promise.all([
      fetch(rootfsUrl, { method: 'HEAD' }).catch(() => null),
      fetch(wasmUrl, { method: 'HEAD' }).catch(() => null),
    ]);

    if (!rootfsCheck?.ok || !wasmCheck?.ok) {
      console.warn(
        'WebVM assets not found. Bash tool will be unavailable. ' +
          'To enable: place alpine-rootfs.ext2 and v86.wasm in public/assets/',
      );
      return;
    }

    // Load v86 dynamically
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v86Module: any = await Function('return import("/assets/v86/libv86.js")')();
    const V86 = v86Module.V86 || v86Module.default;

    // Fetch and cache rootfs
    const rootfsResponse = await fetch(rootfsUrl);
    const rootfsBuffer = await rootfsResponse.arrayBuffer();

    // Boot emulator in headless mode
    const emulator = new V86({
      wasm_path: wasmUrl,
      memory_size: 128 * 1024 * 1024, // 128 MB
      vga_memory_size: 0,
      filesystem: {
        baseurl: '',
        basefs: rootfsBuffer,
      },
      autostart: true,
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
      serial_container: null,
    });

    // Wait for shell prompt
    await waitForSerial(emulator, 'login:', 30000);
    emulator.serial0_send('root\n');
    await waitForSerial(emulator, '# ', 10000);

    instance = {
      isReady: () => true,
      destroy: () => {
        emulator.destroy();
        instance = null;
      },
      execute: (cmd: string, timeout: number) => executeCommand(emulator, cmd, timeout),
    };

    console.log('WebVM booted successfully');
  } catch (err) {
    console.error('Failed to boot WebVM:', err);
  }
}

function waitForSerial(emulator: V86Emulator, needle: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      emulator.remove_listener('serial0-output-byte', listener);
      reject(new Error(`Timeout waiting for "${needle}"`));
    }, timeoutMs);

    const listener = (byte: number) => {
      buffer += String.fromCharCode(byte);
      if (buffer.includes(needle)) {
        clearTimeout(timer);
        emulator.remove_listener('serial0-output-byte', listener);
        resolve();
      }
    };
    emulator.add_listener('serial0-output-byte', listener);
  });
}

function executeCommand(
  emulator: V86Emulator,
  command: string,
  timeoutSec: number,
): Promise<VMResult> {
  return new Promise((resolve) => {
    const marker = `__BCDONE_${Date.now()}__`;
    let output = '';
    let collecting = false;

    const timer = setTimeout(() => {
      cleanup();
      resolve({
        stdout: output,
        stderr: '',
        exitCode: 124,
        timedOut: true,
      });
    }, timeoutSec * 1000);

    const listener = (byte: number) => {
      const char = String.fromCharCode(byte);
      output += char;

      if (output.includes(marker)) {
        cleanup();
        const parts = output.split(marker);
        const cmdOutput = parts[0]
          // Strip the command echo from serial output
          .replace(new RegExp(`^.*?\\n`), '')
          .trim();
        const exitCode = parseInt(parts[1]?.trim() || '0', 10);
        resolve({
          stdout: cmdOutput,
          stderr: '',
          exitCode: isNaN(exitCode) ? 1 : exitCode,
          timedOut: false,
        });
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      emulator.remove_listener('serial0-output-byte', listener);
    };

    emulator.add_listener('serial0-output-byte', listener);
    output = '';
    emulator.serial0_send(`${command} 2>&1; echo "${marker}$?"\n`);
  });
}

// ---------------------------------------------------------------------------
// v86 type stubs (the actual types come from the v86 library)
// ---------------------------------------------------------------------------

interface V86Emulator {
  serial0_send(data: string): void;
  add_listener(event: string, callback: (byte: number) => void): void;
  remove_listener(event: string, callback: (byte: number) => void): void;
  destroy(): void;
}
