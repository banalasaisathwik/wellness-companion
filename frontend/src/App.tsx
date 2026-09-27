import { useEffect, useRef, useState } from 'react'
import { ConnectionState, Room, RoomEvent, Track } from 'livekit-client'
import './App.css'

type AudioMetrics = {
  participantIdentity: string
  trackSid: string
  frameCount: number
  sampleRate: number
  channels: number
  samplesPerChannel: number
  peakPcm: number
}

function isAudioMetricsMessage(message: unknown): message is {
  type: 'audio_metrics'
  participant_identity: string
  track_sid: string
  frame_count: number
  sample_rate: number
  channels: number
  samples_per_channel: number
  peak_pcm: number
} {
  if (typeof message !== 'object' || message === null) {
    return false
  }

  const values = message as Record<string, unknown>

  return (
    values.type === 'audio_metrics' &&
    typeof values.participant_identity === 'string' &&
    typeof values.track_sid === 'string' &&
    typeof values.frame_count === 'number' &&
    Number.isFinite(values.frame_count) &&
    typeof values.sample_rate === 'number' &&
    Number.isFinite(values.sample_rate) &&
    typeof values.channels === 'number' &&
    Number.isFinite(values.channels) &&
    typeof values.samples_per_channel === 'number' &&
    Number.isFinite(values.samples_per_channel) &&
    typeof values.peak_pcm === 'number' &&
    Number.isFinite(values.peak_pcm)
  )
}

function App() {
  const [backendStatus, setBackendStatus] = useState('Checking backend...')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [sessionStatus, setSessionStatus] = useState('No session created')
  const [roomName, setRoomName] = useState('')
  const [participantIdentity, setParticipantIdentity] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [token, setToken] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('Disconnected')
  const [connectionError, setConnectionError] = useState('')
  const [connectedRoomName, setConnectedRoomName] = useState('')
  const [localParticipantIdentity, setLocalParticipantIdentity] = useState('')
  const [remoteParticipantCount, setRemoteParticipantCount] = useState(0)
  const [microphoneStatus, setMicrophoneStatus] = useState('Microphone off')
  const [microphoneError, setMicrophoneError] = useState('')
  const [microphoneTrackSid, setMicrophoneTrackSid] = useState('')
  const [audioMetrics, setAudioMetrics] = useState<AudioMetrics | null>(null)
  const roomRef = useRef<Room | null>(null)
  const connectionAttemptRef = useRef<Room | null>(null)
  const microphoneRequestRoomRef = useRef<Room | null>(null)
  const roomEventHandlersRef = useRef<{
    connectionStateChanged: (state: ConnectionState) => void
    participantChanged: () => void
    microphonePublicationChanged: () => void
    dataReceived: (
      payload: Uint8Array,
      participant?: unknown,
      kind?: unknown,
      topic?: string,
    ) => void
  } | null>(null)
  const hasSessionConnectionDetails = Boolean(serverUrl && token)
  const roomIsActive =
    connectionStatus === 'Connecting' ||
    connectionStatus === 'Connected' ||
    connectionStatus === 'Reconnecting'

  function removeRoomEventListeners(room: Room) {
    const roomEventHandlers = roomEventHandlersRef.current

    if (!roomEventHandlers) {
      return
    }

    room.off(RoomEvent.ConnectionStateChanged, roomEventHandlers.connectionStateChanged)
    room.off(RoomEvent.ParticipantConnected, roomEventHandlers.participantChanged)
    room.off(RoomEvent.ParticipantDisconnected, roomEventHandlers.participantChanged)
    room.off(RoomEvent.TrackMuted, roomEventHandlers.microphonePublicationChanged)
    room.off(RoomEvent.TrackUnmuted, roomEventHandlers.microphonePublicationChanged)
    room.off(RoomEvent.LocalTrackPublished, roomEventHandlers.microphonePublicationChanged)
    room.off(RoomEvent.LocalTrackUnpublished, roomEventHandlers.microphonePublicationChanged)
    room.off(RoomEvent.DataReceived, roomEventHandlers.dataReceived)
    roomEventHandlersRef.current = null
  }

  function sanitizeConnectionErrorMessage(message: string) {
    return message
      .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '[redacted URL]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b((?:token|api[ _-]?secret)\s*[=:]\s*)\S+/gi, '$1[redacted]')
  }

  function resetMicrophoneState() {
    microphoneRequestRoomRef.current = null
    setMicrophoneStatus('Microphone off')
    setMicrophoneError('')
    setMicrophoneTrackSid('')
  }

  function resetAudioMetrics() {
    setAudioMetrics(null)
  }

  function syncMicrophoneState(room: Room) {
    const microphonePublication = room.localParticipant.getTrackPublication(Track.Source.Microphone)

    if (!microphonePublication?.track) {
      setMicrophoneStatus('Microphone off')
      setMicrophoneError('')
      setMicrophoneTrackSid('')
      return
    }

    setMicrophoneStatus(microphonePublication.isMuted ? 'Muted' : 'Publishing microphone')
    setMicrophoneError('')
    setMicrophoneTrackSid(microphonePublication.trackSid)
  }

  function formatMicrophoneError(error: unknown) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'Microphone permission was denied.'
    }

    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return 'No microphone device was found.'
    }

    if (error instanceof Error) {
      return error.message
    }

    return 'The microphone could not be enabled.'
  }

  useEffect(() => {
    const abortController = new AbortController()

    async function checkBackend() {
      setBackendStatus('Checking backend...')

      try {
        const response = await fetch('/api/health', {
          signal: abortController.signal,
        })

        if (!response.ok) {
          throw new Error('The health check failed.')
        }

        const health = (await response.json()) as { status?: string }

        if (health.status === 'ok') {
          setBackendStatus('Backend connected')
        } else {
          setBackendStatus('Backend unavailable')
        }
      } catch {
        if (!abortController.signal.aborted) {
          setBackendStatus('Backend unavailable')
        }
      }
    }

    void checkBackend()

    return () => abortController.abort()
  }, [retryAttempt])

  useEffect(() => {
    return () => {
      const room = roomRef.current

      if (!room) {
        return
      }

      removeRoomEventListeners(room)
      roomRef.current = null
      connectionAttemptRef.current = null
      microphoneRequestRoomRef.current = null
      void room.disconnect()
    }
  }, [])

  async function createSession() {
    setSessionStatus('Creating session...')
    setRoomName('')
    setParticipantIdentity('')
    setServerUrl('')
    setToken('')
    setConnectionStatus('Disconnected')
    setConnectionError('')
    setConnectedRoomName('')
    setLocalParticipantIdentity('')
    setRemoteParticipantCount(0)
    resetMicrophoneState()
    resetAudioMetrics()

    try {
      const response = await fetch('/api/session', { method: 'POST' })

      if (!response.ok) {
        throw new Error('The session could not be created.')
      }

      const session = (await response.json()) as {
        server_url: string
        token: string
        room_name: string
        participant_identity: string
      }

      setServerUrl(session.server_url)
      setToken(session.token)
      setRoomName(session.room_name)
      setParticipantIdentity(session.participant_identity)
      setSessionStatus('Session created')
    } catch {
      setSessionStatus('Unable to create a session. Check that the backend is available and configured.')
    }
  }

  async function connectRoom() {
    if (roomRef.current) {
      return
    }

    if (!serverUrl || !token) {
      setConnectionStatus('Connection failed')
      setConnectionError('Create a session before connecting.')
      return
    }

    const room = new Room()
    roomRef.current = room
    connectionAttemptRef.current = room
    setConnectionStatus('Connecting')
    setConnectionError('')

    const connectionStateChanged = (state: ConnectionState) => {
      if (roomRef.current !== room) {
        return
      }

      if (state === ConnectionState.Connecting) {
        setConnectionStatus('Connecting')
      } else if (state === ConnectionState.Connected) {
        setConnectionStatus('Connected')
        setConnectedRoomName(room.name)
        setLocalParticipantIdentity(room.localParticipant.identity)
        setRemoteParticipantCount(room.remoteParticipants.size)
        syncMicrophoneState(room)
      } else if (
        state === ConnectionState.Reconnecting ||
        state === ConnectionState.SignalReconnecting
      ) {
        setConnectionStatus('Reconnecting')
      } else if (state === ConnectionState.Disconnected) {
        if (connectionAttemptRef.current === room) {
          return
        }

        removeRoomEventListeners(room)
        roomRef.current = null
        setConnectionStatus('Disconnected')
        setConnectionError('The LiveKit room disconnected.')
        setConnectedRoomName('')
        setLocalParticipantIdentity('')
        setRemoteParticipantCount(0)
        resetMicrophoneState()
        resetAudioMetrics()
      }
    }

    const participantChanged = () => {
      if (roomRef.current === room) {
        setRemoteParticipantCount(room.remoteParticipants.size)
      }
    }

    const microphonePublicationChanged = () => {
      if (roomRef.current === room) {
        syncMicrophoneState(room)
      }
    }

    const dataReceived = (
      payload: Uint8Array,
      _participant?: unknown,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (roomRef.current !== room || topic !== 'audio_metrics') {
        return
      }

      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as unknown

        if (!isAudioMetricsMessage(message)) {
          return
        }

        setAudioMetrics({
          participantIdentity: message.participant_identity,
          trackSid: message.track_sid,
          frameCount: message.frame_count,
          sampleRate: message.sample_rate,
          channels: message.channels,
          samplesPerChannel: message.samples_per_channel,
          peakPcm: message.peak_pcm,
        })
      } catch {
        // Ignore malformed data messages from the room.
      }
    }

    roomEventHandlersRef.current = {
      connectionStateChanged,
      participantChanged,
      microphonePublicationChanged,
      dataReceived,
    }
    room.on(RoomEvent.ConnectionStateChanged, connectionStateChanged)
    room.on(RoomEvent.ParticipantConnected, participantChanged)
    room.on(RoomEvent.ParticipantDisconnected, participantChanged)
    room.on(RoomEvent.TrackMuted, microphonePublicationChanged)
    room.on(RoomEvent.TrackUnmuted, microphonePublicationChanged)
    room.on(RoomEvent.LocalTrackPublished, microphonePublicationChanged)
    room.on(RoomEvent.LocalTrackUnpublished, microphonePublicationChanged)
    room.on(RoomEvent.DataReceived, dataReceived)

    try {
      await room.connect(serverUrl, token)
      connectionAttemptRef.current = null

      if (roomRef.current !== room) {
        return
      }

      setConnectionStatus('Connected')
      setConnectedRoomName(room.name)
      setLocalParticipantIdentity(room.localParticipant.identity)
      setRemoteParticipantCount(room.remoteParticipants.size)
      syncMicrophoneState(room)
    } catch (error) {
      const sanitizedErrorMessage =
        error instanceof Error
          ? sanitizeConnectionErrorMessage(error.message)
          : 'LiveKit returned a non-Error connection failure.'
      if (connectionAttemptRef.current !== room) {
        return
      }

      connectionAttemptRef.current = null
      removeRoomEventListeners(room)
      roomRef.current = null
      resetMicrophoneState()
      resetAudioMetrics()
      void room.disconnect()
      setConnectionStatus('Connection failed')
      setConnectionError(sanitizedErrorMessage)
    }
  }

  function disconnectRoom() {
    const room = roomRef.current

    if (!room) {
      return
    }

    removeRoomEventListeners(room)
    roomRef.current = null
    connectionAttemptRef.current = null
    resetMicrophoneState()
    resetAudioMetrics()
    void room.disconnect()
    setConnectionStatus('Disconnected')
    setConnectionError('')
    setConnectedRoomName('')
    setLocalParticipantIdentity('')
    setRemoteParticipantCount(0)
  }

  async function enableMicrophone() {
    const room = roomRef.current

    if (
      !room ||
      room.state !== ConnectionState.Connected ||
      microphoneRequestRoomRef.current !== null
    ) {
      return
    }

    microphoneRequestRoomRef.current = room
    setMicrophoneStatus('Requesting microphone')
    setMicrophoneError('')
    setMicrophoneTrackSid('')

    try {
      const publication = await room.localParticipant.setMicrophoneEnabled(true)
      const microphonePublication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
      const requestIsCurrent =
        roomRef.current === room &&
        room.state === ConnectionState.Connected &&
        microphoneRequestRoomRef.current === room

      if (!requestIsCurrent) {
        publication?.track?.stop()
        microphonePublication?.track?.stop()
        return
      }

      if (!microphonePublication?.track || microphonePublication.isMuted) {
        throw new Error('LiveKit did not publish an active microphone track.')
      }

      microphoneRequestRoomRef.current = null
      syncMicrophoneState(room)
    } catch (error) {
      if (microphoneRequestRoomRef.current !== room || roomRef.current !== room) {
        return
      }

      microphoneRequestRoomRef.current = null
      setMicrophoneStatus('Error')
      setMicrophoneError(formatMicrophoneError(error))
    }
  }

  async function toggleMicrophoneMute() {
    const room = roomRef.current
    const microphonePublication = room?.localParticipant.getTrackPublication(Track.Source.Microphone)

    if (
      !room ||
      room.state !== ConnectionState.Connected ||
      !microphonePublication?.track ||
      microphoneRequestRoomRef.current !== null
    ) {
      return
    }

    const shouldEnableMicrophone = microphonePublication.isMuted
    microphoneRequestRoomRef.current = room
    setMicrophoneError('')

    try {
      await room.localParticipant.setMicrophoneEnabled(shouldEnableMicrophone)
      const currentPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
      const requestIsCurrent =
        roomRef.current === room &&
        room.state === ConnectionState.Connected &&
        microphoneRequestRoomRef.current === room

      if (!requestIsCurrent) {
        return
      }

      if (!currentPublication?.track || currentPublication.isMuted === shouldEnableMicrophone) {
        throw new Error('LiveKit did not update the microphone mute state.')
      }

      microphoneRequestRoomRef.current = null
      syncMicrophoneState(room)
    } catch (error) {
      if (microphoneRequestRoomRef.current !== room || roomRef.current !== room) {
        return
      }

      microphoneRequestRoomRef.current = null
      setMicrophoneStatus('Error')
      setMicrophoneError(formatMicrophoneError(error))
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand"><div className="mark" aria-hidden="true"><i /><i /><i /><i /><i /></div><span>voicely<span className="brand-accent">.</span></span></div>
        <div><p className="nav-label">Workspace</p><nav className="nav" aria-label="Sections">
          <a className="active" href="#session"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12c2 0 2-5 4-5s2 10 4 10 2-13 4-13 2 8 4 8" /></svg><span>Voice session</span></a>
          <a href="#diagnostics"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m7 15 3-4 3 2 4-5" /></svg><span>Diagnostics</span></a>
          <span className="inactive-nav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 6h14M5 11h14M5 16h9" /></svg><span>Memory &middot; later</span></span>
        </nav></div>
        <div className="sidebar-bottom"><div className="phase">Phase 0</div><p>Real-time audio infrastructure. Conversation features come next.</p></div>
      </aside>
      <main className="main">
        <header className="top"><h1>Voice Companion / Session</h1><div className={`backend-status ${backendStatus === 'Backend connected' ? 'is-ready' : ''}`}><span>{backendStatus}</span><button type="button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Retry</button></div></header>
        <div className="layout"><div className="column">
          <div className="intro"><p className="eyebrow">A space to be heard</p><h2>Speak freely.<br />One moment at a time.</h2><p>A quiet space for conversation. Connect to begin a voice session, with clear controls and transparent live diagnostics.</p></div>
          <section className="card voice-card" id="session" aria-labelledby="session-heading">
            <div className="status-row"><h3 className="section-title" id="session-heading">Your voice space</h3><span className={`status ${connectionStatus === 'Connected' ? 'is-connected' : ''}`}>{connectionStatus}</span></div>
            <div className="orb-wrap" aria-hidden="true"><div className="ring ring-two" /><div className="ring" /><div className="orb"><svg viewBox="0 0 24 24" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg></div></div>
            <div className="voice-copy"><h3>{connectionStatus === 'Connected' ? 'Connected and ready' : 'Ready when you are'}</h3><p>{connectionStatus === 'Connected' ? microphoneStatus : 'Create a session, then connect when you are ready to speak.'}</p></div>
            <div className="controls" aria-label="Voice controls">
              <button className="button primary" type="button" onClick={() => void createSession()} disabled={roomIsActive}>Create session</button>
              <button className="button" type="button" onClick={() => void connectRoom()} disabled={!hasSessionConnectionDetails || roomIsActive}>Connect</button>
              <button className="button" type="button" onClick={() => void enableMicrophone()} disabled={connectionStatus !== 'Connected' || microphoneStatus === 'Requesting microphone' || microphoneStatus === 'Publishing microphone' || microphoneStatus === 'Muted'}>Enable mic</button>
              <button className="button" type="button" onClick={() => void toggleMicrophoneMute()} disabled={connectionStatus !== 'Connected' || (microphoneStatus !== 'Publishing microphone' && microphoneStatus !== 'Muted')}>{microphoneStatus === 'Muted' ? 'Unmute' : 'Mute'}</button>
              <button className="button end-button" type="button" onClick={disconnectRoom} disabled={!roomIsActive}>End</button>
            </div>
            <p className="control-note">Session: {sessionStatus}{hasSessionConnectionDetails ? ' - Session details are ready to connect.' : ''}</p>
            {(connectionError || microphoneError) && <p className="error-message" role="alert">{connectionError || microphoneError}</p>}
          </section>
          <section className="card panel" id="diagnostics" aria-labelledby="diagnostics-heading">
            <div className="panel-head"><h3 id="diagnostics-heading">Live audio diagnostics</h3><span>{audioMetrics ? 'Receiving audio' : 'Waiting for audio'}</span></div>
            <div className="metrics">
              <div className="metric"><small>Frames received</small><strong>{audioMetrics?.frameCount ?? '-'}</strong></div><div className="metric"><small>Sample rate</small><strong>{audioMetrics?.sampleRate ?? '-'} <em>Hz</em></strong></div><div className="metric"><small>Channels</small><strong>{audioMetrics?.channels ?? '-'}</strong></div><div className="metric"><small>Samples / channel</small><strong>{audioMetrics?.samplesPerChannel ?? '-'}</strong></div><div className="metric"><small>Peak PCM</small><strong>{audioMetrics ? audioMetrics.peakPcm.toFixed(3) : '-'}</strong></div><div className="metric"><small>Metric stream</small><strong className="muted-value">{audioMetrics ? 'Receiving' : 'Waiting'}</strong></div><div className="metric metric-wide"><small>Microphone track SID</small><strong>{microphoneTrackSid || 'Not available'}</strong></div>{audioMetrics && <div className="metric metric-wide"><small>Metrics source</small><strong>{audioMetrics.participantIdentity} / {audioMetrics.trackSid}</strong></div>}
            </div>
            <div className="connection-details"><span>Room <strong>{connectedRoomName || roomName || 'Not connected'}</strong></span><span>Local participant <strong>{localParticipantIdentity || participantIdentity || 'Not available'}</strong></span><span>Remote participants <strong>{connectionStatus === 'Connected' ? remoteParticipantCount : '-'}</strong></span></div>
          </section>
        </div><div className="column">
          <section className="card conversation" aria-labelledby="conversation-heading"><div className="panel-head"><h3 id="conversation-heading">Conversation</h3><span>Phase 1</span></div><div className="empty"><div className="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-9.5a7.5 7.5 0 1 1 15 0" /><path d="M8 11h8M8 14h5" /></svg></div><h4>Your conversation will appear here</h4><p>Live speech transcription and companion responses will be added in Phase 1.</p></div></section>
          <section className="card future" aria-labelledby="future-heading"><div className="panel-head"><h3 id="future-heading">Companion insights</h3><span>Coming later</span></div><div className="future-row"><div className="future-icon" aria-hidden="true">&#10022;</div><div><strong>Conversation state &amp; strategy</strong><span>Transparent, user-checkable signals</span></div></div><p>Later phases will show how the companion interpreted a conversation and which response strategy it selected. Nothing is inferred or displayed yet.</p></section>
        </div></div>
        <p className="footer">Voice Companion &middot; Current Phase 0 infrastructure and upcoming conversation features. No simulated connection or audio metrics.</p>
      </main>
    </div>
  )
}

export default App
