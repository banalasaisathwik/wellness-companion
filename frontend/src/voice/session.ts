import { ConnectionState, type Participant, type RemoteTrack, type RemoteTrackPublication, Room, RoomEvent, type TranscriptionSegment } from 'livekit-client'

export function waitForAgentReady(room: Room, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const agentIsListening = () => room.state === ConnectionState.Connected
      && [...room.remoteParticipants.values()].some((participant) =>
        participant.isAgent && participant.attributes['lk.agent.state'] === 'listening')
    const cleanup = () => {
      room.off(RoomEvent.ParticipantConnected, check)
      room.off(RoomEvent.ParticipantAttributesChanged, check)
      room.off(RoomEvent.Disconnected, disconnected)
      signal.removeEventListener('abort', cancelled)
    }
    const check = () => {
      if (!agentIsListening()) return
      cleanup()
      resolve()
    }
    const disconnected = () => {
      cleanup()
      reject(new Error('Room disconnected while waiting for Luna.'))
    }
    const cancelled = () => {
      cleanup()
      reject(signal.reason)
    }
    room.on(RoomEvent.ParticipantConnected, check)
    room.on(RoomEvent.ParticipantAttributesChanged, check)
    room.on(RoomEvent.Disconnected, disconnected)
    signal.addEventListener('abort', cancelled, { once: true })
    check()
  })
}

export type SessionCredentials = { server_url: string; token: string; room_name: string }

export function sanitizeError(message: string) {
  return message
    .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b((?:token|api[ _-]?secret)\s*[=:]\s*)\S+/gi, '$1[redacted]')
}

export function formatMicrophoneError(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone permission was denied.'
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone device was found.'
  if (error instanceof Error && /permission|notallowed/i.test(error.message)) return 'Microphone permission was denied.'
  return sanitizeError(error instanceof Error ? error.message : 'The microphone could not be enabled.')
}

export type RoomEventHandlers = {
  connectionStateChanged: (state: ConnectionState) => void
  participantChanged: () => void
  microphonePublicationChanged: () => void
  trackSubscribed: (track: RemoteTrack, publication: RemoteTrackPublication) => void
  trackUnsubscribed: (track: RemoteTrack) => void
  transcriptionReceived: (segments: TranscriptionSegment[], participant?: Participant) => void
  audioPlaybackStatusChanged: (playing: boolean) => void
  dataReceived: (payload: Uint8Array, participant?: unknown, kind?: unknown, topic?: string) => void
}

export function removeRoomEventListeners(room: Room, handlers: RoomEventHandlers | null) {
  if (!handlers) return
  room.off(RoomEvent.ConnectionStateChanged, handlers.connectionStateChanged)
  room.off(RoomEvent.ParticipantConnected, handlers.participantChanged)
  room.off(RoomEvent.ParticipantDisconnected, handlers.participantChanged)
  room.off(RoomEvent.TrackMuted, handlers.microphonePublicationChanged)
  room.off(RoomEvent.TrackUnmuted, handlers.microphonePublicationChanged)
  room.off(RoomEvent.LocalTrackPublished, handlers.microphonePublicationChanged)
  room.off(RoomEvent.LocalTrackUnpublished, handlers.microphonePublicationChanged)
  room.off(RoomEvent.TrackSubscribed, handlers.trackSubscribed)
  room.off(RoomEvent.TrackUnsubscribed, handlers.trackUnsubscribed)
  room.off(RoomEvent.TranscriptionReceived, handlers.transcriptionReceived)
  room.off(RoomEvent.AudioPlaybackStatusChanged, handlers.audioPlaybackStatusChanged)
  room.off(RoomEvent.DataReceived, handlers.dataReceived)
}

export async function requestSession(signal: AbortSignal): Promise<SessionCredentials | null> {
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
  const response = await fetch(`${apiBaseUrl}/session`, { method: 'POST', signal })
  if (!response.ok) throw new Error('The session could not be created.')
  const session = (await response.json()) as SessionCredentials
  if (signal.aborted) return null
  if (!session.server_url || !session.token || !session.room_name) throw new Error('Incomplete session response.')
  return session
}
