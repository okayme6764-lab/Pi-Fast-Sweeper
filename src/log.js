/**
 * Logger non-bloquant.
 *
 * Sur Windows, `console.log` vers un TTY est une écriture SYNCHRONE : chaque
 * ligne bloque la boucle d'événements le temps que le terminal l'affiche
 * (facilement 1-3 ms). Pendant la fenêtre critique de soumission, ces
 * millisecondes sont exactement ce qu'on essaie d'économiser.
 *
 * D'où le mode « hot » : pendant la course, les lignes sont accumulées en
 * mémoire (coût ~0) et écrites en un seul `write` après coup.
 */

const COLOR = process.env.NO_COLOR ? false : process.stdout.isTTY !== false;

const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2");
const bold = c("1");
const red = c("31");
const green = c("32");
const yellow = c("33");
const blue = c("34");
const magenta = c("35");
const cyan = c("36");
const grey = c("90");

const LEVELS = {
  trace: { tag: "····", paint: grey },
  info: { tag: "INFO", paint: blue },
  step: { tag: "STEP", paint: cyan },
  good: { tag: " OK ", paint: green },
  warn: { tag: "WARN", paint: yellow },
  fail: { tag: "FAIL", paint: red },
  fire: { tag: "FIRE", paint: magenta },
};

let hot = false;
let buffer = [];
const t0 = process.hrtime.bigint();

/** Horodatage mur + temps écoulé depuis le démarrage, en ms. */
function stamp() {
  const now = new Date();
  const hhmmss = now.toTimeString().slice(0, 8);
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  return `${grey(`${hhmmss}.${ms}`)} ${grey(`+${elapsed.toFixed(0).padStart(6)}ms`)}`;
}

function emit(line) {
  if (hot) buffer.push(line);
  else process.stdout.write(line + "\n");
}

function write(level, msg, fields) {
  const { tag, paint } = LEVELS[level] ?? LEVELS.info;
  let line = `${stamp()} ${paint(tag)} ${msg}`;
  if (fields) {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${dim(k)}=${bold(v)}`);
    if (parts.length) line += `  ${parts.join(dim(" · "))}`;
  }
  emit(line);
}

export const log = {
  trace: (m, f) => write("trace", m, f),
  info: (m, f) => write("info", m, f),
  step: (m, f) => write("step", m, f),
  good: (m, f) => write("good", m, f),
  warn: (m, f) => write("warn", m, f),
  fail: (m, f) => write("fail", m, f),
  fire: (m, f) => write("fire", m, f),

  /** Titre de section. */
  banner(title) {
    const bar = "─".repeat(Math.max(0, 66 - title.length));
    emit("");
    emit(`${cyan("┌─")} ${bold(title)} ${cyan(bar)}`);
  },

  /** Ligne brute, sans horodatage (tableaux, XDR, etc.). */
  raw(s = "") {
    emit(s);
  },

  /** Petit tableau aligné : rows = [[col1, col2, ...], ...] */
  table(headers, rows) {
    const all = [headers, ...rows].map((r) => r.map((v) => String(v)));
    const widths = headers.map((_, i) =>
      Math.max(...all.map((r) => stripAnsi(r[i] ?? "").length)),
    );
    const pad = (s, w) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
    emit(`   ${dim(headers.map((h, i) => pad(h, widths[i])).join("  "))}`);
    for (const r of all.slice(1)) {
      emit(`   ${r.map((v, i) => pad(v, widths[i])).join("  ")}`);
    }
  },

  /** Entre en mode tampon : plus aucune écriture bloquante. */
  hot() {
    hot = true;
  },

  /** Sort du mode tampon et vide le tampon en une seule écriture. */
  flush() {
    hot = false;
    if (buffer.length) {
      process.stdout.write(buffer.join("\n") + "\n");
      buffer = [];
    }
  },

  paint: { dim, bold, red, green, yellow, blue, magenta, cyan, grey },
};

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Masque un secret pour l'affichage : SBY7…TYSN */
export function mask(secret) {
  if (!secret) return "(vide)";
  const s = String(secret);
  if (s.length <= 12) return "•".repeat(s.length);
  return `${s.slice(0, 4)}${grey("…")}${s.slice(-4)}`;
}
