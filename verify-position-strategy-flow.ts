import { StrategyCoordinator } from './lib/strategy-coordinator'
import { PositionManager } from './lib/position-manager'
import { ProgressionStateManager } from './lib/progression-state-manager'

async function verifyPositionCycleUpdates() {
  console.log('🔍 Verifying Position Updates/Closing on Cycles...')

  // Test position manager update logic
  const pm = new PositionManager()

  // Mock position data
  const testPositionId = 999
  const mockUpdate = {
    current_price: 50000,
    unrealized_pnl: 100
  }

  try {
    await pm.updatePosition(testPositionId, mockUpdate)
    console.log('✅ Position update logic operational')
  } catch (error) {
    console.log('❌ Position update failed:', error instanceof Error ? error.message : String(error))
  }

  // Test stop loss/take profit checking
  try {
    const closed = await pm.checkStopLossAndTakeProfit(testPositionId)
    console.log(`✅ Stop loss/take profit check: ${closed ? 'triggered' : 'no action'}`)
  } catch (error) {
    console.log('❌ Stop loss/take profit check failed:', error instanceof Error ? error.message : String(error))
  }
}

async function verifyStrategyProgression() {
  console.log('🔍 Verifying Strategy Main Stage Progression...')

  const coordinator = new StrategyCoordinator('test-conn')

  // Mock indication data
  const mockIndications = [
    { type: 'direction', metadata: { direction: 'long' }, confidence: 0.8, profitFactor: 1.5 },
    { type: 'direction', metadata: { direction: 'short' }, confidence: 0.7, profitFactor: 1.3 }
  ]

  try {
    const results = await coordinator.executeStrategyFlow('BTCUSDT', mockIndications, true)
    console.log('✅ Strategy flow executed successfully')

    // Check if Base → Main progression happened
    const baseResult = results.find(r => r.type === 'base')
    const mainResult = results.find(r => r.type === 'main')

    if (baseResult && mainResult) {
      console.log(`✅ Base sets created: ${baseResult.passedEvaluation}`)
      console.log(`✅ Main sets created: ${mainResult.passedEvaluation}`)
      console.log(`✅ Progression: Base (${baseResult.passedEvaluation}) → Main (${mainResult.passedEvaluation})`)
    }
  } catch (error) {
    console.log('❌ Strategy progression failed:', error instanceof Error ? error.message : String(error))
  }
}

async function verifyCoordination() {
  console.log('🔍 Verifying Coordination and Performance...')

  try {
    // Check progression state
    const state = await ProgressionStateManager.getProgressionState('test-conn')
    console.log('✅ Progression state accessible')
    console.log(`   Cycles completed: ${state.cyclesCompleted}`)
    console.log(`   Strategy sets: Base=${state.strategiesBaseTotal}, Main=${state.strategiesMainTotal}`)

    // Check position coordination metrics
    console.log(`   Main position counts: prev=${state.mainPrevPosCount}, last=${state.mainLastPosCount}, cont=${state.mainContinuousCount}`)
  } catch (error) {
    console.log('❌ Coordination check failed:', error instanceof Error ? error.message : String(error))
  }
}

async function runVerification() {
  console.log('🚀 Starting Position/Strategy Verification...\n')

  await verifyPositionCycleUpdates()
  console.log('')

  await verifyStrategyProgression()
  console.log('')

  await verifyCoordination()
  console.log('')

  console.log('✅ Verification complete')
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runVerification().catch(console.error)
}

export { runVerification }