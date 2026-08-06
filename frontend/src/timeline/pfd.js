const HDG_PPD = 3;
const SPD_PPK = 2.5;
const ALT_PPF = 0.04;
const ALT_MAX = 50000;

export function createPFD({
  documentRef = document,
  timelineStore,
  pfdHdgTape = null,
  pfdSpdTape = null,
  pfdAltTape = null,
  pfdPitchMarks = null,
} = {}) {
  let initialised = false;

  function setStorePfdState(nextState = {}) {
    timelineStore.setPfdState(nextState);
  }

  function formatHeadingDisplay(headingDeg) {
    if (!Number.isFinite(headingDeg)) return '---';
    return Math.round(((headingDeg % 360) + 360) % 360).toString().padStart(3, '0');
  }

  function init() {
    if (initialised) return;
    initialised = true;

    if (pfdHdgTape) {
      const cardinals = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
      const frag = documentRef.createDocumentFragment();
      for (let copy = 0; copy < 3; copy++) {
        const offset = copy * 360 * HDG_PPD;
        for (let d = 0; d <= 360; d += 5) {
          const x = offset + d * HDG_PPD;
          const isMajor = d % 10 === 0;
          const tick = documentRef.createElement('span');
          tick.className = 'pfd-hdg-tick ' + (isMajor ? 'major' : 'minor');
          tick.style.left = x + 'px';
          frag.appendChild(tick);

          if (isMajor) {
            const label = documentRef.createElement('span');
            const deg360 = d % 360;
            const cardinal = cardinals[deg360];
            label.className = 'pfd-hdg-lbl' + (cardinal ? ' cardinal' : '');
            label.textContent = cardinal || String(deg360).padStart(3, '0');
            label.style.left = x + 'px';
            frag.appendChild(label);
          }
        }
      }
      pfdHdgTape.style.width = (360 * HDG_PPD * 3) + 'px';
      pfdHdgTape.appendChild(frag);
    }

    if (pfdSpdTape) {
      const frag = documentRef.createDocumentFragment();
      const maxSpd = 500;
      const tapeH = maxSpd * SPD_PPK;
      for (let s = 0; s <= maxSpd; s += 10) {
        const y = tapeH - s * SPD_PPK;
        const isMajor = s % 20 === 0;
        const tick = documentRef.createElement('span');
        tick.className = 'pfd-spd-tick ' + (isMajor ? 'major' : 'minor');
        tick.style.top = y + 'px';
        frag.appendChild(tick);
        if (isMajor) {
          const label = documentRef.createElement('span');
          label.className = 'pfd-spd-lbl';
          label.textContent = String(s);
          label.style.top = y + 'px';
          frag.appendChild(label);
        }
      }
      pfdSpdTape.style.height = tapeH + 'px';
      pfdSpdTape.appendChild(frag);
    }

    if (pfdAltTape) {
      const frag = documentRef.createDocumentFragment();
      const tapeH = ALT_MAX * ALT_PPF;
      for (let a = 0; a <= ALT_MAX; a += 100) {
        const y = tapeH - a * ALT_PPF;
        const isMajor = a % 500 === 0;
        const tick = documentRef.createElement('span');
        tick.className = 'pfd-alt-tick ' + (isMajor ? 'major' : 'minor');
        tick.style.top = y + 'px';
        frag.appendChild(tick);
        if (isMajor) {
          const label = documentRef.createElement('span');
          label.className = 'pfd-alt-lbl';
          label.textContent = a >= 1000 ? (a / 1000).toFixed(a % 1000 === 0 ? 0 : 1) + 'k' : String(a);
          label.style.top = y + 'px';
          frag.appendChild(label);
        }
      }
      pfdAltTape.style.height = tapeH + 'px';
      pfdAltTape.appendChild(frag);
    }

    if (pfdPitchMarks) {
      const frag = documentRef.createDocumentFragment();
      const pitchPpd = 4;
      for (let p = -90; p <= 90; p += 5) {
        if (p === 0) continue;
        const isMajor = p % 10 === 0;
        const line = documentRef.createElement('div');
        line.className = 'pfd-adi-pitch-line ' + (isMajor ? 'major' : 'minor');
        line.style.top = 'calc(50% - ' + (p * pitchPpd) + 'px)';
        frag.appendChild(line);
        if (isMajor) {
          const label = documentRef.createElement('div');
          label.className = 'pfd-adi-pitch-lbl';
          label.textContent = Math.abs(p);
          label.style.top = 'calc(50% - ' + (p * pitchPpd) + 'px)';
          label.style.left = 'calc(50% + 40px)';
          frag.appendChild(label);

          const label2 = documentRef.createElement('div');
          label2.className = 'pfd-adi-pitch-lbl';
          label2.textContent = Math.abs(p);
          label2.style.top = 'calc(50% - ' + (p * pitchPpd) + 'px)';
          label2.style.left = 'calc(50% - 50px)';
          frag.appendChild(label2);
        }
      }
      pfdPitchMarks.appendChild(frag);
    }
  }

  function update(frame = {}) {
    init();
    const headingDeg = Number(frame.headingDeg);
    const pitchDeg = Number(frame.pitchDeg);
    const rollDeg = Number(frame.rollDeg);
    const iasKts = Number(frame.iasKts);
    const altFt = Number(frame.altFt);
    const hasAny = Number.isFinite(headingDeg) || Number.isFinite(pitchDeg) || Number.isFinite(rollDeg);
    const pitch = Number.isFinite(pitchDeg) ? Math.max(-45, Math.min(45, pitchDeg)) : 0;
    const roll = Number.isFinite(rollDeg) ? Math.max(-90, Math.min(90, rollDeg)) : 0;
    const overlayOpacity = hasAny ? '1' : '0.4';
    const headingDisplay = formatHeadingDisplay(headingDeg);
    const speedDisplay = Number.isFinite(iasKts) ? String(Math.round(iasKts)) : '---';
    const altitudeDisplay = Number.isFinite(altFt) ? Math.round(altFt).toLocaleString() : '---';
    const pitchDisplay = Number.isFinite(pitchDeg) ? String(Math.round(pitchDeg)) : '---';
    const rollDisplay = Number.isFinite(rollDeg) ? String(Math.round(rollDeg)) : '---';
    const adiTransform = `rotate(${-roll}deg) translateY(${pitch * 4}px)`;
    const rollPointerTransform = `translateX(-50%) rotate(${Number.isFinite(rollDeg) ? rollDeg : 0}deg)`;

    setStorePfdState({
      overlayOpacity,
      headingDisplay,
      speedDisplay,
      altitudeDisplay,
      pitchDisplay,
      rollDisplay,
      adiTransform,
      rollPointerTransform,
    });

    if (pfdHdgTape) {
      const hdg = Number.isFinite(headingDeg) ? ((headingDeg % 360) + 360) % 360 : 0;
      const wrap = pfdHdgTape.parentElement;
      const cw = wrap ? wrap.clientWidth : 300;
      pfdHdgTape.style.transform = 'translateX(' + (-(hdg * HDG_PPD + 360 * HDG_PPD) + cw / 2) + 'px)';
    }

    if (pfdSpdTape) {
      const spd = Number.isFinite(iasKts) ? Math.max(0, iasKts) : 0;
      const tapeH = 500 * SPD_PPK;
      const wrap = pfdSpdTape.parentElement;
      const ch = wrap ? wrap.clientHeight : 180;
      pfdSpdTape.style.transform = 'translateY(' + (-(tapeH - spd * SPD_PPK) + ch / 2) + 'px)';
    }

    if (pfdAltTape) {
      const alt = Number.isFinite(altFt) ? Math.max(0, Math.min(ALT_MAX, altFt)) : 0;
      const tapeH = ALT_MAX * ALT_PPF;
      const wrap = pfdAltTape.parentElement;
      const ch = wrap ? wrap.clientHeight : 180;
      pfdAltTape.style.transform = 'translateY(' + (-(tapeH - alt * ALT_PPF) + ch / 2) + 'px)';
    }
  }

  function destroy() {
    initialised = false;
    timelineStore.resetPfdState();
  }

  return { init, update, destroy };
}
