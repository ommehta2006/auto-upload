const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];

document.addEventListener('submit', event => {
  const message = event.target?.dataset?.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

$$('[data-dismiss-flash]').forEach(button => button.addEventListener('click', () => button.closest('.flash')?.remove()));

$$('input[type="file"]').forEach(input => input.addEventListener('change', () => {
  const form = input.closest('form');
  const selected = input.files?.length || 0;
  const target = form?.querySelector('label em, .file-selection');
  if (target) target.textContent = selected ? `${selected} file${selected === 1 ? '' : 's'} selected` : 'Choose files';
}));

function updateComposer(form) {
  const type = form.querySelector('input[name="contentType"]:checked')?.value || 'VIDEO';
  form.dataset.contentType = type;
  form.querySelectorAll('[data-short-only]').forEach(node => { node.hidden = type !== 'SHORT'; });
  form.querySelectorAll('[data-video-only]').forEach(node => { node.hidden = type !== 'VIDEO'; });
  const visibility = form.querySelector('[data-visibility]')?.value;
  form.querySelectorAll('[data-schedule-field]').forEach(node => { node.hidden = visibility !== 'SCHEDULE'; });
  const title = form.querySelector('input[name="title"]');
  const count = form.querySelector('[data-title-count]');
  if (title && count) count.textContent = String(title.value.length);
}

$$('.composer-form').forEach(form => {
  form.addEventListener('change', () => updateComposer(form));
  form.addEventListener('input', () => updateComposer(form));
  updateComposer(form);
});

$('[data-queue-switch]')?.addEventListener('click', event => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  $$('button', event.currentTarget).forEach(node => node.classList.toggle('active', node === button));
  const filter = button.dataset.filter;
  $$('.queue-card').forEach(card => { card.hidden = filter !== 'ALL' && card.dataset.contentType !== filter; });
});

$$('.sidebar a').forEach(link => link.addEventListener('click', () => {
  $$('.sidebar a').forEach(node => node.classList.remove('active'));
  link.classList.add('active');
}));

function creatorUniverse(canvas) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 0; let height = 0; let dpr = 1; let frame = 0; let pointerX = 0; let pointerY = 0;
  const particles = Array.from({ length: reduced ? 30 : 110 }, () => ({
    x: Math.random(), y: Math.random(), z: Math.random(), speed: .0015 + Math.random() * .004, size: .4 + Math.random() * 1.8
  }));
  const resize = () => {
    const box = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    width = Math.max(1, box.width); height = Math.max(1, box.height);
    canvas.width = width * dpr; canvas.height = height * dpr;
    context.setTransform(dpr,0,0,dpr,0,0);
  };
  new ResizeObserver(resize).observe(canvas); resize();
  canvas.parentElement?.addEventListener('pointermove', event => {
    const rect = canvas.getBoundingClientRect();
    pointerX = (event.clientX - rect.left) / rect.width - .5;
    pointerY = (event.clientY - rect.top) / rect.height - .5;
  });
  const draw = () => {
    frame += 1;
    context.clearRect(0,0,width,height);
    const glow = context.createRadialGradient(width * (.68 + pointerX * .04),height * (.42 + pointerY * .04),0,width * .68,height * .42,width * .55);
    glow.addColorStop(0,'rgba(255,0,51,.19)'); glow.addColorStop(.35,'rgba(255,0,51,.06)'); glow.addColorStop(1,'rgba(0,0,0,0)');
    context.fillStyle = glow; context.fillRect(0,0,width,height);
    context.save(); context.translate(pointerX * -12,pointerY * -8);
    for (const particle of particles) {
      if (!reduced) { particle.z -= particle.speed; if (particle.z <= .02) { particle.z = 1; particle.x = Math.random(); particle.y = Math.random(); } }
      const perspective = 1 / Math.max(.05,particle.z);
      const x = (particle.x - .5) * width * perspective * .8 + width * .67;
      const y = (particle.y - .5) * height * perspective * .8 + height * .48;
      const alpha = Math.max(0,1 - particle.z) * .8;
      context.beginPath(); context.fillStyle = `rgba(255,255,255,${alpha})`; context.arc(x,y,particle.size * perspective * .45,0,Math.PI * 2); context.fill();
      if (!reduced && particle.z < .45) {
        context.strokeStyle = `rgba(255,34,70,${alpha * .5})`; context.beginPath(); context.moveTo(x,y); context.lineTo(x - (x - width*.67)*.025,y - (y-height*.48)*.025); context.stroke();
      }
    }
    context.restore();
    const lineY = height * (.73 + Math.sin(frame * .008) * .006);
    const beam = context.createLinearGradient(0,0,width,0); beam.addColorStop(0,'rgba(255,0,51,0)'); beam.addColorStop(.65,'rgba(255,0,51,.65)'); beam.addColorStop(1,'rgba(255,255,255,0)');
    context.strokeStyle = beam; context.lineWidth = 1; context.beginPath(); context.moveTo(width*.28,lineY); context.lineTo(width,lineY); context.stroke();
    if (!reduced) requestAnimationFrame(draw);
  };
  draw();
}

$$('[data-creator-universe]').forEach(creatorUniverse);

// Interactive 3D Card Tilt Effect
document.addEventListener('mousemove', e => {
  const cards = document.querySelectorAll('.floating-card, .pipeline-card, .feature-card');
  const mouseX = e.clientX;
  const mouseY = e.clientY;

  cards.forEach(card => {
    const rect = card.getBoundingClientRect();
    const cardX = rect.left + rect.width / 2;
    const cardY = rect.top + rect.height / 2;
    const angleX = (cardY - mouseY) / 25;
    const angleY = (mouseX - cardX) / 25;

    if (Math.abs(mouseX - cardX) < 400 && Math.abs(mouseY - cardY) < 400) {
      card.style.transform = 'perspective(1000px) rotateX(' + angleX + 'deg) rotateY(' + angleY + 'deg) scale3d(1.02, 1.02, 1.02)';
    } else {
      card.style.transform = '';
    }
  });
});
