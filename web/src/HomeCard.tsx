// Family Hub: the board's Home card. Tiles for the lights, switches and scenes a parent picked in
// Home Assistant; a tap switches one. The server holds the Home Assistant address and token
// (server/src/routes/home.ts), so this only ever sees the picked tiles.
import { useCallback, useEffect, useState } from 'react'
import { api, type HomeDomain, type HomeEntity, type HomeInfo, type HomeTile } from './api.ts'
import { useApp } from './AppContext.tsx'
import { msg, t, tm } from './i18n.ts'
import Sheet from './Sheet.tsx'

const POLL_MS = 15_000

const ICON: Record<HomeDomain, [string, string]> = {
  light: ['💡', '🌑'], switch: ['🔌', '🔌'], fan: ['🌀', '🌀'], input_boolean: ['✅', '⬜'],
  scene: ['🎬', '🎬'], script: ['▶️', '▶️'], cover: ['🪟', '🪟'], lock: ['🔒', '🔓'],
}
const DOMAIN_NAMES: Record<HomeDomain, string> = {
  light: msg('Lights'), switch: msg('Switches'), fan: msg('Fans'), input_boolean: msg('Helpers'),
  scene: msg('Scenes'), script: msg('Scripts'), cover: msg('Blinds and curtains'), lock: msg('Locks'),
}

/** What a tile says under its name: "On · 60%", "Off", "Open", "Locked", or nothing for a scene. */
function stateText(tile: HomeTile): string {
  if (tile.state === 'unavailable' || tile.state === 'unknown') return t('Not reachable')
  switch (tile.domain) {
    case 'scene': case 'script': return t('Tap to start')
    case 'lock': return tile.on ? t('Locked') : t('Unlocked · tap to lock')
    case 'cover': return tile.on ? t('Open') : t('Closed')
    default: return tile.on ? (tile.brightness !== null ? t('On · {n}%', { n: tile.brightness }) : t('On')) : t('Off')
  }
}

/** The card's tiles, read again every 15 s while the screen is on; nothing when `on` is false. */
export function useHome(on: boolean) {
  const [home, setHome] = useState<HomeInfo | null>(null)
  const load = useCallback(() => { api.getHome().then(setHome, () => {}) }, [])
  useEffect(() => {
    if (!on) return
    load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    return () => clearInterval(id)
  }, [load, on])
  return { home, setHome, reload: load }
}

export default function HomeTiles({ home, setHome, reload }: ReturnType<typeof useHome>) {
  const { parentDevice } = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  if (!home) return null
  const toggle = async (tile: HomeTile) => {
    if (busy) return
    setBusy(tile.entityId); setFailed(null)
    try {
      const now = await api.toggleHome(tile.entityId)
      setHome(h => h && { ...h, tiles: h.tiles.map(x => x.entityId === now.entityId ? now : x) })
    } catch {
      setFailed(t("That didn't switch. Home Assistant can't be reached right now."))
    } finally { setBusy(null) }
  }

  return (
    <>
      {!home.configured && <p className="snap-empty">{t('Home Assistant isn’t set up on the server yet.')}</p>}
      {home.error && <p className="snap-empty">{t("Home Assistant can't be reached right now.")}</p>}
      {failed && <p className="snap-empty" role="alert">{failed}</p>}
      {home.configured && !home.tiles.length && !home.error && <p className="snap-empty">{t('No lights or switches on the board yet.')}</p>}
      {home.tiles.length > 0 && (
        <ul className="home-tiles">
          {home.tiles.map(tile => (
            <li key={tile.entityId}>
              <button type="button" className={`home-tile${tile.on ? ' on' : ''}`} onClick={() => void toggle(tile)} disabled={busy === tile.entityId}
                aria-pressed={tile.domain === 'scene' || tile.domain === 'script' ? undefined : tile.on}
                aria-label={`${tile.name}: ${stateText(tile)}`}>
                <span className="home-tile-icon" aria-hidden="true">{ICON[tile.domain][tile.on ? 0 : 1]}</span>
                <span className="home-tile-name" aria-hidden="true">{tile.name}</span>
                <span className="home-tile-state" aria-hidden="true">{busy === tile.entityId ? t('Switching…') : stateText(tile)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {parentDevice && home.configured && <button type="button" className="link-btn home-pick" onClick={() => setPicking(true)}>{t('Choose lights and switches…')}</button>}
      {picking && <PickTiles current={home.tiles.map(x => x.entityId)} onClose={() => setPicking(false)} onSaved={() => { setPicking(false); reload() }} />}
    </>
  )
}

/** Parents' devices: tick what goes on the board, grouped by kind, in the order ticked. */
function PickTiles({ current, onClose, onSaved }: { current: string[]; onClose: () => void; onSaved: () => void }) {
  const [entities, setEntities] = useState<HomeEntity[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string[]>(current)
  const [query, setQuery] = useState('')
  useEffect(() => { api.getHomeEntities().then(setEntities, () => setError(t("Home Assistant can't be reached right now."))) }, [])
  const flip = (id: string) => setChosen(c => c.includes(id) ? c.filter(x => x !== id) : [...c, id])
  const save = async () => {
    try { await api.setHomeTiles(chosen); onSaved() } catch { setError(t("That couldn't be saved. Try again.")) }
  }
  const q = query.trim().toLowerCase()
  const shown = (entities ?? []).filter(e => !q || e.name.toLowerCase().includes(q) || e.entityId.includes(q))
  const groups = [...new Set(shown.map(e => e.domain))]
  return (
    <Sheet title={t('Lights and switches on the board')} onClose={onClose}
      actions={<button className="btn btn-primary btn-block" onClick={() => void save()}>{t('Save')}</button>}>
      {error && <p className="snap-empty" role="alert">{error}</p>}
      {!entities && !error && <p className="snap-empty">{t('Loading…')}</p>}
      {entities && <>
        <div className="field"><label htmlFor="home-search">{t('Search')}</label><input id="home-search" value={query} onChange={e => setQuery(e.target.value)} /></div>
        {groups.map(d => (
          <fieldset key={d} className="home-pick-group">
            <legend>{tm(DOMAIN_NAMES[d])}</legend>
            {shown.filter(e => e.domain === d).map(e => (
              <label key={e.entityId} className="home-pick-row">
                <input type="checkbox" checked={chosen.includes(e.entityId)} onChange={() => flip(e.entityId)} />
                <span>{e.name}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </>}
    </Sheet>
  )
}
