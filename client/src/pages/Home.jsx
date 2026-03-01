import { useState, useRef } from 'react'

// ── SVG Grid Background ───────────────────────────────────────
function GridBackground() {
    const cols = 14;
    const rows = 10;
    const hLines = Array.from({ length: rows + 1 }, (_, i) => (i / rows) * 100);
    const vLines = Array.from({ length: cols + 1 }, (_, i) => (i / cols) * 100);

    return (
        <div className="grid-bg">
            <div className="blob blob-1" />
            <div className="blob blob-2" />
            <div className="blob blob-3" />
            <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
                {hLines.map((y, i) => (
                    <line key={`h${i}`} x1="0" y1={y} x2="100" y2={y} className="grid-line-h" />
                ))}
                {vLines.map((x, i) => (
                    <line key={`v${i}`} x1={x} y1="0" x2={x} y2="100" className="grid-line-v" />
                ))}
                {/* Intersection dots */}
                {hLines.filter((_, i) => i % 2 === 0).map((y) =>
                    vLines.filter((_, i) => i % 2 === 0).map((x) => (
                        <circle key={`d${x}-${y}`} cx={x} cy={y} r="0.5" fill="#22c55e" opacity="0.6" />
                    ))
                )}
            </svg>
        </div>
    )
}

// ── Call Status Banner ────────────────────────────────────────
function StatusBanner({ status, phoneNumber, callSid }) {
    if (status === 'idle') return null

    const config = {
        calling: {
            cls: 'calling',
            iconCls: 'ring',
            icon: '📲',
            title: 'Calling your phone…',
            sub: `Ringing ${phoneNumber} — please answer!`,
        },
        connected: {
            cls: 'connected',
            iconCls: '',
            icon: '🟢',
            title: 'Call initiated successfully',
            sub: `Call SID: ${callSid ? callSid.slice(0, 20) + '…' : ''}`,
        },
        error: {
            cls: 'ended',
            iconCls: '',
            icon: '❌',
            title: 'Could not place the call',
            sub: 'Check your .env keys and ngrok is running',
        },
    }

    const c = config[status]
    if (!c) return null

    return (
        <div className={`status-card ${c.cls}`}>
            <div className={`status-icon-wrap ${c.iconCls}`}>{c.icon}</div>
            <div className="status-text">
                <strong>{c.title}</strong>
                <span>{c.sub}</span>
            </div>
        </div>
    )
}

// ── Main Home Page ────────────────────────────────────────────
export default function Home() {
    const [phone, setPhone] = useState('')
    const [status, setStatus] = useState('idle')   // idle | calling | connected | error
    const [error, setError] = useState('')
    const [callSid, setCallSid] = useState('')
    const inputRef = useRef(null)

    const isLoading = status === 'calling'

    function formatPhone(val) {
        // Keep only digits and + prefix
        return val.replace(/[^0-9+]/g, '')
    }

    function handlePhoneChange(e) {
        setPhone(formatPhone(e.target.value))
        if (error) setError('')
        if (status !== 'idle') setStatus('idle')
    }

    function validate() {
        const digits = phone.replace(/\D/g, '')
        if (!phone) return 'Please enter your phone number.'
        if (digits.length < 10) return 'Please enter a valid phone number (at least 10 digits).'
        if (digits.length > 15) return 'Phone number is too long.'
        return ''
    }

    async function handleSubmit(e) {
        e.preventDefault()
        const validationError = validate()
        if (validationError) {
            setError(validationError)
            inputRef.current?.focus()
            return
        }

        setError('')
        setStatus('calling')

        try {
            const res = await fetch('/api/request-call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber: phone }),
            })

            const data = await res.json()

            if (!res.ok) {
                throw new Error(data.error || 'Failed to initiate call.')
            }

            setCallSid(data.callSid)
            setStatus('connected')
        } catch (err) {
            console.error('Call request failed:', err)
            setError(err.message || 'Something went wrong. Please try again.')
            setStatus('error')
        }
    }

    return (
        <div className="page">
            <GridBackground />

            <div className="card">
                {/* Logo */}
                <div className="brand">
                    <div className="brand-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.71 12 19.79 19.79 0 0 1 1.65 3.45 2 2 0 0 1 3.62 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 5.66 5.66l.96-.87a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                        </svg>
                    </div>
                    <h1>AI Call Bot</h1>
                    <p>Powered by Gemini · Deepgram · ElevenLabs</p>
                </div>

                {/* Customer Stories badge */}
                <div style={{ textAlign: 'center' }}>
                    <span className="pill-badge">
                        <span className="pill-dot" />
                        Customer Stories
                    </span>
                </div>

                {/* Tagline */}
                <p className="tagline">
                    Experience AI in <span>your voice</span>
                </p>
                <p className="sub-tagline">
                    Enter your phone number and we'll call you with a live AI assistant demo.
                </p>

                {/* Status Banner */}
                <StatusBanner status={status} phoneNumber={phone} callSid={callSid} />

                {/* Form */}
                <form onSubmit={handleSubmit} noValidate>
                    <div className="input-row">
                        <div className="phone-input-wrap">
                            <span className="phone-prefix">+</span>
                            <input
                                ref={inputRef}
                                id="phone-input"
                                type="tel"
                                className={`phone-input${error ? ' error' : ''}`}
                                placeholder="91XXXXXXXXXX"
                                value={phone}
                                onChange={handlePhoneChange}
                                disabled={isLoading}
                                autoComplete="tel"
                                inputMode="tel"
                                maxLength={16}
                                aria-label="Phone number"
                                aria-describedby={error ? 'phone-error' : undefined}
                            />
                        </div>

                        <button
                            type="submit"
                            className={`btn-demo${isLoading ? ' loading' : ''}`}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <>
                                    <span className="spinner" />
                                    Calling…
                                </>
                            ) : (
                                <>
                                    <span className="btn-icon">📞</span>
                                    Try Demo
                                </>
                            )}
                        </button>
                    </div>

                    {error && (
                        <p id="phone-error" className="form-msg error" role="alert">
                            ⚠️ {error}
                        </p>
                    )}
                </form>

                {/* Feature Row */}
                <div className="features">
                    <div className="feature">
                        <div className="feature-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 12h2M6 8h2M10 4h2M14 8h2M18 12h2M22 12h2" />
                                <path d="M6 16h2M10 20h2M14 16h2" />
                            </svg>
                        </div>
                        <span className="feature-label">AI in Your<br />Voice</span>
                    </div>

                    <div className="features-divider" />

                    <div className="feature">
                        <div className="feature-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                            </svg>
                        </div>
                        <span className="feature-label">Available<br />24/7</span>
                    </div>

                    <div className="features-divider" />

                    <div className="feature">
                        <div className="feature-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" />
                                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                            </svg>
                        </div>
                        <span className="feature-label">Multi<br />lingual</span>
                    </div>
                </div>
            </div>

            <p className="legal-text">
                By clicking Try Demo, you agree to receive one automated AI call.
                <br />This is a POC — powered by free-tier services.
            </p>
        </div>
    )
}
