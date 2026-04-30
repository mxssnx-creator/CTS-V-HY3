/**
 * Engine Mode Helper
 * 
 * Returns the engine mode based on ENGINE_MODE env variable:
 * - "long-running" (default): Uses setTimeout loops (for VPS/Docker)
 * - "serverless": Uses cron-based batch processing (for Vercel)
 */

export type EngineMode = "long-running" | "serverless"

const DEFAULT_MODE: EngineMode = "long-running"

/**
 * Get the current engine mode
 */
export function getEngineMode(): EngineMode {
  const mode = (process.env.ENGINE_MODE || DEFAULT_MODE).toLowerCase().trim()
  if (mode === "serverless" || mode === "server-less" || mode === "vercel") {
    return "serverless"
  }
  return "long-running"
}

/**
 * Check if we're in serverless mode
 */
export function isServerlessMode(): boolean {
  return getEngineMode() === "serverless"
}

/**
 * Check if we're in long-running mode
 */
export function isLongRunningMode(): boolean {
  return getEngineMode() === "long-running"
}
