// 日志：极简 logger，宿主无 cordis 时不依赖
type LogArgs = Record<string, unknown> | undefined;

function format(args: LogArgs): string {
  if (!args) return "";
  try {
    return " " + JSON.stringify(args);
  } catch {
    return "";
  }
}

export function log(message: string, args?: LogArgs): void {
  const line = `[dsh-mem] ${message}${format(args)}`;
  if (process.env.DSH_MEM_DEBUG) {
    console.error(line);
  }
}
