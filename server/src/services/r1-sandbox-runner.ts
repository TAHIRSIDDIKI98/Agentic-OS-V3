import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, delimiter } from 'node:path';

export interface R1SandboxRunInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly workingDirectory: string;
}

export interface R1SandboxRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const ALLOWED_COMMANDS = new Set(['cat', 'echo', 'git', 'ls', 'node', 'npm', 'pnpm', 'pwd']);
const MAX_OUTPUT_BYTES = 1_000_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const MAX_ARGUMENTS = 20;
const MAX_ARGUMENT_LENGTH = 500;
const POSIX_EXECUTION_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * R1 platform stance (ADR-0031, decision D4): the constrained runner is POSIX-first.
 * Windows hosts must surface this as degraded mode instead of crashing — callers
 * check `isR1ConstrainedExecutionSupported` and the runner fails closed with a
 * typed error if invoked anyway.
 */
export function isR1ConstrainedExecutionSupported(platform: string = process.platform): boolean {
  return platform !== 'win32';
}

export class R1PlatformUnsupportedError extends Error {
  readonly code = 'R1_SANDBOX_PLATFORM_UNSUPPORTED';

  constructor() {
    super('Windows constrained-command execution is unsupported pending E10-S8 platform validation (R1 is POSIX-first per ADR-0031; use WSL2)');
    this.name = 'R1PlatformUnsupportedError';
  }
}

function minimalEnvironment(projectRoot: string): NodeJS.ProcessEnv {
  // Do not inherit the server PATH: npm scripts and hostile repositories can prepend
  // project-controlled bin directories. The running Node executable's directory is
  // trusted and must remain available for allowlisted npm/pnpm shims and their child
  // processes; process.execPath is fixed by the host, not by the project or ambient PATH.
  // This is an executable-location control, not executable provenance; an attacker
  // controlling a trusted system directory remains outside the bounded runner's boundary.
  const path = [dirname(process.execPath), POSIX_EXECUTION_PATH].join(delimiter);
  return { PATH: path, HOME: projectRoot, NO_COLOR: '1' };
}

async function validateProjectScopedFileArguments(
  command: string,
  args: readonly string[],
  projectRoot: string,
): Promise<void> {
  if (command !== 'cat' && command !== 'ls') return;

  for (const argument of args) {
    if (argument === '--') continue;
    if (argument.startsWith('-')) {
      throw new Error(`${command} options are not admitted by the constrained runner`);
    }
    if (isAbsolute(argument)) {
      throw new Error(`${command} path must be relative to the project root`);
    }
    const candidate = await realpath(resolve(projectRoot, argument));
    const pathFromRoot = relative(projectRoot, candidate);
    if (pathFromRoot === '..' || pathFromRoot.startsWith('../') || isAbsolute(pathFromRoot)) {
      throw new Error(`${command} path resolves outside the project root`);
    }
  }
}

/**
 * Execute a deliberately small, shell-free command allowlist in a project root.
 * This is a bounded process runner, not a container/VM. Callers must treat its
 * explicit limits as part of their policy decision and never pass untrusted env.
 */
export async function runR1ConstrainedCommand(input: R1SandboxRunInput): Promise<R1SandboxRunResult> {
  // Pure input-policy validation fires on every platform before any platform gate:
  // callers must be able to rely on identical rejection contracts for malformed input.
  if (!ALLOWED_COMMANDS.has(input.command)) {
    throw new Error(`Command not allowed by constrained runner: ${input.command}`);
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Constrained runner timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}ms`);
  }
  if (input.args.length > MAX_ARGUMENTS || input.args.some((argument) => argument.length > MAX_ARGUMENT_LENGTH)) {
    throw new Error(`Constrained runner accepts at most ${MAX_ARGUMENTS} arguments of ${MAX_ARGUMENT_LENGTH} characters`);
  }
  if (!isR1ConstrainedExecutionSupported()) {
    // Fail closed with surfaced degraded-mode status rather than attempting
    // POSIX-path-semantics process creation on Windows (ADR-0031).
    throw new R1PlatformUnsupportedError();
  }

  const root = await realpath(input.workingDirectory);
  const requested = resolve(input.workingDirectory);
  if (root !== requested) {
    throw new Error('Constrained runner working directory must resolve without symlink traversal');
  }
  await validateProjectScopedFileArguments(input.command, input.args, root);

  return new Promise<R1SandboxRunResult>((resolveResult, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: root,
      detached: true,
      env: minimalEnvironment(root),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    const stop = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const onData = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop();
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk: Buffer) => onData('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => onData('stderr', chunk));
    child.once('error', (error: Error) => finish(() => reject(error)));
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => finish(() => {
      if (timedOut) {
        reject(new Error(`Constrained command timed out after ${input.timeoutMs}ms`));
        return;
      }
      if (outputBytes > MAX_OUTPUT_BYTES) {
        reject(new Error(`Constrained command exceeded ${MAX_OUTPUT_BYTES} output bytes`));
        return;
      }
      resolveResult({ stdout, stderr: signal ? `${stderr}\nterminated by ${signal}`.trim() : stderr, exitCode: code ?? 1 });
    }));

    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
  });
}
