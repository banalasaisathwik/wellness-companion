import type { ConversationState } from '../voice/types'

const strategyDetails: Record<string, { title: string; description: string }> = {
  LISTEN: { title: 'Listening', description: 'Make room for what you want to share.' },
  CLARIFY: { title: 'Clarifying', description: 'Understand what matters most right now.' },
  ENCOURAGE: { title: 'Encouragement', description: 'Offer steady, practical support.' },
  GROUND: { title: 'Grounding', description: 'Slow the conversation and return to the present.' },
  PROBLEM_SOLVE: { title: 'Problem solving', description: 'Work through a next step together.' },
  CHECK_IN: { title: 'Checking in', description: 'Pause and see how this feels for you.' },
}

type StatePanelProps = {
  conversationState: ConversationState
  stateStatus: string
  stateConfidence: number | null
  strategy: string
}

export function StatePanel({ conversationState, stateStatus, stateConfidence, strategy }: StatePanelProps) {
  const currentStrategy = strategyDetails[strategy]
  return <>
    <section className="glass-panel state-panel" aria-labelledby="state-heading">
      <div className="panel-heading"><h2 id="state-heading">Current state</h2></div>
      <p className="state-summary">{conversationState.sentiment === 'UNKNOWN'
        ? stateStatus === 'Updated for current turn' ? 'Tone unknown this turn' : 'Awaiting analysis'
        : `${conversationState.sentiment.toLowerCase()} tone`}</p>
      <div className="state-values">{(['energy', 'stress', 'frustration'] as const).map((dimension) => <div key={dimension}><span>{dimension}</span><strong>{conversationState[dimension].toLowerCase()}</strong></div>)}</div>
      {stateConfidence !== null && <p className="state-confidence">Current turn confidence: {Math.round(stateConfidence * 100)}%</p>}
    </section>
    <section className="glass-panel strategy-panel" aria-labelledby="strategy-heading">
      <div className="panel-heading"><h2 id="strategy-heading">Guided strategy</h2></div>
      <strong>{currentStrategy?.title ?? strategy.replaceAll('_', ' ')}</strong>
      <p>{currentStrategy?.description ?? 'Waiting for the next turn.'}</p>
    </section>
  </>
}
