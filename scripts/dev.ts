// Start the engine service and the web app together. Arguments go to the
// engine, for example `pnpm dev --port 4400`.
import { spawn, type ChildProcess } from "node:child_process";

const engineArgs = process.argv.slice(2);
const children: ChildProcess[] = [];

function start(name: string, cmd: string, args: string[], color: number) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = `\x1b[${color}m${name.padEnd(6)}\x1b[0m `;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout!, process.stdout);
  pipe(child.stderr!, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    stopAll();
  });
  children.push(child);
}

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGINT");
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", stopAll);
start("engine", "pnpm", ["-s", "orch", "serve", ...engineArgs], 36);
start("web", "pnpm", ["-s", "--filter", "web", "dev"], 35);
