type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_VALUES: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function parseLevel(raw: string): LogLevel {
  const normalized = raw.toLowerCase();
  if (normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return "info";
}

const configuredLevel: number = LEVEL_VALUES[parseLevel(process.env.STAVROBOT_LOG_LEVEL ?? "info")];

export const log = {
  error(...args: unknown[]): void {
    if (LEVEL_VALUES.error <= configuredLevel) {
      console.error(...args);
    }
  },

  warn(...args: unknown[]): void {
    if (LEVEL_VALUES.warn <= configuredLevel) {
      console.warn(...args);
    }
  },

  info(...args: unknown[]): void {
    if (LEVEL_VALUES.info <= configuredLevel) {
      console.log(...args);
    }
  },

  debug(...args: unknown[]): void {
    if (LEVEL_VALUES.debug <= configuredLevel) {
      console.log(...args);
    }
  },

  isDebugEnabled(): boolean {
    return LEVEL_VALUES.debug <= configuredLevel;
  },
};
