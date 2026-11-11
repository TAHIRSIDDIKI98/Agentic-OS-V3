import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { BoundedToolGateway, InMemoryR1Repositories } from '@agentic-os/sdk';
import {
  isR1ConstrainedExecutionSupported,
  R1PlatformUnsupportedError,
  runR1ConstrainedCommand,
} from '../src/services/r1-sandbox-runner.js';

const executeFile = promisify(execFile);
const supported = isR1ConstrainedExecutionSupported();

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'r1-sandbox-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runR1ConstrainedCommand', () => {
  it('surfaces degraded-mode support status per ADR-0031 instead of crashing', async () => {
    expect(isR1ConstrainedExecutionSupported('linux')).toBe(true);
    expect(isR1ConstrainedExecutionSupported('darwin')).toBe(true);
    expect(isR1ConstrainedExecutionSupported('win32')).toBe(false);

    if (!supported) {
      const workingDirectory = await temporaryDirectory();
      const outcome = await runR1ConstrainedCommand({
        command: 'pwd', args: [], timeoutMs: 1_000, workingDirectory,
      }).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(R1PlatformUnsupportedError);
      expect((outcome as R1PlatformUnsupportedError).code).toBe('R1_SANDBOX_PLATFORM_UNSUPPORTED');
    }
  });

  it('executes an allowlisted command without a shell on supported platforms and fails closed otherwise', async () => {
    const workingDirectory = await temporaryDirectory();
    const input = { command: 'echo', args: ['governed runner'], timeoutMs: 1_000, workingDirectory } as const;

    if (!supported) {
      await expect(runR1ConstrainedCommand(input)).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }

    await expect(runR1ConstrainedCommand(input)).resolves.toMatchObject({ stdout: 'governed runner\n', stderr: '', exitCode: 0 });
  });

  it('rejects a command outside the explicit allowlist before process creation', async () => {
    const workingDirectory = await temporaryDirectory();

    await expect(runR1ConstrainedCommand({
      command: 'sh', args: ['-c', 'echo unsafe'], timeoutMs: 1_000, workingDirectory,
    })).rejects.toThrow('Command not allowed by constrained runner');
  });

  it('defensively rejects timeout and argument limits before process creation', async () => {
    const workingDirectory = await temporaryDirectory();

    await expect(runR1ConstrainedCommand({
      command: 'echo', args: [], timeoutMs: 99, workingDirectory,
    })).rejects.toThrow('Constrained runner timeout must be an integer');
    await expect(runR1ConstrainedCommand({
      command: 'echo', args: Array.from({ length: 21 }, () => 'x'), timeoutMs: 1_000, workingDirectory,
    })).rejects.toThrow('Constrained runner accepts at most');
  });

  it('kills a timed-out process on supported platforms and fails closed otherwise', async () => {
    const workingDirectory = await temporaryDirectory();
    const input = { command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 100, workingDirectory } as const;

    if (!supported) {
      await expect(runR1ConstrainedCommand(input)).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }

    await expect(runR1ConstrainedCommand(input)).rejects.toThrow('timed out');
  });

  it('preserves a nonzero exit result for the gateway to deny rather than simulating success', async () => {
    const workingDirectory = await temporaryDirectory();
    const input = {
      command: 'node',
      args: ['-e', "process.stderr.write('intentional failure'); process.exit(7)"],
      timeoutMs: 1_000,
      workingDirectory,
    } as const;

    if (!supported) {
      await expect(runR1ConstrainedCommand(input)).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }

    await expect(runR1ConstrainedCommand(input)).resolves.toMatchObject({ stderr: 'intentional failure', exitCode: 7 });
  });

  it('rejects a symlinked working-directory alias on supported platforms and fails closed otherwise', async () => {
    if (!supported) {
      const fallback = await temporaryDirectory();
      await expect(runR1ConstrainedCommand({
        command: 'pwd', args: [], timeoutMs: 1_000, workingDirectory: fallback,
      })).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }
    const workingDirectory = await temporaryDirectory();
    const alias = `${workingDirectory}-alias`;
    await symlink(workingDirectory, alias);
    directories.push(alias);

    await expect(runR1ConstrainedCommand({
      command: 'pwd', args: [], timeoutMs: 1_000, workingDirectory: alias,
    })).rejects.toThrow('symlink traversal');
  });

  it('rejects cat paths that traverse or resolve through a symlink outside the project root', async () => {
    const workingDirectory = await temporaryDirectory();
    if (!supported) {
      await expect(runR1ConstrainedCommand({
        command: 'cat', args: ['any.txt'], timeoutMs: 1_000, workingDirectory,
      })).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }
    const outsideDirectory = await temporaryDirectory();
    const outsideFile = join(outsideDirectory, 'outside.txt');
    await writeFile(outsideFile, 'outside', 'utf8');
    await symlink(outsideFile, join(workingDirectory, 'outside-link.txt'));

    await expect(runR1ConstrainedCommand({
      command: 'cat',
      args: [`../${basename(outsideDirectory)}/outside.txt`],
      timeoutMs: 1_000,
      workingDirectory,
    })).rejects.toThrow('resolves outside the project root');
    await expect(runR1ConstrainedCommand({
      command: 'cat',
      args: ['outside-link.txt'],
      timeoutMs: 1_000,
      workingDirectory,
    })).rejects.toThrow('resolves outside the project root');
  });

  it('executes real project-root cat and git inspection commands on supported platforms', async () => {
    const workingDirectory = await temporaryDirectory();
    if (!supported) {
      await expect(runR1ConstrainedCommand({
        command: 'cat', args: ['package.json'], timeoutMs: 1_000, workingDirectory,
      })).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }
    await writeFile(join(workingDirectory, 'package.json'), '{"name":"runner-fixture"}\n', 'utf8');
    await executeFile('git', ['init', '--quiet', workingDirectory]);

    await expect(runR1ConstrainedCommand({
      command: 'cat', args: ['package.json'], timeoutMs: 1_000, workingDirectory,
    })).resolves.toMatchObject({ stdout: '{"name":"runner-fixture"}\n', exitCode: 0 });
    await expect(runR1ConstrainedCommand({
      command: 'git', args: ['rev-parse', '--show-toplevel'], timeoutMs: 1_000, workingDirectory,
    })).resolves.toMatchObject({ stdout: `${workingDirectory}\n`, exitCode: 0 });
  });

  it('runs a real project-root command through approval, effect-claim, and receipt gateway composition on supported platforms', async () => {
    const workingDirectory = await temporaryDirectory();
    if (!supported) {
      await expect(runR1ConstrainedCommand({
        command: 'cat', args: ['package.json'], timeoutMs: 1_000, workingDirectory,
      })).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }
    await writeFile(join(workingDirectory, 'package.json'), '{"name":"gateway-fixture"}\n', 'utf8');
    const repositories = new InMemoryR1Repositories();
    const projectId = randomUUID();
    const gateway = new BoundedToolGateway(repositories, {
      projectRoots: new Map([[projectId, workingDirectory]]),
      isApprovalApproved: async () => true,
      sandboxExecutor: async (command, args, timeoutMs, root) =>
        runR1ConstrainedCommand({ command, args, timeoutMs, workingDirectory: root }),
    });

    const result = await gateway.runConstrainedCommand({
      projectId,
      taskId: randomUUID(),
      command: 'cat',
      args: ['package.json'],
      approvalId: randomUUID(),
      timeoutMs: 1_000,
      correlationId: randomUUID(),
    });

    expect(result).toMatchObject({ ok: true, output: '{"name":"gateway-fixture"}\n' });
  });

  it('runs a controlled package-manager fixture only with separate high-risk policy authorization on supported platforms', async () => {
    const workingDirectory = await temporaryDirectory();
    if (!supported) {
      await expect(runR1ConstrainedCommand({
        command: 'pnpm', args: ['run', 'x'], timeoutMs: 1_000, workingDirectory,
      })).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }
    await writeFile(
      join(workingDirectory, 'package.json'),
      JSON.stringify({
        name: 'r1-package-manager-fixture',
        private: true,
        scripts: { 'r1-fixture': 'node fixture.cjs' },
      }),
      'utf8',
    );
    await writeFile(
      join(workingDirectory, 'fixture.cjs'),
      "process.stdout.write('controlled-package-manager-fixture')\n",
      'utf8',
    );
    const repositories = new InMemoryR1Repositories();
    const projectId = randomUUID();
    let policyChecks = 0;
    const gateway = new BoundedToolGateway(repositories, {
      projectRoots: new Map([[projectId, workingDirectory]]),
      isApprovalApproved: async () => true,
      authorizeHighRiskCommand: async (request) => {
        policyChecks += 1;
        expect(request.risk).toMatchObject({
          level: 'high',
          networkCapable: true,
          repositoryCodeExecution: true,
        });
        return request.command === 'pnpm';
      },
      sandboxExecutor: async (command, args, timeoutMs, root) =>
        runR1ConstrainedCommand({ command, args, timeoutMs, workingDirectory: root }),
    });

    const result = await gateway.runConstrainedCommand({
      projectId,
      taskId: randomUUID(),
      command: 'pnpm',
      args: ['run', 'r1-fixture'],
      approvalId: randomUUID(),
      timeoutMs: 5_000,
      correlationId: randomUUID(),
    });

    const pnpmAvailable = await Promise.any(
      ['/usr/local/sbin/pnpm', '/usr/local/bin/pnpm', '/usr/sbin/pnpm', '/usr/bin/pnpm', '/sbin/pnpm', '/bin/pnpm']
        .map((path) => access(path).then(() => true)),
    ).catch(() => false);
    if (!pnpmAvailable) {
      // The constrained runner deliberately uses a minimal fixed PATH. Treat a
      // missing optional package-manager binary as a fail-closed environment, not
      // as a policy bypass or a successful execution.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/pnpm|ENOENT/i);
      expect(policyChecks).toBe(1);
      return;
    }

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('controlled-package-manager-fixture');
    expect(policyChecks).toBe(1);
  });

  it('fails closed for a network-capable command without separate deployment-policy authorization', async () => {
    const workingDirectory = await temporaryDirectory();
    const repositories = new InMemoryR1Repositories();
    const projectId = randomUUID();
    const taskId = randomUUID();
    let executions = 0;
    const gateway = new BoundedToolGateway(repositories, {
      projectRoots: new Map([[projectId, workingDirectory]]),
      isApprovalApproved: async () => true,
      sandboxExecutor: async () => {
        executions += 1;
        return { stdout: 'must-not-run', stderr: '', exitCode: 0 };
      },
    });

    const result = await gateway.runConstrainedCommand({
      projectId,
      taskId,
      command: 'node',
      args: ['--version'],
      approvalId: randomUUID(),
      timeoutMs: 1_000,
      correlationId: randomUUID(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'High-risk command requires separate deployment-policy authorization',
    });
    expect(executions).toBe(0);
    const receipts = await repositories.receipts.listForTask(projectId, taskId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ decision: 'deny' });
    expect(receipts[0]?.payload).toMatchObject({
      command: 'node',
      networkCapable: true,
      repositoryCodeExecution: true,
    });
    expect(receipts[0]?.payload).not.toHaveProperty('args');
  });

  it('does not forward an ambient secret into a spawned command on supported platforms', async () => {
    const workingDirectory = await temporaryDirectory();
    const key = 'R1_SANDBOX_TEST_SECRET';
    const original = process.env[key];
    process.env[key] = 'must-not-reach-child';

    try {
      const input = {
        command: 'node',
        args: ['-e', `process.stdout.write(process.env.${key} ?? 'absent')`],
        timeoutMs: 1_000,
        workingDirectory,
      } as const;

      if (!supported) {
        await expect(runR1ConstrainedCommand(input)).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
        return;
      }

      await expect(runR1ConstrainedCommand(input)).resolves.toMatchObject({ stdout: 'absent', exitCode: 0 });
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('does not resolve an allowlisted command from a parent PATH hijack on supported POSIX platforms', async () => {
    const workingDirectory = await temporaryDirectory();
    if (process.platform === 'win32') {
      await expect(runR1ConstrainedCommand({
        command: 'echo', args: ['not-run'], timeoutMs: 1_000, workingDirectory,
      })).rejects.toThrow('Windows constrained-command execution is unsupported');
      return;
    }

    const hijackDirectory = join(workingDirectory, 'hijack-bin');
    await mkdir(hijackDirectory);
    const fakeEcho = join(hijackDirectory, 'echo');
    await writeFile(fakeEcho, '#!/bin/sh\nprintf hijacked\n', 'utf8');
    await chmod(fakeEcho, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = hijackDirectory;

    try {
      await expect(runR1ConstrainedCommand({
        command: 'echo', args: ['trusted'], timeoutMs: 1_000, workingDirectory,
      })).resolves.toMatchObject({ stdout: 'trusted\n', exitCode: 0 });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('terminates a nested POSIX process tree after timeout or fails closed on Windows', async () => {
    const workingDirectory = await temporaryDirectory();
    if (process.platform === 'win32') {
      await expect(runR1ConstrainedCommand({
        command: 'node', args: ['-e', ''], timeoutMs: 1_000, workingDirectory,
      })).rejects.toThrow('Windows constrained-command execution is unsupported');
      return;
    }

    const marker = join(workingDirectory, 'orphan-marker.txt');
    const childProgram = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 400)`;
    const parentProgram = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}]); setTimeout(() => {}, 5000)`;

    await expect(runR1ConstrainedCommand({
      command: 'node', args: ['-e', parentProgram], timeoutMs: 100, workingDirectory,
    })).rejects.toThrow('timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    await expect(access(marker)).rejects.toThrow();
  });

  it('caps combined command output and reports an error instead of returning a truncated success', async () => {
    const workingDirectory = await temporaryDirectory();
    const input = {
      command: 'node',
      args: ['-e', "process.stdout.write('x'.repeat(1000001))"],
      timeoutMs: 5_000,
      workingDirectory,
    } as const;

    if (!supported) {
      await expect(runR1ConstrainedCommand(input)).rejects.toBeInstanceOf(R1PlatformUnsupportedError);
      return;
    }

    await expect(runR1ConstrainedCommand(input)).rejects.toThrow('exceeded 1000000 output bytes');
  });
});
