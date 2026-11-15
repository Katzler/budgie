// Penga-konfetti: pixelsedlar och mynt som sprutar upp från en knapp och
// faller ner över skärmen. Hoppas över om man har bett om mindre rörelse.
import { px } from "./pixel.js";

const PIECES = ["note", "note", "note2", "dot", "dot"];

/** Skjuter konfetti från mitten av `rect` (en DOMRect), eller från skärmens mitt. */
export function moneyConfetti(rect, count = 28) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const x0 = rect ? rect.left + rect.width / 2 : innerWidth / 2;
  const y0 = rect ? rect.top + rect.height / 2 : innerHeight / 2;
  const layer = document.createElement("div");
  layer.className = "confetti";
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);

  const done = [];
  for (let i = 0; i < count; i++) {
    const name = PIECES[Math.floor(Math.random() * PIECES.length)];
    const el = document.createElement("div");
    el.className = "confetti-piece";
    el.innerHTML = px(name, 3, "px art");
    layer.append(el);

    // Uppåt i en solfjäder, sedan ner av tyngden.
    const angle = (-90 + (Math.random() - 0.5) * 110) * (Math.PI / 180);
    const speed = 260 + Math.random() * 320;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const g = 900;
    const duration = 1400 + Math.random() * 900;
    const spin = (Math.random() - 0.5) * 900;
    const flip = 2 + Math.floor(Math.random() * 4);
    const frames = [];
    const steps = 12;
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * (duration / 1000);
      const sway = Math.sin(t * 6 + i) * 14 * (s / steps);
      const dx = vx * t * 0.85 + sway;
      const dy = vy * t + 0.5 * g * t * t;
      frames.push({
        transform: `translate(${dx}px, ${dy}px) rotate(${spin * t}deg) scaleY(${Math.cos(t * flip * Math.PI).toFixed(2)})`,
        opacity: s === steps ? 0 : 1,
      });
    }
    el.style.left = `${x0}px`;
    el.style.top = `${y0}px`;
    done.push(el.animate(frames, { duration, easing: "linear", delay: Math.random() * 120, fill: "forwards" }).finished);
  }
  Promise.allSettled(done).then(() => layer.remove());
}
