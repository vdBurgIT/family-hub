// Family Hub's mark: a roof over two grown-ups and two kids (the heads), in the same colors Kinwall's
// mark used (brand-ink, --logo-heads). Kinwall's own drawing stays with Kinwall.
import { APP_NAME } from './appName.ts'

const HEADS: [number, number, number][] = [[37, 44, 6.5], [63, 44, 6.5], [44, 56.5, 5], [56, 56.5, 5]]

/** The mark, then the name as real text. Decorative (aria-hidden); the ink follows the scheme's
 * accent in light and its text color in dark (styles.css); the heads follow the scheme too
 * (--logo-heads, color.ts logoHeads), falling back to the readable accent. */
export function Brand() {
  return (
    <div className="brand-lockup">
      <svg className="brand-mark" viewBox="0 0 100 76" aria-hidden="true" focusable="false">
        <path className="brand-ink" d="M50 4 4 40l5.5 6.5L18 39.8V72h64V39.8l8.5 6.7L96 40 50 4zm24 60H26V33.5L50 14.6l24 18.9V64z" />
        <g className="brand-heads" style={{ fill: 'var(--logo-heads, var(--accent-text))' }}>{HEADS.map(([cx, cy, r]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />)}</g>
      </svg>
      <span className="brand-name">{APP_NAME}</span>
    </div>
  )
}
