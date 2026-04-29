import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { getAllConnections, getRedisClient, initRedis } from "@/lib/redis-db"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { hasConnectionCredentials, isConnectionMainProcessing, isTruthyFlag } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Cron job to synchronize trade engine state with enabled connections.
 * Runs every 2 minutes to check for missing engines that should be started.
 */
export async function GET() {
  const started = Date.now()
  await initRedis()
  const client = getRedisClient()

  // Overlap guard: prevent multiple instances from running simultaneously
  const LOCK_KEY = "cron:engine-auto-start:lock"
  const acquired = await client.set(LOCK_KEY, "1", { EX: 55, NX: true })
  if (!acquired) {
    return NextResponse.json({ ok: true, skipped: true, reason: "previous run still active" })
  }

  try {
    // Check if Global Trade Engine Coordinator is running
    const globalState = await client.hgetall("trade_engine:global")
    if (globalState?.status !== "running") {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "global trade engine not running"
      })
    }

    const connections = await getAllConnections()
    if (!Array.isArray(connections)) {
      return NextResponse.json({
        ok: false,
        error: "failed to load connections"
      })
    }

    // Find connections that should be running but don't have engines
    const connectionsThatShouldBeRunning = connections.filter((c) => {
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
        message: "no connections require engine startup"
      })
    }

    // Load settings for engine configuration
    let settings
    try {
      settings = await loadSettingsAsync()
    } catch {
      settings = {}
    }

    // Start missing engines
    const coordinator = getGlobalTradeEngineCoordinator()
    const startedCount = await coordinator.startMissingEngines(connectionsThatShouldBeRunning)

    await client.del(LOCK_KEY).catch(() => {})

    return NextResponse.json({
      ok: true,
      ms: Date.now() - started,
      connectionsChecked: connectionsThatShouldBeRunning.length,
      enginesStarted: startedCount,
    })
  } catch (err) {
    console.error("[EngineAutoStartCron] Fatal:", err)
    await client.del(LOCK_KEY).catch(() => {})
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      },
      { status: 500 },
    )
  }
}

export async function POST() {
  return GET()
}