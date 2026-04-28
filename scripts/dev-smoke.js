#!/usr/bin/env node
/**
 * Minimal dev-server smoke test (≤ 5s).
 *
 * Verifies (a) the dev server at http://localhost:3002 is up after the
 * `node:`-scheme / Edge-runtime alias fixes in `next.config.mjs`, and
 * (b) the new multi-step trailing settings keys round-trip through
 * /api/settings without erroring.
 */
async function main() {
  const BASE = "http://localhost:3002"

  // 1 — health
  let health
  try {
    const r = await fetch(`${BASE}/api/health`, { headers: { "cache-control": "no-cache" } })
    health = { status: r.status, ok: r.ok, body: await r.text() }
  } catch (err) {
    console.log(JSON.stringify({ step: "health", error: String(err) }))
    process.exit(1)
  }
  console.log("HEALTH:", health.status, health.body.slice(0, 200))

  // 2 — POST settings (just the new keys; merge semantics)
  let saved
  try {
    const r = await fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "cache-control": "no-cache" },
      body: JSON.stringify({
        settings: {
          arrangementType: "marketVolatility",
          numberOfSymbolsToSelect: 1,
          useMainSymbols: false,
          strategyBaseTrailingEnabled: true,
          strategyBaseTrailingVariants: [
            "0.3:0.1", "0.6:0.2", "0.9:0.3", "1.2:0.4", "1.5:0.5",
          ],
        },
      }),
    })
    saved = { status: r.status, ok: r.ok, body: (await r.text()).slice(0, 300) }
  } catch (err) {
    console.log(JSON.stringify({ step: "settings.put", error: String(err) }))
    process.exit(1)
  }
  console.log("SETTINGS PUT:", saved.status, saved.body)

  // 3 — verify round-trip
  let read
  try {
    const r = await fetch(`${BASE}/api/settings`)
    const body = await r.json()
    read = {
      status: r.status,
      arrangementType: body?.settings?.arrangementType,
      numberOfSymbolsToSelect: body?.settings?.numberOfSymbolsToSelect,
      strategyBaseTrailingEnabled: body?.settings?.strategyBaseTrailingEnabled,
      variantsLen: Array.isArray(body?.settings?.strategyBaseTrailingVariants)
        ? body.settings.strategyBaseTrailingVariants.length
        : null,
    }
  } catch (err) {
    console.log(JSON.stringify({ step: "settings.get", error: String(err) }))
    process.exit(1)
  }
  console.log("SETTINGS GET:", JSON.stringify(read))

  const pass =
    health.ok &&
    saved.ok &&
    read.arrangementType === "marketVolatility" &&
    read.numberOfSymbolsToSelect === 1 &&
    read.strategyBaseTrailingEnabled === true &&
    read.variantsLen === 5

  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL")
  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error("UNCAUGHT:", err)
  process.exit(2)
})
