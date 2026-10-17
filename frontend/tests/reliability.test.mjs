import assert from 'node:assert/strict'
import test from 'node:test'
import { belongsToSession, mergeTurnMetrics, selectAssistantItem, slowestStage, updateRecentTurns } from '../src/reliability.ts'

test('a late item cannot replace a newer speech or revive an interrupted item', () => {
  const interrupted = { itemId: 'item-1', speechId: 'speech-1', sequence: 1, text: 'Old', interrupted: true }
  const final = { itemId: 'item-2', speechId: 'speech-2', sequence: 2, text: 'Listen', interrupted: false }
  assert.equal(selectAssistantItem(null, interrupted, 2), null)
  assert.deepEqual(selectAssistantItem(final, interrupted, 2), final)
  assert.deepEqual(selectAssistantItem(interrupted, { ...interrupted, interrupted: false }, 1), interrupted)
  assert.deepEqual(selectAssistantItem(interrupted, { ...interrupted, itemId: 'item-1b', interrupted: false }, 1), interrupted)
  assert.deepEqual(selectAssistantItem(interrupted, final, 2), final)
})

test('late and partial metrics stay with their assistant item', () => {
  const latencies = new Map()
  let latest = mergeTurnMetrics(latencies, null, 'item-1', 1, true, { responseLatency: 0.8 })
  latest = mergeTurnMetrics(latencies, latest.latestCompleted, 'item-2', 2, true, { llmFirstToken: 0.2 })
  const late = mergeTurnMetrics(latencies, latest.latestCompleted, 'item-1', 1, true, { ttsFirstAudio: 1.5 })
  assert.equal(late.visibleLatency, null)
  assert.deepEqual(latencies.get('item-1'), { responseLatency: 0.8, ttsFirstAudio: 1.5 })
  assert.deepEqual(latencies.get('item-2'), { llmFirstToken: 0.2 })
  const partial = mergeTurnMetrics(latencies, late.latestCompleted, 'item-2', 2, true, { ttsFirstAudio: 0.6 })
  assert.deepEqual(partial.visibleLatency, { llmFirstToken: 0.2, ttsFirstAudio: 0.6 })
})

test('a fresh room starts with empty ownership and metrics', () => {
  assert.equal(belongsToSession('old-room', 'new-room'), false)
  assert.equal(belongsToSession('new-room', 'new-room'), true)
  const newRoomLatencies = new Map()
  const result = mergeTurnMetrics(newRoomLatencies, null, 'item-new', 1, true, { responseLatency: 0.4 })
  assert.deepEqual(result.latestCompleted, { itemId: 'item-new', sequence: 1 })
  assert.equal(newRoomLatencies.has('item-1'), false)
})

test('a late older snapshot updates its history row without replacing the newest turn', () => {
  let turns = updateRecentTurns([], { itemId: 'item-1', speechId: 'speech-1', userItemId: 'user-1', sequence: 1, latency: { responseLatency: 1.4 } })
  turns = updateRecentTurns(turns, { itemId: 'item-2', speechId: 'speech-2', sequence: 2, latency: { responseLatency: 0.7 } })
  turns = updateRecentTurns(turns, { itemId: 'item-1', speechId: 'speech-1', sequence: 1, latency: { responseLatency: 1.4, ttsFirstAudio: 0.3 } })
  assert.deepEqual(turns.map((turn) => turn.itemId), ['item-2', 'item-1'])
  assert.equal(turns[0].latency.responseLatency, 0.7)
  assert.equal(turns[1].userItemId, 'user-1')
  assert.equal(turns[1].latency.ttsFirstAudio, 0.3)
  assert.equal(turns[1].additionalUpdates, 1)
})

test('slowest stage compares independent timings and gives a deterministic hint', () => {
  assert.deepEqual(slowestStage({}), null)
  assert.equal(slowestStage({ turnDetection: 0.8, finalTranscript: 0.7, llmFirstToken: 0.2, ttsFirstAudio: 0.1 })?.label, 'Turn detection')
  assert.match(slowestStage({ turnDetection: 0.8, finalTranscript: 0.7 })?.hint ?? '', /STT finalization/)
  assert.equal(slowestStage({ turnDetection: 0.2, llmFirstToken: 0.9, ttsFirstAudio: 0.15 })?.label, 'LLM first token')
  assert.equal(slowestStage({ turnProcessing: 0.9, agentLogicMetrics: { jevClassification: 0.8 } })?.label, 'Turn processing')
})

test('late agent logic updates merge into their owning turn without replacing native metrics', () => {
  const latencies = new Map()
  let latest = mergeTurnMetrics(latencies, null, 'assistant-1', 1, true,
    { turnProcessing: 3.2, responseLatency: 5.1 })
  latest = mergeTurnMetrics(latencies, latest.latestCompleted, 'assistant-2', 2, true,
    { turnProcessing: 2.1, responseLatency: 3.8 })
  const late = mergeTurnMetrics(latencies, latest.latestCompleted, 'assistant-1', 1, true,
    { agentLogicMetrics: { jevClassification: 3.1, stateParsing: 0.002 } })
  mergeTurnMetrics(latencies, late.latestCompleted, 'assistant-1', 1, true,
    { agentLogicMetrics: { strategySelection: 0.0003 } })
  assert.equal(late.visibleLatency, null)
  assert.deepEqual(latencies.get('assistant-1'), {
    turnProcessing: 3.2, responseLatency: 5.1,
    agentLogicMetrics: { jevClassification: 3.1, stateParsing: 0.002, strategySelection: 0.0003 },
  })
  assert.deepEqual(latencies.get('assistant-2'), { turnProcessing: 2.1, responseLatency: 3.8 })
})
