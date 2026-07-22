(() => {
  const root = document.querySelector('[data-cinematic-login], [data-cinematic-intro]');
  if (!root) return;

  const intro = root.querySelector('[data-intro-canvas]');
  const ambient = root.querySelector('[data-ambient-canvas]');
  const introCopy = root.querySelector('[data-intro-copy]');
  const controls = root.querySelector('[data-intro-controls]');
  const replayButton = root.querySelector('[data-replay-intro]');
  const shouldAutoplayIntro = root.dataset.introAutoplay === 'true';
  const ictx = intro?.getContext('2d');
  const actx = ambient?.getContext('2d') || null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!intro || !ictx) return;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let startedAt = performance.now();
  let finished = !shouldAutoplayIntro;
  let soundOn = true;
  let audioContext;
  let stars = [];
  let dust = [];
  let background = [];

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    width = Math.max(1, innerWidth);
    height = Math.max(1, innerHeight);

    [intro, ambient].filter(Boolean).forEach(canvas => {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    });

    ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
    actx?.setTransform(dpr, 0, 0, dpr, 0, 0);

    stars = Array.from({ length: Math.min(360, Math.floor(width * height / 3200)) }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: Math.random() ** 0.62 * Math.min(width, height) * 0.55,
      z: 0.2 + Math.random() * 0.8,
      weight: 0.4 + Math.random() * 1.2
    }));

    dust = Array.from({ length: 180 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: Math.random() ** 0.75 * Math.min(width, height) * 0.44,
      z: Math.random()
    }));

    background = Array.from({ length: 130 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: 0.2 + Math.random() * 1.1,
      alpha: 0.1 + Math.random() * 0.42,
      phase: Math.random() * 10
    }));
  }

  function clamp(value, low = 0, high = 1) {
    return Math.max(low, Math.min(high, value));
  }

  function easeOutCubic(value) {
    return 1 - (1 - value) ** 3;
  }

  function roundedRect(context, x, y, rectWidth, rectHeight, radius) {
    const r = Math.min(radius, rectWidth / 2, rectHeight / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + rectWidth, y, x + rectWidth, y + rectHeight, r);
    context.arcTo(x + rectWidth, y + rectHeight, x, y + rectHeight, r);
    context.arcTo(x, y + rectHeight, x, y, r);
    context.arcTo(x, y, x + rectWidth, y, r);
    context.closePath();
  }

  function drawLine(x1, y1, x2, y2, color, lineWidth = 1, blur = 0) {
    ictx.beginPath();
    ictx.moveTo(x1, y1);
    ictx.lineTo(x2, y2);
    ictx.strokeStyle = color;
    ictx.lineWidth = lineWidth;
    ictx.shadowBlur = blur;
    ictx.shadowColor = color;
    ictx.stroke();
    ictx.shadowBlur = 0;
  }

  function drawCore(scale, alpha, rotation) {
    ictx.save();
    ictx.translate(width / 2, height / 2);
    ictx.rotate(rotation);
    ictx.globalAlpha = alpha;

    const coreWidth = 210 * scale;
    const coreHeight = 145 * scale;
    const gradient = ictx.createLinearGradient(-coreWidth / 2, -coreHeight / 2, coreWidth / 2, coreHeight / 2);
    gradient.addColorStop(0, 'rgba(255,58,83,.96)');
    gradient.addColorStop(0.55, 'rgba(232,0,43,.92)');
    gradient.addColorStop(1, 'rgba(94,0,18,.96)');

    ictx.fillStyle = gradient;
    ictx.shadowBlur = 55 * scale;
    ictx.shadowColor = 'rgba(255,20,55,.62)';
    roundedRect(ictx, -coreWidth / 2, -coreHeight / 2, coreWidth, coreHeight, 34 * scale);
    ictx.fill();
    ictx.shadowBlur = 0;
    ictx.lineWidth = 1.2;
    ictx.strokeStyle = 'rgba(255,255,255,.35)';
    ictx.stroke();

    ictx.beginPath();
    ictx.moveTo(-16 * scale, -34 * scale);
    ictx.lineTo(46 * scale, 0);
    ictx.lineTo(-16 * scale, 34 * scale);
    ictx.closePath();
    ictx.fillStyle = 'white';
    ictx.fill();
    ictx.restore();
  }

  function drawMetric(x, y, metricWidth, label, value, alpha, offset) {
    ictx.save();
    ictx.globalAlpha = alpha;
    ictx.translate(x + offset, y);
    ictx.fillStyle = 'rgba(12,15,22,.74)';
    ictx.strokeStyle = 'rgba(255,255,255,.14)';
    roundedRect(ictx, -metricWidth / 2, -42, metricWidth, 84, 16);
    ictx.fill();
    ictx.stroke();
    ictx.fillStyle = '#8f97a4';
    ictx.font = '10px system-ui';
    ictx.fillText(label.toUpperCase(), -metricWidth / 2 + 15, -14);
    ictx.fillStyle = '#f4f5f7';
    ictx.font = '600 19px system-ui';
    ictx.fillText(value, -metricWidth / 2 + 15, 16);
    ictx.restore();
  }

  function playSound() {
    if (!soundOn) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return;
    }

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(68, now);
    oscillator.frequency.exponentialRampToValueAtTime(34, now + 2.5);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(650, now);
    filter.frequency.exponentialRampToValueAtTime(130, now + 2.5);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);

    try {
      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 2.7);
    } catch {
      // Some browsers block automatic audio until a user gesture.
    }
  }

  function finishIntro() {
    finished = true;
    intro.classList.add('is-hidden');
    if (controls) controls.style.display = 'none';
    if (introCopy) introCopy.style.opacity = 0;
  }

  function startIntro() {
    if (reducedMotion) {
      finishIntro();
      return;
    }
    finished = false;
    intro.classList.remove('is-hidden');
    if (introCopy) introCopy.hidden = false;
    if (controls) controls.hidden = false;
    if (controls) controls.style.display = 'flex';
    startedAt = performance.now();
    playSound();
    requestAnimationFrame(drawIntro);
  }

  function drawIntro(now) {
    if (finished) return;

    const seconds = (now - startedAt) / 1000;
    const progress = clamp(seconds / 3);
    ictx.clearRect(0, 0, width, height);

    const gradient = ictx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
    gradient.addColorStop(0, '#16030a');
    gradient.addColorStop(0.34, '#09060b');
    gradient.addColorStop(1, '#020304');
    ictx.fillStyle = gradient;
    ictx.fillRect(0, 0, width, height);

    ictx.save();
    ictx.translate(width / 2, height / 2);
    ictx.rotate(seconds * 0.08);
    dust.forEach((item, index) => {
      const angle = item.angle + item.radius * 0.012 + seconds * 0.06;
      const radius = item.radius * (0.45 + progress * 0.65);
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius * 0.34;
      const alpha = (0.08 + item.z * 0.32) * (1 - clamp((seconds - 2.55) / 0.35));
      ictx.beginPath();
      ictx.arc(x, y, 0.3 + item.z * 1.35, 0, Math.PI * 2);
      ictx.fillStyle = index % 6 === 0 ? `rgba(255,28,62,${alpha})` : `rgba(255,255,255,${alpha * 0.72})`;
      ictx.fill();
    });
    ictx.restore();

    const warp = clamp((seconds - 0.2) / 1.25);
    stars.forEach((star, index) => {
      const angle = star.angle + seconds * 0.025;
      const endRadius = star.radius * (0.04 + warp * warp * 0.98);
      const startRadius = Math.max(0, endRadius - (14 + star.z * 46));
      const x1 = width / 2 + Math.cos(angle) * startRadius;
      const y1 = height / 2 + Math.sin(angle) * startRadius;
      const x2 = width / 2 + Math.cos(angle) * endRadius;
      const y2 = height / 2 + Math.sin(angle) * endRadius;
      const alpha = 0.08 + star.z * 0.55;
      const color = index % 10 === 0 ? `rgba(255,28,62,${alpha})` : `rgba(255,255,255,${alpha})`;
      drawLine(x1, y1, x2, y2, color, 0.4 + star.z * 1.2, index % 10 === 0 ? 8 : 0);
    });

    const assemble = clamp((seconds - 0.72) / 0.92);
    const impact = clamp((seconds - 1.62) / 0.22);
    let scale = 0.08 + easeOutCubic(assemble) * 0.74;
    if (impact > 0) scale *= 1 + Math.sin(impact * Math.PI) * 0.72;
    drawCore(scale, assemble * (1 - clamp((seconds - 2.48) / 0.35)), seconds * 0.035);

    const data = clamp((seconds - 1.48) / 0.55);
    const out = 1 - clamp((seconds - 2.45) / 0.32);
    drawMetric(width / 2 - 230, height / 2 - 96, 170, 'Scheduled', '18 uploads', data * out, -32 * (1 - easeOutCubic(data)));
    drawMetric(width / 2 + 230, height / 2 - 96, 170, 'Worker', 'Online', data * out, 32 * (1 - easeOutCubic(data)));
    drawMetric(width / 2 - 230, height / 2 + 102, 170, 'Formats', 'Video + Shorts', data * out, -32 * (1 - easeOutCubic(data)));
    drawMetric(width / 2 + 230, height / 2 + 102, 170, 'Session', 'Encrypted', data * out, 32 * (1 - easeOutCubic(data)));

    if (impact > 0) {
      const ring = clamp((seconds - 1.64) / 0.82);
      ictx.beginPath();
      ictx.arc(width / 2, height / 2, easeOutCubic(ring) * Math.max(width, height) * 0.52, 0, Math.PI * 2);
      ictx.strokeStyle = `rgba(255,35,68,${(1 - ring) * 0.45})`;
      ictx.lineWidth = 2;
      ictx.stroke();
    }

    const flash = Math.max(0, 1 - Math.abs(seconds - 1.67) / 0.11);
    if (flash > 0) {
      ictx.fillStyle = `rgba(255,255,255,${flash * 0.35})`;
      ictx.fillRect(0, 0, width, height);
    }

    if (introCopy) {
      if (seconds < 0.55) {
        introCopy.style.opacity = 0;
      } else if (seconds < 2.15) {
        const reveal = clamp((seconds - 0.55) / 0.5);
        introCopy.style.opacity = reveal;
        introCopy.style.transform = `translateY(${10 - 10 * reveal}px)`;
      } else {
        introCopy.style.opacity = 1 - clamp((seconds - 2.15) / 0.55);
      }
    }

    if (seconds >= 3) {
      finishIntro();
      return;
    }
    requestAnimationFrame(drawIntro);
  }

  function drawAmbient(now) {
    if (!actx) return;
    actx.clearRect(0, 0, width, height);
    const seconds = now / 1000;
    background.forEach((star, index) => {
      const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(seconds * 0.55 + star.phase));
      actx.beginPath();
      actx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      actx.fillStyle = index % 15 === 0 ? `rgba(255,35,68,${star.alpha * pulse})` : `rgba(255,255,255,${star.alpha * pulse})`;
      actx.fill();
    });
    if (!reducedMotion) requestAnimationFrame(drawAmbient);
  }

  window.addEventListener('resize', resize);
  resize();
  if (actx) requestAnimationFrame(drawAmbient);

  replayButton?.addEventListener('click', startIntro);

  root.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const field = button.closest('.pilot-field')?.querySelector('[data-password-field]');
      if (!field) return;
      const showing = field.type === 'text';
      field.type = showing ? 'password' : 'text';
      button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });

  root.querySelectorAll('[data-live-auth-form]').forEach(form => {
    form.addEventListener('submit', () => {
      const button = form.querySelector('.pilot-primary');
      if (!button) return;
      button.textContent = button.dataset.submitLabel || 'Working...';
      button.setAttribute('aria-busy', 'true');
    });
  });

  if (shouldAutoplayIntro) {
    startIntro();
  } else {
    finishIntro();
  }
})();
