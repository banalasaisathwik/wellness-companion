import type { ConversationMessage } from '../conversation'

type ConversationPanelProps = { conversationMessages: ConversationMessage[] }

export function ConversationPanel({ conversationMessages }: ConversationPanelProps) {
  return (
    <section className="glass-panel conversation-panel" aria-labelledby="conversation-heading">
      <div className="panel-heading"><h2 id="conversation-heading">Conversation</h2><span className="panel-live"><span className="status-dot" />Live</span></div>
      <div className="conversation-messages" aria-live="polite">
        {conversationMessages.length === 0 && <p className="empty">Your words will appear here when you speak.</p>}
        {conversationMessages.map((message) => <div className={`message ${message.final ? '' : 'partial'}`} key={message.id}>
          <span className={`message-dot ${message.role}`} aria-hidden="true" />
          <div className="message-content"><div className="message-meta"><strong>{message.role === 'assistant' ? 'Luna' : 'You'}</strong>{message.interrupted ? <span>Interrupted</span> : !message.final ? <span>{message.role === 'user' ? 'Listening' : 'Speaking'}</span> : null}</div><p>{message.text}</p></div>
        </div>)}
      </div>
    </section>
  )
}
