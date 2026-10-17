import { formatMilliseconds, slowestStage, type CompletedTurn } from '../reliability'
import type { Interruption, StartupState, TimelineEvent } from '../voice/types'

type DebugPanelProps = {
  recentTurns: CompletedTurn[]
  selectedTurnId: string | null
  interruptions: Interruption[]
  lastInterrupted: { speechId: string; itemId: string | null; sequence: number } | null
  providerModels: { stt: string; llm: string; tts: string }
  timeline: TimelineEvent[]
  roomName: string
  backendStatus: string
  startupState: StartupState
  sessionReadySeconds: number | null
  sessionStatus: string
  connectionStatus: string
  microphoneStatus: string
  audioPlayback: string
  userActivity: string
  agentActivity: string
  stateStatus: string
  activeErrors: string[]
  onClose: () => void
  onSelectTurn: (itemId: string) => void
  onRetryBackend: () => void
}

export function DebugPanel({
  recentTurns, selectedTurnId, interruptions, lastInterrupted, providerModels, timeline, roomName,
  backendStatus, startupState, sessionReadySeconds, sessionStatus, connectionStatus, microphoneStatus,
  audioPlayback, userActivity, agentActivity, stateStatus, activeErrors, onClose, onSelectTurn, onRetryBackend
}: DebugPanelProps) {
  const selectedTurn = recentTurns.find((turn) => turn.itemId === selectedTurnId) ?? recentTurns[0]
  const selectedLatency = selectedTurn?.latency
  const bottleneck = selectedLatency ? slowestStage(selectedLatency) : null
  const speakableGap = selectedLatency?.firstSpeakableText !== undefined && selectedLatency.llmFirstToken !== undefined
    && selectedLatency.firstSpeakableText >= selectedLatency.llmFirstToken
    ? selectedLatency.firstSpeakableText - selectedLatency.llmFirstToken : null
  const postTranscriptTurnWait = selectedLatency?.finalTranscript !== undefined && selectedLatency.turnDetection !== undefined
    && selectedLatency.turnDetection >= selectedLatency.finalTranscript
    ? selectedLatency.turnDetection - selectedLatency.finalTranscript : null
  const selectedInterruption = interruptions.find((event) => event.speechId === selectedTurn?.speechId)
    ?? (selectedTurnId ? undefined : interruptions[0])
  const measurements = selectedLatency ? [
    { label: 'Final transcript after speech', meaning: 'Speech ended → final transcript ready', value: selectedLatency.finalTranscript },
    { label: 'Turn detection', meaning: 'Speech ended → user turn accepted complete', value: selectedLatency.turnDetection },
    { label: 'Post-transcript turn wait', meaning: 'Turn detection − final transcript; diagnostic overlap difference', value: postTranscriptTurnWait ?? undefined },
    { label: 'Turn processing', meaning: 'User-turn callback began → callback finished', value: selectedLatency.turnProcessing },
    { label: 'LLM first token', meaning: selectedLatency.llmFirstTokenSource === 'provider' ? 'LLM provider request began → first token returned' : 'LLM generation began → first token returned', value: selectedLatency.llmFirstToken },
    { label: 'First speakable text', meaning: 'LLM generation began → first TTS-ready sentence', value: selectedLatency.firstSpeakableText },
    { label: 'TTS first audio', meaning: selectedLatency.ttsFirstAudioSource === 'provider' ? 'TTS provider request began → first audio chunk returned' : 'First text reached TTS → first audio chunk returned', value: selectedLatency.ttsFirstAudio },
    { label: 'Audio output start', meaning: 'First audio frame forwarded → output reported playback started', value: selectedLatency.audioOutputStart },
    { label: 'Voice response', meaning: selectedLatency.responseSource === 'worker_state_fallback' ? 'Worker user-speech end → agent speaking state' : selectedLatency.responseSource === 'message_timestamps' ? 'User message speech end → assistant message speech start' : 'User speech ended → agent response began at server output', value: selectedLatency.responseLatency },
  ].filter((row) => row.value !== undefined && (row.label !== 'Turn processing' || row.value >= 0.02)) : []
  const agentLogic = selectedLatency?.agentLogicMetrics
  const knownAgentLogic = agentLogic?.featureFinalization !== undefined
    && agentLogic.jevClassification !== undefined && agentLogic.stateParsing !== undefined
    && agentLogic.strategySelection !== undefined
    ? agentLogic.featureFinalization + (agentLogic.jevClientSetup ?? 0)
      + agentLogic.jevClassification
      + agentLogic.stateParsing + (agentLogic.stateUpdate ?? 0) + agentLogic.strategySelection : null
  const remainingTurnProcessing = selectedLatency?.turnProcessing !== undefined && knownAgentLogic !== null
    ? selectedLatency.turnProcessing - knownAgentLogic : null
  const otherTurnOverhead = remainingTurnProcessing !== null && remainingTurnProcessing >= -0.002
    ? Math.max(0, remainingTurnProcessing) : null
  const agentLogicRows = [
    { label: 'Feature finalization', value: agentLogic?.featureFinalization },
    { label: 'JEV client setup', value: agentLogic?.jevClientSetup },
    { label: 'JEV classification', value: agentLogic?.jevClassification },
    { label: 'State parsing', value: agentLogic?.stateParsing },
    { label: 'State update and publication', value: agentLogic?.stateUpdate },
    { label: 'Strategy selection', value: agentLogic?.strategySelection },
    { label: 'Other overhead', value: otherTurnOverhead },
  ]


  return (
    <div className="debug-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="debug-shell" role="dialog" aria-modal="true" aria-labelledby="debug-heading">
      <div className="debug-top"><div className="debug-title"><span className="debug-badge" aria-hidden="true">⌁</span><div><h2 id="debug-heading">Realtime Debug</h2><p>Session diagnostics and voice pipeline events</p></div></div><button className="close-button" type="button" onClick={() => onClose()} aria-label="Close debug">×</button></div>
      <div className="debug-content">
        <div className="debug-column">
          <section className="debug-card trace-card"><div className="debug-card-head"><h3>Voice response trace</h3><span>{selectedTurn ? `Turn ${selectedTurn.sequence}` : 'Waiting for a completed turn'}</span></div>
            <div className="trace-summary"><div><span className="eyebrow">Voice response</span><strong>{formatMilliseconds(selectedLatency?.responseLatency ?? null)}</strong><small>{selectedLatency?.responseSource === 'native' ? 'Speech end → agent response begins · native server timing' : selectedLatency?.responseSource === 'message_timestamps' ? 'User/assistant message timestamps · server estimate' : selectedLatency?.responseSource === 'worker_state_fallback' ? 'Speech end → agent speaking state · worker estimate' : 'No response timing available'}</small></div><div><span className="eyebrow">Slowest measured stage</span><strong>{bottleneck ? `${bottleneck.label} · ${formatMilliseconds(bottleneck.seconds)}` : '—'}</strong><small>{bottleneck?.hint ?? 'Awaiting stage measurements.'}</small></div></div>
            {selectedTurn ? <>
              <div className="trace-flow">
                <div className="trace-boundary">User speech ended</div>
                {(selectedLatency?.finalTranscript !== undefined || selectedLatency?.turnDetection !== undefined) && <div className="trace-stage"><small>Both measured from speech end · may overlap</small>{selectedLatency.finalTranscript !== undefined && <div><span>Final transcript after speech</span><strong>{formatMilliseconds(selectedLatency.finalTranscript)}</strong></div>}{selectedLatency.turnDetection !== undefined && <div><span>Turn detection</span><strong>{formatMilliseconds(selectedLatency.turnDetection)}</strong></div>}</div>}
                {selectedLatency?.turnProcessing !== undefined && selectedLatency.turnProcessing >= 0.02 && <div className="trace-stage"><small>After turn accepted</small><div><span>Turn processing</span><strong>{formatMilliseconds(selectedLatency.turnProcessing)}</strong></div></div>}
                {(selectedLatency?.llmFirstToken !== undefined || selectedLatency?.firstSpeakableText !== undefined) && <div className="trace-stage"><small>Both measured from LLM start · may overlap</small>{selectedLatency.llmFirstToken !== undefined && <div><span>LLM first token</span><strong>{formatMilliseconds(selectedLatency.llmFirstToken)}</strong></div>}{selectedLatency.firstSpeakableText !== undefined && <div><span>First speakable text</span><strong>{formatMilliseconds(selectedLatency.firstSpeakableText)}</strong></div>}</div>}
                {selectedLatency?.ttsFirstAudio !== undefined && <div className="trace-stage"><small>After text reached TTS</small><div><span>TTS first audio</span><strong>{formatMilliseconds(selectedLatency.ttsFirstAudio)}</strong></div></div>}
                {selectedLatency?.audioOutputStart !== undefined && <div className="trace-stage"><small>Server audio output</small><div><span>Audio output start</span><strong>{formatMilliseconds(selectedLatency.audioOutputStart)}</strong></div></div>}
                <div className="trace-boundary">Agent response began</div>
              </div>
              <p className="trace-note">Each number uses its own start and end points. Final transcript and turn detection both start at speech end; first speakable text includes first-token time; turn processing includes agent logic. Do not add the rows together. Audio output start is server output timing, not browser-audible timing.</p>
              {selectedLatency?.finalTranscript !== undefined && selectedLatency.finalTranscript > 0.5 && <p className="trace-note">Final transcript took {formatMilliseconds(selectedLatency.finalTranscript)} after speech ended. Check STT finalization and provider latency.</p>}
              {speakableGap !== null && speakableGap > 0.2 && <p className="trace-note">First speakable text followed the first token by {formatMilliseconds(speakableGap)}. Check sentence buffering or response formatting.</p>}
            </> : <p className="debug-empty">Complete a voice turn to see its timing trace.</p>}
          </section>
          {selectedTurn && <section className="debug-card"><div className="debug-card-head"><h3>Detailed measurements</h3><span>Only reported values</span></div><div className="measurement-scroll"><table className="measurement-table"><thead><tr><th>Measurement</th><th>Exact meaning</th><th>Value</th></tr></thead><tbody>{measurements.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.meaning}</td><td>{formatMilliseconds(row.value ?? null)}</td></tr>)}</tbody></table></div></section>}
          {selectedTurn && <section className="debug-card"><div className="debug-card-head"><h3>Main LLM</h3><span>OpenRouter · current turn</span></div><dl className="detail-list">
            <div><dt>LLM request preparation</dt><dd>{formatMilliseconds(selectedLatency?.llmRequestPreparation ?? null)}</dd></div>
            <div><dt>LLM client setup</dt><dd>— · reused for this session</dd></div>
            <div><dt>Pre-request overhead</dt><dd>{formatMilliseconds(selectedLatency?.llmPreRequestOverhead ?? null)}</dd></div>
            <div><dt>LLM first token</dt><dd>{formatMilliseconds(selectedLatency?.llmFirstToken ?? null)}</dd></div>
            <div><dt>First speakable text</dt><dd>{formatMilliseconds(selectedLatency?.firstSpeakableText ?? null)}</dd></div>
            <div><dt>Token → speakable gap</dt><dd>{formatMilliseconds(speakableGap)}</dd></div>
            <div><dt>Messages</dt><dd>{selectedLatency?.llmMessageCount ?? '—'}</dd></div>
            <div><dt>Previous messages</dt><dd>{selectedLatency?.llmPreviousMessageCount ?? '—'}</dd></div>
            <div><dt>Instruction characters</dt><dd>{selectedLatency?.llmInstructionChars ?? '—'}</dd></div>
            <div><dt>Current user characters</dt><dd>{selectedLatency?.llmCurrentUserChars ?? '—'}</dd></div>
            <div><dt>Total text characters</dt><dd>{selectedLatency?.llmContextChars ?? '—'}</dd></div>
            <div><dt>Input / output tokens</dt><dd>{selectedLatency?.llmInputTokens ?? '—'} / {selectedLatency?.llmOutputTokens ?? '—'}</dd></div>
            <div><dt>Model</dt><dd>{providerModels.llm || '—'}</dd></div>
            <div><dt>Provider</dt><dd>OpenRouter</dd></div>
          </dl><p className="trace-note">Preparation is inside the turn callback. Pre-request overhead spans strategy readiness through entry to the generation node and includes preparation and LiveKit scheduling. Native first-token and first-speakable timings overlap.</p></section>}
          {selectedTurn && <section className="debug-card"><div className="debug-card-head"><h3>Turn processing breakdown</h3><span>Inside the user-turn callback</span></div><dl className="detail-list">{agentLogicRows.filter((row) => row.label !== 'State update and publication' || row.value !== undefined).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{formatMilliseconds(row.value ?? null)}</dd></div>)}<div><dt>Total turn processing</dt><dd>{formatMilliseconds(selectedLatency?.turnProcessing ?? null)}</dd></div></dl><p className="trace-note">JEV classification covers the HTTP request and response. Other overhead is the native callback duration minus non-overlapping measured stages; it includes small preparation and diagnostic work.</p></section>}
          {selectedInterruption && <section className="debug-card"><div className="debug-card-head"><h3>Interruption</h3><span>Interrupted speech {selectedInterruption.sequence}</span></div><div className="interruption-detail"><span>User speech detected → agent speaking state ended</span><strong>{formatMilliseconds(selectedInterruption.seconds)}</strong><small>Worker timing; this does not measure browser playback stop.</small></div></section>}
        </div>
        <div className="debug-column">
          <section className="debug-card"><div className="debug-card-head"><h3>Recent completed turns</h3><span>Current session</span></div>{recentTurns.length ? <div className="turn-picker">{recentTurns.map((turn) => <button type="button" className={selectedTurn?.itemId === turn.itemId ? 'selected' : ''} key={turn.itemId} onClick={() => onSelectTurn(turn.itemId)}><span>Turn {turn.sequence}</span><strong>{formatMilliseconds(turn.latency.responseLatency ?? null)}</strong></button>)}</div> : <p className="debug-empty">No completed turns yet.</p>}</section>
          {lastInterrupted && <section className="debug-card"><div className="debug-card-head"><h3>Last interrupted response</h3><span>Turn {lastInterrupted.sequence}</span></div><dl className="detail-list"><div><dt>Interrupted</dt><dd>true</dd></div><div><dt>Speech ID</dt><dd>{lastInterrupted.speechId}</dd></div><div><dt>Assistant item ID</dt><dd>{lastInterrupted.itemId || '—'}</dd></div><div><dt>LLM first token</dt><dd>—</dd></div><div><dt>First speakable text</dt><dd>—</dd></div></dl></section>}
          <details className="debug-card advanced-card"><summary>Advanced technical debug</summary><dl className="detail-list">
            <div><dt>Session ID</dt><dd>{roomName || '—'}</dd></div>
            <div><dt>Speech ID</dt><dd>{selectedTurn?.speechId || '—'}</dd></div>
            <div><dt>User item ID</dt><dd>{selectedTurn?.userItemId || '—'}</dd></div>
            <div><dt>Assistant item ID</dt><dd>{selectedTurn?.itemId || '—'}</dd></div>
            <div><dt>Turn sequence</dt><dd>{selectedTurn?.sequence ?? '—'}</dd></div>
            <div><dt>Interrupted</dt><dd>{selectedTurn ? 'No · completed response' : '—'}</dd></div>
            <div><dt>STT model</dt><dd>{providerModels.stt || '—'}</dd></div>
            <div><dt>LLM model</dt><dd>{providerModels.llm || '—'}</dd></div>
            <div><dt>TTS model</dt><dd>{providerModels.tts || '—'}</dd></div>
            <div><dt>Voice response source</dt><dd>{selectedLatency?.responseSource || '—'}</dd></div>
            <div><dt>LLM first token source</dt><dd>{selectedLatency?.llmFirstTokenSource || '—'}</dd></div>
            <div><dt>TTS first audio source</dt><dd>{selectedLatency?.ttsFirstAudioSource || '—'}</dd></div>
            <div><dt>Provider request IDs</dt><dd>{selectedLatency?.providerRequestIds?.join(', ') || '—'}</dd></div>
            <div><dt>Additional metric updates</dt><dd>{selectedTurn?.additionalUpdates ?? '—'}</dd></div>
            {selectedLatency?.turnProcessing !== undefined && selectedLatency.turnProcessing < 0.02 && <div><dt>Turn processing</dt><dd>{formatMilliseconds(selectedLatency.turnProcessing)}</dd></div>}
          </dl></details>
          <section className="debug-card"><div className="debug-card-head"><h3>Recent events</h3><span>Session timeline</span></div>{timeline.length ? <ol className="timeline">{timeline.map((event) => <li key={event.id}><span className="flow-dot" /><span>{event.text}</span><time>{event.time}</time></li>)}</ol> : <p className="debug-empty">No turn events yet.</p>}</section>
          <section className="debug-card"><div className="debug-card-head"><h3>Session status</h3><span>Live state</span></div><dl className="detail-list"><div><dt>Backend</dt><dd>{backendStatus} <button className="text-button" type="button" onClick={() => onRetryBackend()}>Retry</button></dd></div><div><dt>Startup</dt><dd>{startupState}</dd></div><div><dt>Session ready</dt><dd>{sessionReadySeconds === null ? '—' : `${sessionReadySeconds.toFixed(2)} s`}</dd></div><div><dt>Session</dt><dd>{sessionStatus}</dd></div><div><dt>Connection</dt><dd>{connectionStatus}</dd></div><div><dt>Microphone</dt><dd>{microphoneStatus}</dd></div><div><dt>Remote audio</dt><dd>{audioPlayback}</dd></div><div><dt>User activity</dt><dd>{userActivity}</dd></div><div><dt>Agent activity</dt><dd>{agentActivity}</dd></div><div><dt>State analysis</dt><dd>{stateStatus}</dd></div></dl></section>
          <section className="debug-card"><div className="debug-card-head"><h3>Errors</h3><span>Current session</span></div><div className="debug-errors">{activeErrors.length ? activeErrors.map((error, index) => <p key={index}>{error}</p>) : <p>No active errors.</p>}</div></section>
        </div>
      </div>
    </div>
      </div>
  )
}
