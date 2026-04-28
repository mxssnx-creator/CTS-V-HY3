#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev Progression Smoke Test — 1 symbol, "most volatile" arrangement.
 *
 * CommonJS so the v0 sandbox `executeScript` runner (which uses plain
 * `node`, NOT `node --experimental-modules` and not `bun`) can run it
 * without needing `"type": "module"` in package.json.
 *
 * Verifies the dev server (http://localhost:3002) is healthy after the
 * `node:`-scheme / `crypto`-resolution fixes in `next.config.mjs` and
 * exercises an end-to-end progression cycle with the spec-mandated
 * single-symbol / most-volatile selection.
 *
 * Steps:
 *   1. GET  /api/health
 *   2. POST /api/settings   — switch to {arrangementType: "marketVolatility",
 *                                         numberOfSymbolsToSelect: 1,
 *                                         useMainSymbols: false} and enable
 *                              the multi-step trailing matrix.
 *   3. POST /api/trade-engine/quick-start
 *   4. Poll /api/system/monitoring,
 *           /api/settings/connections/test/log,
 *           /api/trade-engine/status   every 5s up to 60s.
 *
 * Writes a summary to `dev-progression-1symbol-results.json` and exits
 * non-zero on any FAIL so CI / preview can detect regressions.
 */

const fs = require("node:fs/promises")
const { setTimeout: sleep } = require("node:timers/promises")

const BASE = process.env.DEV_BASE_URL || "http://localhost:3002"
const TOTAL_POLL_MS = Number(process.env.POLL_MS || 60_000)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5_000)

const issues = []
function record(kind, msg, extra) {
  issues.push({ kind, msg, extra, at: new Date().toISOString() })
  console.log(`[${kind}] ${msg}`, extra ? JSON.stringify(extra) : "")
}

async function jget(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { "cache-control": "no-cache" } })
  const text = await r.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* leave raw */ }
  return { status: r.status, ok: r.ok, body }
}

async function jpost(path, payload) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-cache" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const text = await r.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* leave raw */ }
  return { status: r.status, ok: r.ok, body }
}

async function main() {
  console.log(`▶ Dev progression smoke test → ${BASE}`)
  console.log(`  Started: ${new Date().toISOString()}\n`)

  // 1 — health
  const health = await jget("/api/health").catch((e) => ({ status: 0, ok: false, body: String(e) }))
  if (!health.ok) {
    record("FAIL", "health probe failed — dev server not responsive", health)
    return finish(1)
  }
  record("OK", "health probe passed", { status: health.status })

  // 2 — settings: 1 symbol, most volatile, trailing matrix on
  const settingsPayload = {
    arrangementType: "marketVolatility",
    numberOfSymbolsToSelect: 1,
    useMainSymbols: false,
    forced_symbols: [],
    forcedSymbols: [],
    strategyBaseTrailingEnabled: true,
    strategyBaseTrailingVariants: [
      "0.3:0.1", "0.3:0.2", "0.3:0.3", "0.3:0.4", "0.3:0.5",
      "0.6:0.1", "0.6:0.2", "0.6:0.3", "0.6:0.4", "0.6:0.5",
      "0.9:0.1", "0.9:0.2", "0.9:0.3", "0.9:0.4", "0.9:0.5",
      "1.2:0.1", "1.2:0.2", "1.2:0.3", "1.2:0.4", "1.2:0.5",
      "1.5:0.1", "1.5:0.2", "1.5:0.3", "1.5:0.4", "1.5:0.5",
    ],
  }
  const settingsRes = await jpost("/api/settings", settingsPayload)
    .catch((e) => ({ status: 0, ok: false, body: String(e) }))
  if (!settingsRes.ok) {
    record("FAIL", "settings POST failed", settingsRes)
    return finish(1)
  }
  record("OK", "settings persisted (1 symbol / marketVolatility / multi-trail on)")

  // 3 — quick-start
  const qs = await jpost("/api/trade-engine/quick-start")
    .catch((e) => ({ status: 0, ok: false, body: String(e) }))
  if (!qs.ok && qs.status !== 409) {
    // 409 acceptable: engine already running
    record("WARN", "quick-start non-OK (continuing)", qs)
  } else {
    record("OK", "quick-start kicked off", { status: qs.status })
  }

  // 4 — poll
  console.log(`\n▶ Polling for ${TOTAL_POLL_MS / 1000}s every ${POLL_INTERVAL_MS / 1000}s\n`)
  const checks = []
  const startedAt = Date.now()
  let lastCycles = 0

  while (Date.now() - startedAt < TOTAL_POLL_MS) {
    const [mon, log, status] = await Promise.all([
      jget("/api/system/monitoring").catch((e) => ({ status: 0, ok: false, body: String(e) })),
      jget("/api/settings/connections/test/log").catch((e) => ({ status: 0, ok: false, body: String(e) })),
      jget("/api/trade-engine/status").catch((e) => ({ status: 0, ok: false, body: String(e) })),
    ])

    if (!mon.ok) record("WARN", "monitoring non-OK", { status: mon.status })
    if (!log.ok) record("WARN", "log endpoint non-OK", { status: log.status })
    if (!status.ok) record("WARN", "engine status non-OK", { status: status.status })

    const cycles = Number(log.body?.summary?.enginePerformance?.cyclesCompleted || 0)
    const symbolsProcessed = Number(log.body?.summary?.prehistoricData?.symbolsProcessed || 0)
    const indications = Object.values(log.body?.summary?.indicationsCounts || {})
      .reduce((a, b) => Number(a) + Number(b || 0), 0)

    const elapsedS = Math.round((Date.now() - startedAt) / 1000)
    console.log(
      `  t+${String(elapsedS).padStart(3, " ")}s | ` +
      `cycles=${cycles} (+${cycles - lastCycles}) | ` +
      `symbols=${symbolsProcessed} | ind=${indications} | ` +
      `cpu=${mon.body?.cpu ?? "?"}% mem=${mon.body?.memory ?? "?"}%`,
    )
    lastCycles = cycles
    checks.push({
      at: new Date().toISOString(),
      cycles, symbolsProcessed, indications,
      cpu: mon.body?.cpu, mem: mon.body?.memory,
      engineStatus: status.body,
    })

    await sleep(POLL_INTERVAL_MS)
  }

  // ── final summary ──
  const finalLog = await jget("/api/settings/connections/test/log")
    .catch((e) => ({ status: 0, ok: false, body: String(e) }))
  const finalSummary = finalLog.body?.summary

  const summary = {
    base: BASE,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    arrangement: { arrangementType: "marketVolatility", numberOfSymbolsToSelect: 1 },
    final: finalSummary,
    checks,
    issues,
  }
  await fs.writeFile("dev-progression-1symbol-results.json", JSON.stringify(summary, null, 2))

  console.log("\n────────── RESULT ──────────")
  console.log(JSON.stringify({
    cycles: finalSummary?.enginePerformance?.cyclesCompleted ?? null,
    avgCycleMs: finalSummary?.enginePerformance?.cycleTimeMs ?? null,
    successRatePct: finalSummary?.enginePerformance?.cycleSuccessRate ?? null,
    symbolsProcessed: finalSummary?.prehistoricData?.symbolsProcessed ?? null,
    indications: Object.values(finalSummary?.indicationsCounts || {})
      .reduce((a, b) => Number(a) + Number(b || 0), 0),
    issuesCount: issues.length,
    issues,
  }, null, 2))

  const fatal = issues.some((i) => i.kind === "FAIL")
  return finish(fatal ? 1 : 0)
}

function finish(code) {
  console.log(`\n✔ Done. Exit code: ${code}`)
  process.exit(code)
}

main().catch((err) => {
  console.error("UNCAUGHT:", err)
  process.exit(2)
})
