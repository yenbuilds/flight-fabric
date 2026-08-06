export function normalizeHeadingDeg(value) {
  const heading = Number(value);
  if (!Number.isFinite(heading)) return 0;
  return ((heading % 360) + 360) % 360;
}

export function buildPlaneIconHtml(className) {
  return `
    <div class="${className}" aria-hidden="true">
      <svg class="plane-glyph-svg" viewBox="0 0 32 32" focusable="false" role="img" aria-label="Aircraft">
        <path
          d="M16 1.8c0.9 0 1.6 0.7 1.7 1.6l1.2 10.2 10.6 6.1c0.6 0.3 0.9 1 0.7 1.6l-0.7 2.5c-0.1 0.5-0.6 0.7-1.1 0.5l-9.2-3.2 0.7 5.9 3.1 2.2c0.3 0.2 0.4 0.6 0.3 0.9l-0.4 1.1-5.3-1.7c-1.1-0.4-2.3-0.4-3.4 0l-5.3 1.7-0.4-1.1c-0.1-0.3 0-0.7 0.3-0.9l3.1-2.2 0.7-5.9-9.2 3.2c-0.5 0.2-1-0.1-1.1-0.5l-0.7-2.5c-0.2-0.6 0.1-1.3 0.7-1.6l10.6-6.1 1.2-10.2c0.1-0.9 0.8-1.6 1.7-1.6Z"
        />
        <path d="M16 5.4 15 14.7 16 18.8 17 14.7 16 5.4Z" fill="#ffffff" fill-opacity="0.35" />
      </svg>
    </div>
  `;
}
