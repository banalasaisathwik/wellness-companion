import assert from 'node:assert/strict'
import test from 'node:test'
import { updateTranscript } from '../src/conversation.ts'

test('one user bubble follows partial updates through the final segment', () => {
  let messages = updateTranscript([], 'segment-1', 'user', { id: 'segment-1', text: 'I have been', final: false })
  messages = updateTranscript(messages, 'segment-1', 'user', { id: 'segment-1', text: 'I have been feeling', final: false })
  messages = updateTranscript(messages, 'segment-1', 'user', { id: 'segment-1', text: 'I have been feeling stressed', final: true })
  messages = updateTranscript(messages, 'segment-1', 'user', { id: 'segment-1', text: 'I have been', final: false })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, 'I have been feeling stressed')
  assert.equal(messages[0].final, true)
})

test('two finalized segments in one turn stay together; the next turn gets a new bubble', () => {
  let messages = updateTranscript([], 'segment-1', 'user', { id: 'segment-1', text: 'I have an interview', final: true })
  messages = updateTranscript(messages, 'segment-1', 'user', { id: 'segment-2', text: 'tomorrow', final: true })
  messages = updateTranscript(messages, 'segment-3', 'user', { id: 'segment-3', text: 'Mostly system design', final: true })
  assert.deepEqual(messages.map(({ id, text }) => ({ id, text })), [
    { id: 'segment-1', text: 'I have an interview tomorrow' },
    { id: 'segment-3', text: 'Mostly system design' },
  ])
})

test('a late known segment changes only its own older bubble', () => {
  let messages = updateTranscript([], 'segment-1', 'user', { id: 'segment-1', text: 'Earlier', final: false })
  messages = updateTranscript(messages, 'segment-2', 'user', { id: 'segment-2', text: 'Current', final: true })
  messages = updateTranscript(messages, 'segment-1', 'user', { id: 'segment-1', text: 'Earlier final', final: true })
  assert.equal(messages[0].text, 'Earlier final')
  assert.equal(messages[1].text, 'Current')
})

test('a final segment can complete a user bubble after its commit event', () => {
  let messages = updateTranscript([], 'segment-1', 'user', { id: 'segment-1', text: 'Almost', final: false })
  messages = [{ ...messages[0], itemId: 'item-1', final: true }]
  messages = updateTranscript(messages, 'segment-1', 'user', { id: 'segment-1', text: 'Complete thought', final: true })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, 'Complete thought')
  assert.equal(messages[0].final, true)
})

test('assistant streaming updates one bubble and keeps user text separate', () => {
  let messages = updateTranscript([], 'user-1', 'user', { id: 'user-1', text: 'Hello', final: true })
  messages = updateTranscript(messages, 'agent-1', 'assistant', { id: 'agent-1', text: 'That sounds', final: false })
  messages = updateTranscript(messages, 'agent-1', 'assistant', { id: 'agent-1', text: 'That sounds difficult', final: true })
  assert.deepEqual(messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'That sounds difficult' },
  ])
})
