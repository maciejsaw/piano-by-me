// Help text lives behind small ⓘ buttons instead of on the page. Hovering one
// (with a mouse) or tapping it (on a touch screen) opens its popover; tapping
// anywhere else, or Escape, closes it.
//
// tipify(root) turns, once each:
//   - every .hint, .env p and [data-tip] element into a popover, opened from a
//     button on the heading it belongs to (the nearest h2 / h3 / .exp-h before
//     it); several under one heading share one popover. The elements are
//     moved, not copied, so ids stay and text the app fills in later shows up
//     (data-tip-to="panel" sends one to its panel's h2 instead);
//   - a heading "Name — explanation" into "Name", the explanation going first
//     in its popover (unless the part after the dash is live, i.e. has an id);
//   - a long `title` on a label into a button showing that text, so it can be
//     read on a touch screen too.

const TIP_SEL = '.hint, .env p, [data-tip]';
const HEAD_SEL = 'h2, h3, .exp-h, [data-tip-anchor]';
const LONG_TITLE = 48;

let open = null;          // { btn, pop } showing now
let pinned = false;       // opened by a tap / click, so hovering away keeps it

function place(btn, pop) {
  pop.style.left = '0px'; pop.style.top = '0px';
  const b = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const x = Math.max(8, Math.min(vw - w - 8, b.left + b.width / 2 - w / 2));
  const below = b.bottom + 6, above = b.top - 6 - h;
  const y = below + h <= vh - 8 || above < 8 ? Math.min(below, Math.max(8, vh - 8 - h)) : above;
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
}

function show(btn, pop, pin) {
  if (open && open.pop !== pop) hide();
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  open = { btn, pop };
  pinned = pin || pinned;
  place(btn, pop);
}

function hide() {
  if (!open) return;
  open.pop.hidden = true;
  open.btn.setAttribute('aria-expanded', 'false');
  open = null; pinned = false;
}

let nextId = 1;
function makeTip(anchor) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tip';
  btn.textContent = 'i';
  btn.setAttribute('aria-label', 'More about this');
  btn.setAttribute('aria-expanded', 'false');
  const pop = document.createElement('div');
  pop.className = 'tip-pop';
  pop.id = `tip-pop-${nextId++}`;
  pop.hidden = true;
  pop.setAttribute('role', 'tooltip');
  btn.setAttribute('aria-describedby', pop.id);
  document.body.appendChild(pop);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open?.pop === pop && pinned) hide(); else show(btn, pop, true);
  });
  // Hover only where there is a real pointer to hover with.
  btn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(btn, pop, false); });
  const leave = (e) => {
    if (e.pointerType !== 'mouse' || pinned || open?.pop !== pop) return;
    const to = e.relatedTarget;
    if (to && (btn.contains(to) || pop.contains(to))) return;
    hide();
  };
  btn.addEventListener('pointerleave', leave);
  pop.addEventListener('pointerleave', leave);
  pop.addEventListener('click', (e) => e.stopPropagation());

  // In an envelope's heading, before its preset buttons; elsewhere, last.
  const presets = anchor.matches('.env h3') ? anchor.querySelector(':scope > span') : null;
  anchor.insertBefore(btn, presets);
  anchor._tip = pop;
  return pop;
}

function tipFor(anchor) { return anchor._tip || makeTip(anchor); }

/** The heading `el` explains: the nearest one before it, at its level or any above. */
function anchorOf(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.matches(HEAD_SEL)) return s;
      if (s.matches('.pe-ctl, .sel-head')) return s.querySelector('label, span') || s;
    }
  }
  return null;
}

/** "Name — explanation": the explanation goes into the heading's popover. */
function splitHeading(h) {
  if (h._split) return;
  h._split = true;
  const t = h.firstChild;
  if (!t || t.nodeType !== Node.TEXT_NODE) return;
  const i = t.data.indexOf(' — ');
  if (i < 0) return;
  // Anything after the text node that is live stays in the heading.
  for (let n = t.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1 && (n.id || n.querySelector('[id]'))) return;
  const rest = document.createElement('p');
  rest.className = 'tip-lead';
  rest.append(t.data.slice(i + 3));
  while (t.nextSibling) rest.append(t.nextSibling);
  t.data = t.data.slice(0, i);
  const pop = tipFor(h);
  pop.prepend(rest);
}

export function tipify(root = document) {
  for (const h of root.querySelectorAll('.panel > h2, h3.lbl, h3.sub, .exp-h')) splitHeading(h);
  for (const el of root.querySelectorAll(TIP_SEL)) {
    if (el.closest('.tip-pop')) continue;
    const a = el.dataset.tipTo === 'panel' ? el.closest('.panel')?.querySelector('h2') : anchorOf(el);
    if (!a) continue;
    tipFor(a).append(el);
  }
  for (const el of root.querySelectorAll('label[title], .stat[title]')) {
    if (el.title.length < LONG_TITLE || el.closest('.tip-pop')) continue;
    const p = document.createElement('p');
    p.textContent = el.title;
    el.removeAttribute('title');
    tipFor(el).append(p);
  }
}

document.addEventListener('click', () => { if (open) hide(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
window.addEventListener('resize', () => { if (open) place(open.btn, open.pop); });
document.addEventListener('scroll', () => { if (open) place(open.btn, open.pop); }, { capture: true, passive: true });
