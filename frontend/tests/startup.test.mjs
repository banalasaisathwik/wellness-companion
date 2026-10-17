import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ConnectionState, RoomEvent } from 'livekit-client'
import { waitForAgentReady } from '../src/voice/session.ts'

function connectedRoom() {
  const room = new EventEmitter()
  room.state = ConnectionState.Connected
  room.remoteParticipants = new Map()
  return room
}

const signal = () => new AbortController().signal

test('an already listening agent completes startup without a future event', async () => {
  const room = connectedRoom()
  room.remoteParticipants.set('agent', { isAgent: true, attributes: { 'lk.agent.state': 'listening' } })
  await waitForAgentReady(room, signal())
  assert.equal(room.listenerCount(RoomEvent.ParticipantAttributesChanged), 0)
})

test('a connected room waits through agent join and initialization', async () => {
  const room = connectedRoom()
  let ready = false
  const waiting = waitForAgentReady(room, signal()).then(() => { ready = true })
  const visitor = { isAgent: false, attributes: { 'lk.agent.state': 'listening' } }
  room.remoteParticipants.set('visitor', visitor)
  room.emit(RoomEvent.ParticipantConnected, visitor)
  await Promise.resolve()
  assert.equal(ready, false)

  const agent = { isAgent: true, attributes: { 'lk.agent.state': 'initializing' } }
  room.remoteParticipants.set('agent', agent)
  room.emit(RoomEvent.ParticipantConnected, agent)
  await Promise.resolve()
  assert.equal(ready, false)

  agent.attributes['lk.agent.state'] = 'listening'
  room.emit(RoomEvent.ParticipantAttributesChanged, agent.attributes, agent)
  await waiting
  assert.equal(ready, true)
  assert.equal(room.listenerCount(RoomEvent.ParticipantConnected), 0)
  assert.equal(room.listenerCount(RoomEvent.ParticipantAttributesChanged), 0)
})

test('disconnecting while waiting rejects and removes readiness listeners', async () => {
  const room = connectedRoom()
  const waiting = waitForAgentReady(room, signal())
  room.state = ConnectionState.Disconnected
  room.emit(RoomEvent.Disconnected)
  await assert.rejects(waiting, /disconnected/)
  assert.equal(room.listenerCount(RoomEvent.ParticipantAttributesChanged), 0)
  assert.equal(room.listenerCount(RoomEvent.Disconnected), 0)
})

test('cancelling a failed attempt removes listeners before a retry', async () => {
  const oldRoom = connectedRoom()
  const abortController = new AbortController()
  const waiting = waitForAgentReady(oldRoom, abortController.signal)
  abortController.abort()
  await assert.rejects(waiting)
  assert.equal(oldRoom.listenerCount(RoomEvent.ParticipantConnected), 0)
  assert.equal(oldRoom.listenerCount(RoomEvent.ParticipantAttributesChanged), 0)

  const newRoom = connectedRoom()
  newRoom.remoteParticipants.set('agent', { isAgent: true, attributes: { 'lk.agent.state': 'listening' } })
  await waitForAgentReady(newRoom, signal())
})
