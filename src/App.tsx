import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import './App.css'

type Role = 'user' | 'assistant'

type ChatMessage = {
  id: string
  role: Role
  content: string
}

type ApiChatMessage = {
  role: Role
  content: string
}

type Mode = 'capture' | 'query'

const starterPrompts: Record<Mode, string[]> = {
  capture: [
    'Lunch at GitHub Cafe today was RM18.50 for nasi lemak.',
    'Dinner yesterday at Kopitiam was RM24 for noodles.',
    'Coffee at the office pantry today was RM7.50.',
  ],
  query: [
    'How much have I spent on lunch in total?',
    'Show my top 5 most expensive meals.',
    'Group my spending by place for this month.',
  ],
}

const initialMessages: ChatMessage[] = [
  {
    id: crypto.randomUUID(),
    role: 'assistant',
    content:
      'Send an expense to save it, or switch to Query expenses to ask questions about your database.',
  },
]

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [mode, setMode] = useState<Mode>('capture')
  const [prompt, setPrompt] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isSending])

  const submitPrompt = async (nextPrompt: string) => {
    const trimmedPrompt = nextPrompt.trim()
    if (!trimmedPrompt || isSending) {
      return
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedPrompt,
    }

    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setPrompt('')
    setError('')
    setIsSending(true)

    try {
      const response = await fetch(mode === 'capture' ? '/api/chat' : '/api/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: nextMessages.map<ApiChatMessage>(({ role, content }) => ({
            role,
            content,
          })),
        }),
      })

      const data = (await response.json()) as { reply?: string; error?: string }

      const reply = data.reply

      if (!response.ok || !reply) {
        throw new Error(data.error ?? 'Unable to generate a reply right now.')
      }

      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: reply,
        },
      ])
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : 'Something went wrong while contacting the worker.',
      )
    } finally {
      setIsSending(false)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await submitPrompt(prompt)
  }

  const handleComposerKeyDown = async (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      await submitPrompt(prompt)
    }
  }

  return (
    <main className='app-shell'>
      <section className='chat-panel chat-panel-full'>
        <header className='chat-header'>
          <div>
            <p className='eyebrow'>Assistant</p>
            <h2>Billing Lunch</h2>
          </div>
          <span className={`status-pill ${isSending ? 'busy' : ''}`}>
            {isSending ? 'Thinking...' : 'Ready'}
          </span>
        </header>

        <div className='mode-row' aria-label='Mode'>
          <button
            type='button'
            className={mode === 'capture' ? 'active' : ''}
            onClick={() => setMode('capture')}
          >
            Save expense
          </button>
          <button
            type='button'
            className={mode === 'query' ? 'active' : ''}
            onClick={() => setMode('query')}
          >
            Query expenses
          </button>
        </div>

        <div className='prompt-row' aria-label='Suggested prompts'>
          {starterPrompts[mode].map((starterPrompt) => (
            <button
              key={starterPrompt}
              type='button'
              className='prompt-chip'
              onClick={() => setPrompt(starterPrompt)}
            >
              {starterPrompt}
            </button>
          ))}
        </div>

        <div className='chat-thread' aria-live='polite'>
          {messages.map((message) => (
            <article
              key={message.id}
              className={`message message-${message.role}`}
            >
              <span className='message-role'>
                {message.role === 'assistant' ? 'AI' : 'You'}
              </span>
              <p>{message.content}</p>
            </article>
          ))}

          {isSending ? (
            <article className='message message-assistant pending'>
              <span className='message-role'>AI</span>
              <p>Thinking through your request...</p>
            </article>
          ) : null}

          <div ref={messagesEndRef} />
        </div>

        <form className='composer' onSubmit={handleSubmit}>
          <label className='sr-only' htmlFor='prompt'>
            Message
          </label>
          <textarea
            id='prompt'
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              mode === 'capture'
                ? 'Save an expense, for example: Lunch at GitHub Cafe today was RM18.50 for nasi lemak.'
                : 'Ask a reporting question, for example: How much did I spend on lunch this month?'
            }
            rows={4}
          />
          <div className='composer-footer'>
            <p>Press Enter to send. Use Shift + Enter for a new line.</p>
            <button type='submit' disabled={isSending || !prompt.trim()}>
              Send message
            </button>
          </div>
          {error ? <p className='error-text'>{error}</p> : null}
        </form>
      </section>
    </main>
  )
}

export default App
