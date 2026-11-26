// Loader for the 3-D model of the arm. The 3-D library is large, so it loads only when the visitor scrolls near the model.
const el = document.getElementById('arm3d');
if (el) {
  let asked = false;
  const go = () => {
    if (asked) return;
    asked = true;
    import('./fund_arm3d_view.js').then((m) => m.mount(el)).catch((e) => {
      el.classList.add('is-off');
      const note = el.querySelector('.fd-arm3d-note');
      if (note) note.textContent = 'This device cannot show the 3-D model. The drawing above shows the same design.';
      console.warn('[arm3d]', e);
    });
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: '700px 0px' });
    io.observe(el);
  } else go();
}
