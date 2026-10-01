import assert from 'node:assert/strict'
import test from 'node:test'
import { belongsToSession, mergeTurnMetrics, selectAssistantItem } from '../src/reliability.ts'

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
  let latest = mergeTurnMetrics(latencies, null, 'item-1', 1, true, { llmDuration: 0.8 })
  latest = mergeTurnMetrics(latencies, latest.latestCompleted, 'item-2', 2, true, { llmFirstToken: 0.2 })
  const late = mergeTurnMetrics(latencies, latest.latestCompleted, 'item-1', 1, true, { ttsDuration: 1.5 })
  assert.equal(late.visibleLatency, null)
  assert.deepEqual(latencies.get('item-1'), { llmDuration: 0.8, ttsDuration: 1.5 })
  assert.deepEqual(latencies.get('item-2'), { llmFirstToken: 0.2 })
  const partial = mergeTurnMetrics(latencies, late.latestCompleted, 'item-2', 2, true, { ttsDuration: 0.6 })
  assert.deepEqual(partial.visibleLatency, { llmFirstToken: 0.2, ttsDuration: 0.6 })
})

test('a fresh room starts with empty ownership and metrics', () => {
  assert.equal(belongsToSession('old-room', 'new-room'), false)
  assert.equal(belongsToSession('new-room', 'new-room'), true)
  const newRoomLatencies = new Map()
  const result = mergeTurnMetrics(newRoomLatencies, null, 'item-new', 1, true, { llmDuration: 0.4 })
  assert.deepEqual(result.latestCompleted, { itemId: 'item-new', sequence: 1 })
  assert.equal(newRoomLatencies.has('item-1'), false)
})
