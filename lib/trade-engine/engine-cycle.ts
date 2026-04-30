/**
 * Engine Cycle Runner - Serverless-Compatible
 * 
 * This module extracts the engine cycle logic so it can be called
 * either from setTimeout loops (long-running mode) or directly from
 * cron jobs (serverless mode).
 * 
 * All state is persisted in Redis between invocations.
 */

import { getRedisClient, initRedis, getSettings, setSettings } from "@/lib/redis-db"
import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor } from "./strategy-processor"
import { RealtimeProcessor } from "./realtime-processor"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { engineMonitor } from "@/lib/engine-performance-monitor"
import { prefetchMarketDataBatch } from "./market-data-cache"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export interface CycleResult {
  success: boolean
  producedWork: boolean
  error?: string
  durationMs: number
}

/**
 * Run ONE cycle of indication processing
 * Returns true if work was done (indications were generated)
 */
export async function runIndicationCycle(connectionId: string): Promise<CycleResult> {
  const startTime = Date.now()
  let producedIndications = false
  
  try {
    await initRedis()
    const client = getRedisClient()
    
    // Check if prehistoric is done
    let prehistoricDone = false
    try {
      const v = await client.get(`prehistoric:${connectionId}:done`)
      prehistoricDone = v === "1"
    } catch {}
    
    // Get symbols
    const symbols = await getSymbolsForConnection(connectionId)
    if (!symbols || symbols.length === 0) {
      return { success: true, producedWork: false, durationMs: Date.now() - startTime }
    }
    
    // Prefetch market data
    await prefetchMarketDataBatch(symbols).catch(() => {})
    
    // Process indications
    const indicationProcessor = new IndicationProcessor(connectionId)
    const indicationResults = await Promise.all(
      symbols.map((symbol) =>
        indicationProcessor.processIndication(symbol).catch((err) => {
          console.error(`[v0] [Indication] Error for ${symbol}:`, err)
          return [] as any[]
        })
      )
    )
    
    const totalIndications = indicationResults.reduce((sum, arr) => sum + (arr?.length || 0), 0)
    producedIndications = totalIndications > 0
    
    // Write per-type counters
    if (producedIndications) {
      const indicationTypeCounts: Record<string, number> = {}
      for (const arr of indicationResults) {
        for (const ind of arr) {
          const t = (ind as any)?.type as string
          if (t) {
            indicationTypeCounts[t] = (indicationTypeCounts[t] || 0) + 1
          }
        }
      }
      
      const redisKey = `progression:${connectionId}`
      const writes: Promise<any>[] = [
        client.hincrby(redisKey, "indication_live_cycle_count", 1),
        client.hincrby(redisKey, "indications_count", totalIndications),
      ]
      for (const [type, count] of Object.entries(indicationTypeCounts)) {
        writes.push(client.hincrby(redisKey, `indications_${type}_count`, count))
      }
      await Promise.all(writes)
      
      // Increment cycle count
      await ProgressionStateManager.incrementCycle(connectionId, true, totalIndications)
    }
    
    // Update heartbeat
    await setSettings(`trade_engine_state:${connectionId}`, {
      last_indication_run: new Date().toISOString(),
      last_processor_heartbeat: Date.now(),
    }).catch(() => {})
    
    return { success: true, producedWork: producedIndications, durationMs: Date.now() - startTime }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[v0] [IndicationCycle] Error:`, errorMsg)
    await logProgressionEvent(connectionId, "indications", "error", `Cycle error: ${errorMsg}`).catch(() => {})
    return { success: false, producedWork: false, error: errorMsg, durationMs: Date.now() - startTime }
  }
}

/**
 * Run ONE cycle of strategy processing
 */
export async function runStrategyCycle(connectionId: string): Promise<CycleResult> {
  const startTime = Date.now()
  let producedStrategies = false
  
  try {
    await initRedis()
    const client = getRedisClient()
    
    // Check if prehistoric is done
    let prehistoricDone = false
    try {
      const v = await client.get(`prehistoric:${connectionId}:done`)
      prehistoricDone = v === "1"
    } catch {}
    
    const symbols = await getSymbolsForConnection(connectionId)
    if (!symbols || symbols.length === 0) {
      return { success: true, producedWork: false, durationMs: Date.now() - startTime }
    }
    
    const strategyProcessor = new StrategyProcessor(connectionId)
    const strategyResults = await Promise.all(
      symbols.map((symbol) =>
        strategyProcessor.processStrategy(symbol).catch(() => ({ strategiesEvaluated: 0, liveReady: 0 }))
      )
    )
    
    const evaluatedThisCycle = strategyResults.reduce((sum, result) => sum + ((result as any)?.strategiesEvaluated || 0), 0)
    producedStrategies = evaluatedThisCycle > 0
    
    if (producedStrategies) {
      const redisKey = `progression:${connectionId}`
      await Promise.all([
        client.hincrby(redisKey, "strategy_live_cycle_count", 1),
        client.hincrby(redisKey, "strategies_count", evaluatedThisCycle),
      ])
      
      await ProgressionStateManager.incrementCycle(connectionId, true, evaluatedThisCycle)
    }
    
    await setSettings(`trade_engine_state:${connectionId}`, {
      last_strategy_run: new Date().toISOString(),
      last_processor_heartbeat: Date.now(),
    }).catch(() => {})
    
    return { success: true, producedWork: producedStrategies, durationMs: Date.now() - startTime }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[v0] [StrategyCycle] Error:`, errorMsg)
    return { success: false, producedWork: false, error: errorMsg, durationMs: Date.now() - startTime }
  }
}

/**
 * Run ONE cycle of realtime processing
 */
export async function runRealtimeCycle(connectionId: string): Promise<CycleResult> {
  const startTime = Date.now()
  let producedWork = false
  
  try {
    await initRedis()
    const client = getRedisClient()
    
    const realtimeProcessor = new RealtimeProcessor(connectionId)
    const rtResult: any = await realtimeProcessor.processRealtimeUpdates()
    
    if (rtResult && typeof rtResult === "object") {
      const updates = Number(rtResult.updates ?? rtResult.processed ?? rtResult.positionsUpdated ?? 0)
      if (updates > 0) producedWork = true
    }
    
    if (producedWork) {
      const redisKey = `progression:${connectionId}`
      await Promise.all([
        client.hincrby(redisKey, "realtime_live_cycle_count", 1),
      ])
      
      await ProgressionStateManager.incrementCycle(connectionId, true, 0)
    }
    
    await setSettings(`trade_engine_state:${connectionId}`, {
      last_realtime_run: new Date().toISOString(),
      last_processor_heartbeat: Date.now(),
    }).catch(() => {})
    
    return { success: true, producedWork, durationMs: Date.now() - startTime }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[v0] [RealtimeCycle] Error:`, errorMsg)
    return { success: false, producedWork: false, error: errorMsg, durationMs: Date.now() - startTime }
  }
}

/**
 * Run ALL cycles for a connection (indications + strategies + realtime)
 * This is what the cron job should call in serverless mode
 */
export async function runAllCycles(connectionId: string): Promise<{
  indication: CycleResult
  strategy: CycleResult
  realtime: CycleResult
}> {
  const [indication, strategy, realtime] = await Promise.all([
    runIndicationCycle(connectionId),
    runStrategyCycle(connectionId),
    runRealtimeCycle(connectionId),
  ])
  
  return { indication, strategy, realtime }
}

/**
 * Get symbols for a connection
 */
async function getSymbolsForConnection(connectionId: string): Promise<string[]> {
  try {
    const { getConnection } = await import("@/lib/redis-db")
    const conn = await getConnection(connectionId)
    if (!conn) return []
    
    // Try to get symbols from connection settings
    const symbolsStr = (conn as any).symbols || (conn as any).symbol_list
    if (symbolsStr) {
      if (typeof symbolsStr === "string") {
        return symbolsStr.split(",").map((s: string) => s.trim()).filter(Boolean)
      }
      if (Array.isArray(symbolsStr)) return symbolsStr
    }
    
    // Default fallback
    return ["DRIFTUSDT"]
  } catch {
    return ["DRIFTUSDT"]
  }
}
