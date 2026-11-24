import { useRef, useState } from 'react'
import {
  AudioLines, Check, ChevronRight, CircleAlert, Clock3, Download, FileAudio, FileMusic,
  Fingerprint, Headphones, LoaderCircle, LockKeyhole, Music2, Plus, ShieldCheck, Sparkles,
  Upload, X,
} from 'lucide-react'
import { analyzeFile, SUPPORTED_AUDIO } from './dsp/analyze'
import type { AnalysisResult, Verdict } from './dsp/types'
import Spectrogram from './components/Spectrogram'

interface Track {
  id: string
  file: File
  status: 'queued' | 'analyzing' | 'done' | 'error'
  result?: AnalysisResult
  error?: string
}

const verdictLabel: Record<Verdict, string> = {
  GENUINE_LOSSLESS: 'Lossless-Quelle wahrscheinlich',
  SUSPICIOUS: 'Band-limited / verdächtig',
  FAKE_TRANSCODE: 'Lossy-Transcode erkannt',
}
const verdictClass: Record<Verdict, string> = {
  GENUINE_LOSSLESS: 'green',
  SUSPICIOUS: 'amber',
  FAKE_TRANSCODE: 'red',
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

function formatRate(rate: number): string {
  return rate ? `${(rate / 1000).toFixed(rate % 1000 ? 1 : 0)} kHz` : '—'
}

function exportCsv(tracks: Track[]) {
  const records = tracks.filter((track) => track.result)
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`
  const rows = [
    ['File', 'Verdict', 'Confidence (%)', 'Cutoff (kHz)', 'Sample rate', 'Bit depth', 'Channels', 'Duration (s)', 'Estimated source bitrate (kbps)', 'FLAC MD5'],
    ...records.map(({ file, result }) => [
      file.name,
      verdictLabel[result!.verdict],
      result!.confidence,
      result!.cutoffKhz?.toFixed(2) ?? '',
      result!.metadata.sampleRate,
      result!.metadata.bitDepth ?? '',
      result!.metadata.channels,
      result!.metadata.duration.toFixed(2),
      result!.estimatedSourceBitrate ?? '',
      result!.metadata.md5 ?? '',
    ]),
  ]
  const csv = `\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'trueflac-analysis.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const analysisQueue = useRef<Promise<void>>(Promise.resolve())
  const [tracks, setTracks] = useState<Track[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const selected = tracks.find((track) => track.id === selectedId) ?? tracks.find((track) => track.result)

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    const accepted = files.filter((file) => SUPPORTED_AUDIO.includes(file.name.split('.').pop()?.toLowerCase() ?? ''))
    const rejectedCount = files.length - accepted.length
    setUploadError(rejectedCount ? `${rejectedCount} Datei(en) übersprungen. Unterstützt werden FLAC, WAV, AIFF, MP3, M4A und OGG.` : null)
    if (!accepted.length) return
    const added = accepted.map((file): Track => ({
      id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
      file,
      status: 'queued',
    }))
    setTracks((current) => [...current, ...added])
    setSelectedId((current) => current ?? added[0].id)
    added.forEach((track) => {
      analysisQueue.current = analysisQueue.current.then(async () => {
        setTracks((current) => current.map((item) => item.id === track.id ? { ...item, status: 'analyzing' } : item))
        try {
          const result = await analyzeFile(track.file)
          setTracks((current) => current.map((item) => item.id === track.id ? { ...item, status: 'done', result } : item))
        } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Analyse fehlgeschlagen.'
        setTracks((current) => current.map((item) => item.id === track.id ? { ...item, status: 'error', error: message } : item))
        }
      })
    })
  }

  function removeTrack(id: string) {
    setTracks((current) => current.filter((track) => track.id !== id))
    if (selectedId === id) setSelectedId(tracks.find((track) => track.id !== id)?.id ?? null)
  }

  const completeCount = tracks.filter((track) => track.result).length

  return (
    <main id="top">
      <header className="topbar">
        <a className="brand" href="#" aria-label="TrueFLAC Startseite">
          <span className="brand-mark"><AudioLines size={21} strokeWidth={2.2} /></span>
          <span>True<span className="brand-light">FLAC</span></span>
        </a>
        <div className="privacy-badge"><LockKeyhole size={13} />100 % lokal im Browser <span className="privacy-dot">•</span> Keine Uploads</div>
        <a className="top-link" href="#how-it-works">So funktioniert's <ChevronRight size={14} /></a>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-dot" />PRIVATE AUDIO ANALYSE</div>
        <h1>Ist dein Lossless<br /><span>auch wirklich lossless?</span></h1>
        <p className="hero-copy">Erkenne versteckte Lossy-Transcodes anhand ihres Frequenzspektrums.<br className="desktop-break" /> Deine Audiodateien verlassen niemals deinen Browser.</p>

        <div
          className={`dropzone ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files) }}
        >
          <div className="upload-icon"><Upload size={23} /></div>
          <h2>Dateien hier ablegen</h2>
          <p>oder <button className="inline-button" onClick={() => inputRef.current?.click()}>Dateien auswählen</button></p>
          <span className="format-hint"><FileAudio size={13} /> FLAC, WAV, AIFF, MP3, M4A, OGG <i /> Mehrere Dateien möglich</span>
          <input ref={inputRef} type="file" accept=".flac,.wav,.wave,.aiff,.aif,.mp3,.m4a,.ogg,audio/*" multiple hidden onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
        </div>
        {uploadError && <p className="upload-error" role="status"><CircleAlert size={13} />{uploadError}</p>}

        <div className="trust-row"><ShieldCheck size={15} /> 100 % client-seitig <span /> Keine Server-Uploads <span /> Deine Dateien bleiben privat</div>
      </section>

      {tracks.length > 0 && (
        <section className="workspace">
          <div className="section-heading">
            <div><span className="section-kicker">DEINE ANALYSE</span><h2>Ergebnisse <small>{completeCount} / {tracks.length}</small></h2></div>
            <div className="toolbar">
              <button className="button secondary" onClick={() => inputRef.current?.click()}><Plus size={15} /> Dateien hinzufügen</button>
              <button className="button export" disabled={!completeCount} onClick={() => exportCsv(tracks)}><Download size={15} /> CSV exportieren</button>
            </div>
          </div>
          <div className="results-layout">
            <aside className="queue card">
              <div className="queue-header"><span>DATEI-QUEUE</span><span>{tracks.length} {tracks.length === 1 ? 'Datei' : 'Dateien'}</span></div>
              <div className="track-list">
                {tracks.map((track) => {
                  const verdict = track.result?.verdict
                  return (
                    <button className={`track-row ${selected?.id === track.id ? 'selected' : ''}`} key={track.id} onClick={() => setSelectedId(track.id)}>
                      <span className={`track-icon ${verdict ? verdictClass[verdict] : track.status === 'error' ? 'red' : ''}`}>
                        {track.status === 'analyzing' || track.status === 'queued' ? <LoaderCircle className="spin" size={16} /> : track.status === 'error' ? <CircleAlert size={16} /> : <FileMusic size={16} />}
                      </span>
                      <span className="track-info">
                        <strong title={track.file.name}>{track.file.name}</strong>
                        <small>{track.result ? `${track.result.metadata.format} · ${formatRate(track.result.metadata.sampleRate)}` : track.status === 'error' ? track.error : track.status === 'queued' ? 'Wartet in der Analyse-Queue …' : 'Analysiere lokal …'}</small>
                      </span>
                      <span className={`mini-status ${verdict ? verdictClass[verdict] : track.status === 'error' ? 'red' : 'muted'}`}>
                        {verdict === 'GENUINE_LOSSLESS' ? 'Lossless' : verdict === 'SUSPICIOUS' ? 'Verdächtig' : verdict === 'FAKE_TRANSCODE' ? 'Transcode' : track.status === 'error' ? 'Fehler' : 'Wartet'}
                      </span>
                      <span className="remove-track" onClick={(event) => { event.stopPropagation(); removeTrack(track.id) }} aria-label={`${track.file.name} entfernen`}><X size={14} /></span>
                    </button>
                  )
                })}
              </div>
              <div className="queue-foot"><LockKeyhole size={12} /> Audiodaten werden nur lokal verarbeitet.</div>
            </aside>

            <section className="detail-column">
              {selected?.result ? (
                <>
                  <VerdictPanel result={selected.result} />
                  <div className="card metadata-card">
                    <div className="card-title"><span>DATEI-METADATEN</span><span className="filename" title={selected.file.name}>{selected.file.name}</span></div>
                    <div className="metrics">
                      <Metric icon={<AudioLines />} label="Sample Rate" value={formatRate(selected.result.metadata.sampleRate)} />
                      <Metric icon={<Sparkles />} label="Bit Depth" value={selected.result.metadata.bitDepth ? `${selected.result.metadata.bitDepth}-bit` : 'Unbekannt'} />
                      <Metric icon={<Headphones />} label="Datei-Bitrate" value={selected.result.metadata.fileBitrate ? `${Math.round(selected.result.metadata.fileBitrate / 1000)} kbps` : '—'} />
                      <Metric icon={<Clock3 />} label="Dauer / Kanäle" value={`${formatDuration(selected.result.metadata.duration)} · ${selected.result.metadata.channels} ch`} />
                      <Metric icon={<Fingerprint />} label="FLAC MD5" value={selected.result.metadata.md5 ?? 'Nicht verfügbar'} wide />
                    </div>
                  </div>
                  <div className="card chart-card">
                    <div className="card-title chart-title"><span>SPEKTROGRAMM</span><span className="chart-subtitle">MITTELSEGMENT · {selected.result.segmentDuration.toFixed(1)} SEKUNDEN</span></div>
                    <Spectrogram result={selected.result} />
                    <div className="chart-caption"><span><i className="legend-spectrum" /> Frequenzenergie</span>{selected.result.cutoffKhz !== null && <span><i className="legend-cutoff" /> Erkannter Cutoff</span>}<span className="hover-hint">Hover für Frequenz &amp; Zeit</span></div>
                  </div>
                </>
              ) : selected?.status === 'error' ? (
                <div className="card empty-detail error-detail"><CircleAlert size={25} /><h3>Analyse nicht möglich</h3><p>{selected.error}</p><small>Die Datei bleibt lokal in deinem Browser.</small></div>
              ) : (
                <div className="card empty-detail"><LoaderCircle className="spin" size={25} /><h3>Audio wird analysiert</h3><p>Header werden gelesen und das Frequenzspektrum wird lokal berechnet.</p></div>
              )}
            </section>
          </div>
        </section>
      )}

      <section className="how-section" id="how-it-works">
        <div className="section-heading how-heading"><div><span className="section-kicker">HINTER DER ANALYSE</span><h2>Lossless auf dem Prüfstand</h2></div><p>Ein kleiner Blick ins Frequenzspektrum sagt manchmal mehr als das Dateiformat.</p></div>
        <div className="info-cards">
          <InfoCard number="01" icon={<AudioLines />} title="Spektrum statt Etikett" text="FLAC kann auch eine verlustbehaftete Quelle enthalten. Die Analyse sucht in repräsentativen 10-Sekunden-Ausschnitten nach abrupten Energieabbrüchen." />
          <InfoCard number="02" icon={<Sparkles />} title="Die Spur bei 16–19 kHz" text="MP3-Encoder bei niedrigerer Bitrate begrenzen oft die hohen Frequenzen. Ein scharfer Cutoff um 16 oder 19 kHz ist ein typischer Hinweis." />
          <InfoCard number="03" icon={<ShieldCheck />} title="Hinweis, kein Urteil" text="Cutoffs bei 16, 19 oder 20 kHz können auf MP3/AAC hindeuten. Aufnahme, Mastering und Instrumente beeinflussen das Spektrum ebenfalls – ein Ergebnis beweist nicht die Entstehung." />
        </div>
        <footer><span className="footer-brand"><Music2 size={15} /> TrueFLAC</span><span>Privat by design. Deine Musik bleibt deine.</span><a href="#top" onClick={(event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Zurück nach oben ↑</a></footer>
      </section>
    </main>
  )
}

function VerdictPanel({ result }: { result: AnalysisResult }) {
  return (
    <div className={`verdict-panel ${verdictClass[result.verdict]}`}>
      <div className="verdict-main">
        <span className="verdict-icon">{result.verdict === 'GENUINE_LOSSLESS' ? <Check size={21} /> : <CircleAlert size={21} />}</span>
        <div><span className="section-kicker">ANALYSE-ERGEBNIS</span><h2>{verdictLabel[result.verdict]}</h2></div>
        <div className="confidence"><strong>{result.confidence}<small>%</small></strong><span>Confidence</span></div>
      </div>
      <p>{result.explanation}</p>
      <div className="verdict-tags">
        <span><b>Erkannter Cutoff</b>{result.cutoffKhz !== null ? `${result.cutoffKhz.toFixed(1)} kHz` : 'Keiner'}</span>
        <span><b>Quell-Bitrate</b>{result.estimatedSourceBitrate ? `~${result.estimatedSourceBitrate} kbps` : 'Nicht geschätzt'}</span>
      </div>
    </div>
  )
}

function Metric({ icon, label, value, wide = false }: { icon: React.ReactNode; label: string; value: string; wide?: boolean }) {
  return <div className={`metric ${wide ? 'wide' : ''}`}><span className="metric-icon">{icon}</span><span className="metric-copy"><small>{label}</small><strong title={value}>{value}</strong></span></div>
}

function InfoCard({ number, icon, title, text }: { number: string; icon: React.ReactNode; title: string; text: string }) {
  return <article className="info-card"><div className="info-card-top"><span className="info-icon">{icon}</span><span>{number}</span></div><h3>{title}</h3><p>{text}</p></article>
}

export default App
