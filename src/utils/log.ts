export function info(message: string): void {
  process.stdout.write(`[INFO] ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[WARN] ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`[ERROR] ${message}\n`);
}
