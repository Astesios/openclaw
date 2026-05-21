import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
// Two layouts: source (extensions/lushu/src/exec/) and dist-bundled
// (dist/extensions/lushu/, single index.js). Pick whichever exists.
const SCRIPTS_DIR_CANDIDATES = [
  path.resolve(here, "..", "..", "scripts"),
  path.resolve(here, "scripts"),
];
export const SCRIPTS_DIR =
  SCRIPTS_DIR_CANDIDATES.find((candidate) => existsSync(candidate)) ?? SCRIPTS_DIR_CANDIDATES[0];

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

export async function runCommand(
  command: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
      encoding: "utf8",
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (e.code === "ENOENT") {
      throw new CommandNotFoundError(command);
    }
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? ""),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export class CommandNotFoundError extends Error {
  constructor(public readonly command: string) {
    super(`command not found on PATH: ${command}`);
    this.name = "CommandNotFoundError";
  }
}

export function scriptPath(filename: string): string {
  return path.join(SCRIPTS_DIR, filename);
}
