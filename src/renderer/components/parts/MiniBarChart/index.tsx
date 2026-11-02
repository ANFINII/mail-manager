interface Point {
  label: string
  value: number
}

/**
 * 1 系列の小さな棒グラフ（1 分ごとの件数など）。凡例は不要（見出しが系列名）。
 * 棒の上端だけ角丸、棒どうしは 2px 空け、各棒にホバーでツールチップ（棒より広い当たり判定）。
 */
export default function MiniBarChart(props: {
  title: string
  points: Point[]
  color: string
  unit: string
  startLabel: string
  endLabel: string
  'data-testid'?: string
}): React.JSX.Element {
  const { points, color } = props
  const W = 600
  const H = 120
  const top = 14
  const bottom = 18
  const max = Math.max(1, ...points.map((p) => p.value))
  const slot = W / Math.max(1, points.length)
  const bw = Math.max(2, slot - 2)
  const plotH = H - top - bottom
  const total = points.reduce((n, p) => n + p.value, 0)
  return (
    <figure className="mini-chart" data-testid={props['data-testid']}>
      <figcaption>
        <span>{props.title}</span>
        <span className="muted small">
          {total} {props.unit}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${props.title}: ${total} ${props.unit}`}>
        <text x={0} y={10} className="mini-chart-axis">
          {max}
        </text>
        <line x1={0} x2={W} y1={top} y2={top} className="mini-chart-grid" />
        {points.map((p, i) => {
          const h = (p.value / max) * plotH
          const x = i * slot
          const y = top + plotH - h
          const r = Math.min(4, bw / 2, h)
          return (
            <g key={i} className="mini-chart-bar">
              <title>{`${p.label}: ${p.value} ${props.unit}`}</title>
              <rect x={x} y={top} width={slot} height={plotH} fill="transparent" />
              {p.value > 0 && (
                <path
                  d={`M${x},${top + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${top + plotH} Z`}
                  fill={color}
                />
              )}
            </g>
          )
        })}
        <line x1={0} x2={W} y1={top + plotH} y2={top + plotH} className="mini-chart-baseline" />
        <text x={0} y={H - 4} className="mini-chart-axis">
          {props.startLabel}
        </text>
        <text x={W} y={H - 4} textAnchor="end" className="mini-chart-axis">
          {props.endLabel}
        </text>
      </svg>
    </figure>
  )
}
