import { useEffect, useRef, useState } from 'react'
import {
  ConnectionState,
  createAudioAnalyser,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TranscriptionSegment,
} from 'livekit-client'
import './App.css'

type Transcript = { id: string; text: string }
type TimelineEvent = { id: number; message: string }
type AudioPlaybackState = {
  status: string
  error: string
}
type TurnLatency = {
  llmFirstToken: number
  llmDuration: number
  ttsFirstAudio: number
  ttsDuration: number
  speechEndToAgentAudio: number
}

function isDiagnostic(message: unknown): message is Record<string, unknown> & { type: string } {
  return typeof message === 'object' && message !== null && typeof (message as Record<string, unknown>).type === 'string'
}

function formatMilliseconds(value: number | null) {
  return value === null ? '—' : `${(value * 1000).toFixed(0)} ms`
}

function readTurnLatency(message: Record<string, unknown>): TurnLatency | null {
  const values = [
    message.llm_first_token_seconds,
    message.llm_duration_seconds,
    message.tts_first_audio_seconds,
    message.tts_duration_seconds,
    message.speech_end_to_agent_audio_seconds,
  ]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null

  return {
    llmFirstToken: values[0] as number,
    llmDuration: values[1] as number,
    ttsFirstAudio: values[2] as number,
    ttsDuration: values[3] as number,
    speechEndToAgentAudio: values[4] as number,
  }
}

function App() {
  const [backendStatus, setBackendStatus] = useState('Checking backend...')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [sessionStatus, setSessionStatus] = useState('No session created')
  const [serverUrl, setServerUrl] = useState('')
  const [token, setToken] = useState('')
  const [roomName, setRoomName] = useState('')
  const [participantIdentity, setParticipantIdentity] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('Disconnected')
  const [connectionError, setConnectionError] = useState('')
  const [microphoneStatus, setMicrophoneStatus] = useState('Microphone off')
  const [microphoneError, setMicrophoneError] = useState('')
  const [remoteParticipantCount, setRemoteParticipantCount] = useState(0)
  const [partialTranscript, setPartialTranscript] = useState('')
  const [finalTranscripts, setFinalTranscripts] = useState<Transcript[]>([])
  const [agentResponse, setAgentResponse] = useState('')
  const [agentSpeechText, setAgentSpeechText] = useState('')
  const [userActivity, setUserActivity] = useState('Waiting for session')
  const [agentActivity, setAgentActivity] = useState('Waiting for session')
  const [llmModel, setLlmModel] = useState('Unavailable')
  const [turnLatency, setTurnLatency] = useState<TurnLatency | null>(null)
  const [usage, setUsage] = useState('Unavailable')
  const [audioPlayback, setAudioPlayback] = useState<AudioPlaybackState>({
    status: 'Remote audio track unavailable',
    error: '',
  })
  const [microphoneLevel, setMicrophoneLevel] = useState<number | null>(null)
  const [diagnosticTimeline, setDiagnosticTimeline] = useState<TimelineEvent[]>([])
  const [sessionDiagnosticError, setSessionDiagnosticError] = useState('')
  const roomRef = useRef<Room | null>(null)
  const connectionAttemptRef = useRef<Room | null>(null)
  const microphoneRequestRoomRef = useRef<Room | null>(null)
  const audioContainerRef = useRef<HTMLDivElement | null>(null)
  const remoteAudioElementsRef = useRef(new Map<string, HTMLMediaElement>())
  const audioPlaybackErrorRef = useRef('')
  const finalTranscriptIdsRef = useRef(new Set<string>())
  const latestAssistantItemIdRef = useRef<string | null>(null)
  const pendingTurnLatenciesRef = useRef(new Map<string, TurnLatency>())
  const timelineIdRef = useRef(0)
  const microphoneAnalyserTimerRef = useRef<number | null>(null)
  const microphoneAnalyserRef = useRef<ReturnType<typeof createAudioAnalyser> | null>(null)
  const roomEventHandlersRef = useRef<{
    connectionStateChanged: (state: ConnectionState) => void
    participantChanged: () => void
    microphonePublicationChanged: () => void
    trackSubscribed: (track: RemoteTrack, publication: RemoteTrackPublication) => void
    trackUnsubscribed: (track: RemoteTrack) => void
    transcriptionReceived: (segments: TranscriptionSegment[], participant?: Participant) => void
    audioPlaybackStatusChanged: (playing: boolean) => void
    dataReceived: (payload: Uint8Array, participant?: unknown, kind?: unknown, topic?: string) => void
  } | null>(null)

  const hasSessionConnectionDetails = Boolean(serverUrl && token)
  const roomIsActive = ['Connecting', 'Connected', 'Reconnecting'].includes(connectionStatus)

  function sanitizeConnectionErrorMessage(message: string) {
    return message
      .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '[redacted URL]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b((?:token|api[ _-]?secret)\s*[=:]\s*)\S+/gi, '$1[redacted]')
  }

  function addDiagnosticTimelineEvent(message: string) {
    const event = { id: timelineIdRef.current, message }
    timelineIdRef.current += 1
    setDiagnosticTimeline((events) => [...events.slice(-29), event])
  }

  function resetConversationState() {
    finalTranscriptIdsRef.current.clear()
    timelineIdRef.current = 0
    setPartialTranscript('')
    setFinalTranscripts([])
    setAgentResponse('')
    setAgentSpeechText('')
    setUserActivity('Waiting for session')
    setAgentActivity('Waiting for session')
    setLlmModel('Unavailable')
    setTurnLatency(null)
    setUsage('Unavailable')
    setAudioPlayback({
      status: 'Remote audio track unavailable',
      error: '',
    })
    audioPlaybackErrorRef.current = ''
    latestAssistantItemIdRef.current = null
    pendingTurnLatenciesRef.current.clear()
    setDiagnosticTimeline([])
    setSessionDiagnosticError('')
    setMicrophoneLevel(null)
  }

  function stopMicrophoneAnalyser() {
    if (microphoneAnalyserTimerRef.current !== null) {
      window.clearInterval(microphoneAnalyserTimerRef.current)
      microphoneAnalyserTimerRef.current = null
    }
    const microphoneAnalyser = microphoneAnalyserRef.current
    microphoneAnalyserRef.current = null
    if (microphoneAnalyser) void microphoneAnalyser.cleanup().catch(() => undefined)
    setMicrophoneLevel(null)
  }

  function startMicrophoneAnalyser(room: Room) {
    stopMicrophoneAnalyser()
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    if (!track) return

    try {
      const microphoneAnalyser = createAudioAnalyser(track, {
        fftSize: 2048,
        smoothingTimeConstant: 0.2,
        minDecibels: -100,
        maxDecibels: -30,
      })
      microphoneAnalyserRef.current = microphoneAnalyser
      const audioContext = microphoneAnalyser.analyser.context
      if (audioContext instanceof AudioContext) void audioContext.resume().catch(() => undefined)
      microphoneAnalyserTimerRef.current = window.setInterval(() => {
        if (roomRef.current !== room || microphoneAnalyserRef.current !== microphoneAnalyser) return
        setMicrophoneLevel(microphoneAnalyser.calculateVolume())
      }, 250)
    } catch {
      microphoneAnalyserRef.current = null
    }
  }

  function updateAudioPlayback(room: Room) {
    const elements = [...remoteAudioElementsRef.current.values()]
    let status = 'Remote audio track unavailable'
    if (elements.length > 0 && audioPlaybackErrorRef.current) {
      status = 'Playback blocked'
    } else if (elements.some((element) => !element.paused)) {
      status = 'Playback enabled'
    } else if (elements.length > 0) {
      status = room.canPlaybackAudio ? 'Audio attached' : 'Enable audio playback'
    }

    setAudioPlayback({
      status,
      error: audioPlaybackErrorRef.current,
    })
  }

  function removeRemoteAudio(room: Room, trackSid: string) {
    const element = remoteAudioElementsRef.current.get(trackSid)
    if (!element) return
    element.remove()
    remoteAudioElementsRef.current.delete(trackSid)
    updateAudioPlayback(room)
  }

  function removeAllRemoteAudio() {
    for (const element of remoteAudioElementsRef.current.values()) element.remove()
    remoteAudioElementsRef.current.clear()
  }

  function attachRemoteAudio(room: Room, track: RemoteTrack) {
    const trackSid = track.sid
    if (track.kind !== Track.Kind.Audio || !trackSid || remoteAudioElementsRef.current.has(trackSid)) return
    const element = document.createElement('audio')
    element.autoplay = true
    element.muted = false
    element.volume = 1
    element.dataset.trackSid = trackSid
    remoteAudioElementsRef.current.set(trackSid, element)
    element.addEventListener('playing', () => {
      audioPlaybackErrorRef.current = ''
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    element.addEventListener('pause', () => {
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    element.addEventListener('error', () => {
      audioPlaybackErrorRef.current = element.error?.message || 'The audio element reported a playback error.'
      if (roomRef.current === room) updateAudioPlayback(room)
    })
    audioContainerRef.current?.append(element)
    track.attach(element)
    updateAudioPlayback(room)
  }

  function removeRoomEventListeners(room: Room) {
    const handlers = roomEventHandlersRef.current
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
    roomEventHandlersRef.current = null
  }

  function syncMicrophoneState(room: Room) {
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
    if (!publication?.track) {
      stopMicrophoneAnalyser()
      setMicrophoneStatus('Microphone off')
      setMicrophoneError('')
      return
    }
    setMicrophoneStatus(publication.isMuted ? 'Muted' : 'Publishing microphone')
    setMicrophoneError('')
    if (!microphoneAnalyserRef.current) startMicrophoneAnalyser(room)
  }

  function formatMicrophoneError(error: unknown) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone permission was denied.'
    if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone device was found.'
    return error instanceof Error ? error.message : 'The microphone could not be enabled.'
  }

  useEffect(() => {
    const abortController = new AbortController()
    async function checkBackend() {
      setBackendStatus('Checking backend...')
      try {
        const response = await fetch('/api/health', { signal: abortController.signal })
        const health = (await response.json()) as { status?: string }
        setBackendStatus(response.ok && health.status === 'ok' ? 'Backend connected' : 'Backend unavailable')
      } catch {
        if (!abortController.signal.aborted) setBackendStatus('Backend unavailable')
      }
    }
    void checkBackend()
    return () => abortController.abort()
  }, [retryAttempt])

  useEffect(() => () => {
    const room = roomRef.current
    if (room) removeRoomEventListeners(room)
    removeAllRemoteAudio()
    stopMicrophoneAnalyser()
    roomRef.current = null
    connectionAttemptRef.current = null
    microphoneRequestRoomRef.current = null
    if (room) void room.disconnect()
  }, [])

  async function createSession() {
    setSessionStatus('Creating session...')
    setConnectionError('')
    setServerUrl('')
    setToken('')
    setRoomName('')
    setParticipantIdentity('')
    resetConversationState()
    try {
      const response = await fetch('/api/session', { method: 'POST' })
      if (!response.ok) throw new Error('The session could not be created.')
      const session = (await response.json()) as { server_url: string; token: string; room_name: string; participant_identity: string }
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
    if (roomRef.current || !serverUrl || !token) return
    const room = new Room()
    roomRef.current = room
    connectionAttemptRef.current = room
    setConnectionStatus('Connecting')
    setConnectionError('')

    const connectionStateChanged = (state: ConnectionState) => {
      if (roomRef.current !== room) return
      if (state === ConnectionState.Connecting) setConnectionStatus('Connecting')
      if (state === ConnectionState.Connected) {
        setConnectionStatus('Connected')
        setRemoteParticipantCount(room.remoteParticipants.size)
        syncMicrophoneState(room)
      }
      if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) setConnectionStatus('Reconnecting')
      if (state === ConnectionState.Disconnected && connectionAttemptRef.current !== room) disconnectRoom()
    }
    const participantChanged = () => {
      if (roomRef.current !== room) return
      setRemoteParticipantCount(room.remoteParticipants.size)
    }
    const microphonePublicationChanged = () => roomRef.current === room && syncMicrophoneState(room)
    const trackSubscribed = (track: RemoteTrack) => attachRemoteAudio(room, track)
    const trackUnsubscribed = (track: RemoteTrack) => {
      track.detach()
      if (track.sid) removeRemoteAudio(room, track.sid)
    }
    const transcriptionReceived = (segments: TranscriptionSegment[], participant?: Participant) => {
      if (roomRef.current !== room) return
      const fromUser = participant?.identity === room.localParticipant.identity
      for (const segment of segments) {
        if (fromUser) {
          if (segment.final) {
            if (!finalTranscriptIdsRef.current.has(segment.id)) {
              finalTranscriptIdsRef.current.add(segment.id)
              setFinalTranscripts((transcripts) => [...transcripts, { id: segment.id, text: segment.text }])
            }
            setPartialTranscript('')
          } else setPartialTranscript(segment.text)
        } else {
          setAgentSpeechText(segment.text)
        }
      }
    }
    const audioPlaybackStatusChanged = (playing: boolean) => {
      audioPlaybackErrorRef.current = playing ? '' : 'Browser autoplay policy blocked remote audio playback.'
      updateAudioPlayback(room)
    }
    const dataReceived = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      if (roomRef.current !== room || topic !== 'session_diagnostics') return
      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as unknown
        if (!isDiagnostic(message)) return
        if (message.type === 'user_state_changed' && typeof message.state === 'string') {
          setUserActivity(message.state)
          addDiagnosticTimelineEvent(`User is ${message.state}`)
        } else if (message.type === 'agent_state_changed' && typeof message.state === 'string') {
          setAgentActivity(message.state)
          addDiagnosticTimelineEvent(`Agent is ${message.state}`)
        } else if (message.type === 'conversation_item_added' && typeof message.role === 'string') {
          const itemId = typeof message.item_id === 'string' ? message.item_id : null
          if (message.role === 'assistant' && message.interrupted === true) {
            addDiagnosticTimelineEvent('Assistant response interrupted')
          } else if (message.role === 'assistant' && typeof message.text === 'string') {
            setAgentResponse(message.text)
            latestAssistantItemIdRef.current = itemId
            if (itemId) {
              const pendingLatency = pendingTurnLatenciesRef.current.get(itemId)
              if (pendingLatency) {
                pendingTurnLatenciesRef.current.delete(itemId)
                setTurnLatency(pendingLatency)
              }
            }
            addDiagnosticTimelineEvent('Committed assistant conversation item')
          } else {
            addDiagnosticTimelineEvent(`Committed ${message.role} conversation item`)
          }
        } else if (message.type === 'turn_metrics' && typeof message.item_id === 'string') {
          const latency = readTurnLatency(message)
          if (!latency) return
          if (latestAssistantItemIdRef.current === message.item_id) {
            setTurnLatency(latency)
          } else {
            pendingTurnLatenciesRef.current.set(message.item_id, latency)
          }
          addDiagnosticTimelineEvent('Completed response latency received')
        } else if (message.type === 'session_usage' && Array.isArray(message.items)) {
          setUsage(message.items.map((item) => {
            const values = item as Record<string, unknown>
            return `${values.type}: ${values.input_tokens ?? 0} in / ${values.output_tokens ?? 0} out`
          }).join(' · ') || 'No provider usage yet')
        } else if (message.type === 'session_started' && typeof message.llm_model === 'string') {
          setLlmModel(message.llm_model)
          setUserActivity('listening')
          setAgentActivity('idle')
          addDiagnosticTimelineEvent('Voice pipeline ready')
        } else if (message.type === 'session_error' && typeof message.source === 'string' && typeof message.message === 'string') {
          setSessionDiagnosticError(`${message.source}: ${sanitizeConnectionErrorMessage(message.message)}`)
          addDiagnosticTimelineEvent(`Provider error: ${message.source}`)
        } else if (message.type === 'session_closed') addDiagnosticTimelineEvent('Voice pipeline closed')
      } catch {
        // Ignore malformed data messages from the room.
      }
    }
    roomEventHandlersRef.current = { connectionStateChanged, participantChanged, microphonePublicationChanged, trackSubscribed, trackUnsubscribed, transcriptionReceived, audioPlaybackStatusChanged, dataReceived }
    room.on(RoomEvent.ConnectionStateChanged, connectionStateChanged)
    room.on(RoomEvent.ParticipantConnected, participantChanged)
    room.on(RoomEvent.ParticipantDisconnected, participantChanged)
    room.on(RoomEvent.TrackMuted, microphonePublicationChanged)
    room.on(RoomEvent.TrackUnmuted, microphonePublicationChanged)
    room.on(RoomEvent.LocalTrackPublished, microphonePublicationChanged)
    room.on(RoomEvent.LocalTrackUnpublished, microphonePublicationChanged)
    room.on(RoomEvent.TrackSubscribed, trackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, trackUnsubscribed)
    room.on(RoomEvent.TranscriptionReceived, transcriptionReceived)
    room.on(RoomEvent.AudioPlaybackStatusChanged, audioPlaybackStatusChanged)
    room.on(RoomEvent.DataReceived, dataReceived)
    try {
      await room.connect(serverUrl, token)
      connectionAttemptRef.current = null
      if (roomRef.current !== room) return
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track) attachRemoteAudio(room, publication.track)
        }
      }
      setConnectionStatus('Connected')
      setRemoteParticipantCount(room.remoteParticipants.size)
      updateAudioPlayback(room)
      syncMicrophoneState(room)
    } catch (error) {
      if (connectionAttemptRef.current !== room) return
      setConnectionError(sanitizeConnectionErrorMessage(error instanceof Error ? error.message : 'LiveKit connection failed.'))
      disconnectRoom()
      setConnectionStatus('Connection failed')
    }
  }

  function disconnectRoom() {
    const room = roomRef.current
    if (!room) return
    removeRoomEventListeners(room)
    removeAllRemoteAudio()
    roomRef.current = null
    connectionAttemptRef.current = null
    microphoneRequestRoomRef.current = null
    stopMicrophoneAnalyser()
    void room.disconnect()
    setConnectionStatus('Disconnected')
    setMicrophoneStatus('Microphone off')
    setRemoteParticipantCount(0)
    resetConversationState()
  }

  async function enableMicrophone() {
    const room = roomRef.current
    if (!room || room.state !== ConnectionState.Connected || microphoneRequestRoomRef.current) return
    microphoneRequestRoomRef.current = room
    setMicrophoneStatus('Requesting microphone')
    setMicrophoneError('')
    try {
      await room.localParticipant.setMicrophoneEnabled(true)
      if (roomRef.current !== room || room.state !== ConnectionState.Connected) return
      microphoneRequestRoomRef.current = null
      syncMicrophoneState(room)
    } catch (error) {
      if (roomRef.current === room) {
        microphoneRequestRoomRef.current = null
        setMicrophoneStatus('Error')
        setMicrophoneError(formatMicrophoneError(error))
      }
    }
  }

  async function toggleMicrophoneMute() {
    const room = roomRef.current
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone)
    if (!room || room.state !== ConnectionState.Connected || !publication?.track) return
    try {
      await room.localParticipant.setMicrophoneEnabled(publication.isMuted)
      if (roomRef.current === room) syncMicrophoneState(room)
    } catch (error) {
      setMicrophoneStatus('Error')
      setMicrophoneError(formatMicrophoneError(error))
    }
  }

  async function enableAudio() {
    const room = roomRef.current
    if (!room) return
    try {
      audioPlaybackErrorRef.current = ''
      await room.startAudio()
      updateAudioPlayback(room)
    } catch (error) {
      audioPlaybackErrorRef.current = sanitizeConnectionErrorMessage(
        error instanceof Error ? error.message : 'Audio playback could not be enabled.',
      )
      updateAudioPlayback(room)
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation"><div className="brand"><div className="mark" aria-hidden="true"><i /><i /><i /><i /><i /></div><span>voicely<span className="brand-accent">.</span></span></div><div><p className="nav-label">Workspace</p><nav className="nav" aria-label="Sections"><a className="active" href="#session"><span>Voice session</span></a><a href="#diagnostics"><span>Diagnostics</span></a></nav></div><div className="sidebar-bottom"><div className="phase">Phase 1C</div><p>Live STT, LLM, speech, and truthful pipeline diagnostics.</p></div></aside>
      <main className="main">
        <header className="top"><h1>Voice Companion / Session</h1><div className={`backend-status ${backendStatus === 'Backend connected' ? 'is-ready' : ''}`}><span>{backendStatus}</span><button type="button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Retry</button></div></header>
        <div className="layout"><div className="column">
          <div className="intro"><p className="eyebrow">A space to be heard</p><h2>Speak freely.<br />One moment at a time.</h2><p>Connect, enable your microphone, and hear the companion respond through the same LiveKit room.</p></div>
          <section className="card voice-card" id="session" aria-labelledby="session-heading"><div className="status-row"><h3 className="section-title" id="session-heading">Your voice space</h3><span className={`status ${connectionStatus === 'Connected' ? 'is-connected' : ''}`}>{connectionStatus}</span></div><div className="orb-wrap" aria-hidden="true"><div className="ring ring-two" /><div className="ring" /><div className="orb">&#9834;</div></div><div className="voice-copy"><h3>{connectionStatus === 'Connected' ? 'Connected and ready' : 'Ready when you are'}</h3><p>{connectionStatus === 'Connected' ? microphoneStatus : 'Create a session, then connect when you are ready to speak.'}</p></div><div className="controls" aria-label="Voice controls"><button className="button primary" type="button" onClick={() => void createSession()} disabled={roomIsActive}>Create session</button><button className="button" type="button" onClick={() => void connectRoom()} disabled={!hasSessionConnectionDetails || roomIsActive}>Connect</button><button className="button" type="button" onClick={() => void enableMicrophone()} disabled={connectionStatus !== 'Connected' || microphoneStatus !== 'Microphone off'}>Enable mic</button><button className="button" type="button" onClick={() => void toggleMicrophoneMute()} disabled={connectionStatus !== 'Connected' || !['Publishing microphone', 'Muted'].includes(microphoneStatus)}>{microphoneStatus === 'Muted' ? 'Unmute' : 'Mute'}</button><button className="button" type="button" onClick={() => void enableAudio()} disabled={connectionStatus !== 'Connected'}>Enable audio</button><button className="button end-button" type="button" onClick={disconnectRoom} disabled={!roomIsActive}>End</button></div><p className="control-note">Session: {sessionStatus}</p>{(connectionError || microphoneError || sessionDiagnosticError) && <p className="error-message" role="alert">{connectionError || microphoneError || sessionDiagnosticError}</p>}<div ref={audioContainerRef} className="remote-audio" aria-hidden="true" /></section>
          <section className="card panel" id="diagnostics" aria-labelledby="diagnostics-heading">
            <div className="panel-head"><h3 id="diagnostics-heading">Latency</h3><span>Latest completed turn</span></div>
            <div className="metrics">
              <div className="metric"><small>LLM first token</small><strong>{formatMilliseconds(turnLatency?.llmFirstToken ?? null)}</strong></div>
              <div className="metric"><small>LLM generation</small><strong>{formatMilliseconds(turnLatency?.llmDuration ?? null)}</strong></div>
              <div className="metric"><small>TTS first audio chunk</small><strong>{formatMilliseconds(turnLatency?.ttsFirstAudio ?? null)}</strong></div>
              <div className="metric"><small>TTS generation</small><strong>{formatMilliseconds(turnLatency?.ttsDuration ?? null)}</strong></div>
              <div className="metric"><small>Speech end → agent audio (server)</small><strong>{formatMilliseconds(turnLatency?.speechEndToAgentAudio ?? null)}</strong></div>
            </div>
            <div className="connection-details"><span>LLM model <strong>{llmModel}</strong></span><span>Audio playback <strong>{audioPlayback.status}</strong></span><span>Room <strong>{roomName || 'Not connected'}</strong></span><span>Local participant <strong>{participantIdentity || 'Not available'}</strong></span><span>Remote participants <strong>{connectionStatus === 'Connected' ? remoteParticipantCount : '-'}</strong></span><span>Session usage <strong>{usage}</strong></span>{audioPlayback.error && <span>Playback error <strong>{audioPlayback.error}</strong></span>}</div>
          </section>
        </div><div className="column">
          <section className="card conversation" aria-labelledby="conversation-heading"><div className="panel-head"><h3 id="conversation-heading">Conversation</h3><span>{agentActivity}</span></div><div className="conversation-debug"><div className="debug-row"><small>User activity</small><strong className={`activity ${userActivity}`}>{userActivity}</strong></div><div className="debug-row"><small>Agent activity</small><strong className={`activity ${agentActivity}`}>{agentActivity}</strong></div><div className="debug-block"><small>Microphone signal</small><p>{microphoneLevel === null ? 'Enable the microphone to inspect its local input level.' : microphoneStatus === 'Muted' ? 'Muted' : `Local input level: ${microphoneLevel.toFixed(3)}`}</p></div><div className="debug-block"><small>Current partial user transcript</small><p>{partialTranscript || 'Waiting for speech recognition...'}</p></div><div className="debug-block"><small>Committed user turns</small>{finalTranscripts.length ? <ol className="transcript-history">{finalTranscripts.map((transcript) => <li key={transcript.id}>{transcript.text}</li>)}</ol> : <p>No committed user turn yet.</p>}</div><div className="debug-block"><small>Generated agent response</small><p>{agentResponse || 'Waiting for a committed agent response...'}</p></div><div className="debug-block"><small>Speech-synchronized agent text</small><p>{agentSpeechText || 'Waiting for agent audio...'}</p></div><div className="debug-block"><small>Pipeline event timeline</small>{diagnosticTimeline.length ? <ol className="diagnostic-timeline">{diagnosticTimeline.map((event) => <li key={event.id}>{event.message}</li>)}</ol> : <p>No session events yet.</p>}</div></div></section>
        </div></div>
        <p className="footer">Voice Companion · Phase 1C uses real LiveKit room audio, native transcriptions, per-turn latency, and session usage. TTS timing is not browser-audible playback timing.</p>
      </main>
    </div>
  )
}

export default App
