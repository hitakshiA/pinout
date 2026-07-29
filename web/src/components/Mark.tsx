/**
 * The Pinout mark: a socket with four pins entering it.
 *
 * One component, used by the header, the footer and the README's SVG, because
 * the page used to introduce itself with a different drawing depending on
 * where you met it.
 */
export default function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none"
         aria-hidden="true" style={{ flex: "none" }}>
      <defs>
        <linearGradient id={`pm${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a98bff" /><stop offset="1" stopColor="#5b34c9" />
        </linearGradient>
      </defs>
      <g stroke="#8259ef" strokeWidth="9" strokeLinecap="round">
        <path d="M60 0 v18" /><path d="M60 120 v-18" />
        <path d="M0 60 h18" /><path d="M120 60 h-18" />
      </g>
      <rect x="18" y="18" width="84" height="84" rx="24" fill={`url(#pm${size})`} />
      <rect x="48" y="48" width="24" height="24" rx="7" fill="var(--bg)" />
    </svg>
  );
}
