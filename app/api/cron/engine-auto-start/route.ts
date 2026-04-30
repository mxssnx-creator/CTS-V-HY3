import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { getAllConnections, getRedisClient, initRedis } from "@/lib/redis-db"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { 
  runIndicationCycle, 
  runStrategyCycle, 
  runRealtimeCycle,
} from "@/lib/trade-engine/engine-cycle"
import { hasConnectionCredentials, isConnectionMainProcessing, isTruthyFlag } from "@/lib/connection-state-utils"
import { getEngineMode, type EngineMode } from "@/lib/engine-mode"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Cron Job: Engine Auto-Start + Cycle Runner
 * 
 * In serverless mode (ENGINE_MODE=serverless):
 *   - Does NOT start setTimeout loops (they die when function is killed)
 *   - Instead, runs ONE cycle of work for each engine
 *   - The cron schedule determines the frequency of cycles
 * 
 * In long-running mode (ENGINE_MODE=long-running):
 *   - Starts engines with setTimeout loops as before
 *   - This cron job just ensures engines are running
 */
export async function GET() {
  const started = Date.now()
  await initRedis()
  const client = getRedisClient()
  const engineMode = getEngineMode()

  // Overlap guard: prevent multiple instances from running simultaneously
  const LOCK_KEY = "cron:engine-auto-start:lock"
  const acquired = await client.set(LOCK_KEY, "1", { EX: 55, NX: true })
  if (!acquired) {
    return NextResponse.json({ ok: true, skipped: true, reason: "previous run still active", mode: engineMode })
  }

  try {
    // In long-running mode, just ensure engines are started (setTimeout loops)
    if (engineMode === "long-running") {
      const globalState = await client.hgetall("trade_engine:global")
      if (globalState?.status !== "running") {
        return NextResponse.json({
          ok: true,
          skipped: true,
          reason: "global trade engine not running",
          mode: engineMode,
        })
      }

      const connections = await getAllConnections()
      if (!Array.isArray(connections)) {
        return NextResponse.json({
          ok: false,
          error: "failed to load connections",
          mode: engineMode,
        })
      }

      const connectionsThatShouldBeRunning = connections.filter((c: any) => {
        const isFullyEnabled = isConnectionMainProcessing(c)
        if (!isFullyEnabled) return false
        const hasAnyCredentials = hasConnectionCredentials(c, 5, true)
        const isPredefined = isTruthyFlag(c.is_predefined)
        const isTestnet = isTruthyFlag(c.is_testnet) || isTruthyFlag(c.demo_mode)
        return hasAnyCredentials || isPredefined || isTestnet
      })

      if (connectionsThatShouldBeRunning.length === 0) {
        return NextResponse.json({
          ok: true,
          checked: 0,
          message: "no connections require engine startup",
          mode: engineMode,
        })
      }

      const coordinator = getGlobalTradeEngineCoordinator()
      const startedCount = await coordinator.startMissingEngines(connectionsThatShouldBeRunning)

      await client.del(LOCK_KEY).catch(() => {})

      return NextResponse.json({
        ok: true,
        ms: Date.now() - started,
        connectionsChecked: connectionsThatShouldBeRunning.length,
        enginesStarted: startedCount,
        mode: engineMode,
      })
    }

    // In serverless mode, run ONE cycle of work for each active engine
    // This is the key fix - engines don't use setTimeout loops that die
    const connections = await getAllConnections()
    const activeConnections = connections.filter((c: any) => {
      return isConnectionMainProcessing(c) && hasConnectionCredentials(c, 5, true)
    })

    if (activeConnections.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "no active connections",
        mode: engineMode,
      })
    }

    const results: any[] = []
    for (const conn of activeConnections) {
      try {
        const cycleStart = Date.now()
        // Run one cycle of all processors
        const [indResult, stratResult, rtResult] = await Promise.all([
          runIndicationCycle(conn.id),
          runStrategyCycle(conn.id),
          runRealtimeCycle(conn.id),
        ])

        results.push({
          connectionId: conn.id,
          connectionName: conn.name,
          indication: { 
            success: indResult.success, 
            producedWork: indResult.producedWork,
            durationMs: indResult.durationMs,
          },
          strategy: { 
            success: stratResult.success, 
            producedWork: stratResult.producedWork,
            durationMs: stratResult.durationMs,
          },
          realtime: { 
            success: rtResult.success, 
            producedWork: rtResult.producedWork,
            durationMs: rtResult.durationMs,
          },
          totalMs: Date.now() - cycleStart,
        })

        // Update engine state to show it's "running" (even though it's stateless)
        await client.hset(`trade_engine_state:${conn.id}`, {
          status: "running",
          last_cron_cycle: new Date().toISOString(),
          engine_mode: "serverless",
        })
      } catch (error) {
        results.push({
          connectionId: conn.id,
          connectionName: conn.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await client.del(LOCK_KEY).catch(() => {})

    return NextResponse.json({
      ok: true,
      mode: engineMode,
      ms: Date.now() - started,
      connectionsProcessed: activeConnections.length,
      results,
    })
  } catch (err) {
    console.error("[EngineAutoStartCron] Fatal:", err)
    await client.del(LOCK_KEY).catch(() => {})
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
        mode: getEngineMode(),
      },
      { status: 500 },
    )
  }
}

export async function POST() {
  return GET()
}