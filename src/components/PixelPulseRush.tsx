import { useCallback, useEffect, useRef, useState } from "react";

/* ============================================================
 * Pixel Pulse Rush
 * 4-lane neon rhythm game with procedural chiptune (Web Audio API)
 * ============================================================ */

const LANES = 4;
const LANE_KEYS = ["d", "f", "j", "k"] as const;
const LANE_COLORS = ["#ff3ea5", "#22e2ff", "#ffe94a", "#5cff8a"] as const;
const HIT_LINE_RATIO = 0.82; // where notes should be tapped
const NOTE_TRAVEL_MS = 1600; // time to fall from top to hit line
const HIT_WINDOW_MS = 140;
const PERFECT_WINDOW_MS = 55;
const MAX_MISSES = 3;

type Note = {
  id: number;
  lane: number;
  spawnAt: number; // audioContext time
  hitAt: number; // audioContext time
  hit: boolean;
  missed: boolean;
  judged: boolean;
};

type Judgement = { text: string; color: string; at: number };

type GameState = "idle" | "playing" | "over";

// ---------- Procedural chiptune ----------
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12]; // minor-ish pentatonic + passing
const ROOT_MIDI = 45; // A2

function midiToFreq(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

class ChiptuneEngine {
  ctx: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  bpm: number;
  beatDur: number;
  startTime = 0;
  running = false;
  nextBeat = 0;
  beatIndex = 0;
  seed: number;
  onBeat?: (info: { beat: number; time: number; lanes: number[] }) => void;

  constructor(bpm = 128) {
    const Ctor: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext || window.AudioContext;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.bpm = bpm;
    this.beatDur = 60 / bpm;
    this.seed = Math.floor(Math.random() * 1e9);
  }

  rand(n: number) {
    // deterministic-ish per-beat via seed + n
    let x = (this.seed + n * 2654435761) >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  }

  // 8-bit square blip
  blip(freq: number, when: number, dur: number, type: OscillatorType, gain = 0.25) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  // noise for hats/snare
  noise(when: number, dur: number, gain = 0.15, highpass = 4000) {
    const buf = this.ctx.createBuffer(
      1,
      Math.max(1, Math.floor(this.ctx.sampleRate * dur)),
      this.ctx.sampleRate,
    );
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "highpass";
    bp.frequency.value = highpass;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  kick(when: number) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(120, when);
    o.frequency.exponentialRampToValueAtTime(40, when + 0.15);
    g.gain.setValueAtTime(0.6, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
    o.connect(g);
    g.connect(this.master);
    o.start(when);
    o.stop(when + 0.25);
  }

  scheduleBeat(beat: number, when: number) {
    const bar = Math.floor(beat / 16);
    const posInBar = beat % 16;
    // Kick on 0,4,8,12
    if (posInBar % 4 === 0) this.kick(when);
    // Hat every 2
    if (posInBar % 2 === 1) this.noise(when, 0.05, 0.08, 6000);
    // Snare on 4,12
    if (posInBar === 4 || posInBar === 12) this.noise(when, 0.12, 0.18, 2000);

    // Melody every beat, with occasional rests
    const r = this.rand(beat);
    if (r > 0.15) {
      const scaleStep = SCALE[Math.floor(this.rand(beat * 3.7 + 1) * SCALE.length)];
      const octave = Math.floor(this.rand(beat * 1.3 + 7) * 3); // 0-2
      const freq = midiToFreq(ROOT_MIDI + scaleStep + octave * 12 + 12);
      const type: OscillatorType =
        this.rand(beat * 0.9) > 0.5 ? "square" : "triangle";
      this.blip(freq, when, 0.14, type, 0.18);
    }
    // Bass every 2 beats
    if (posInBar % 2 === 0) {
      const bassStep = SCALE[(bar + Math.floor(posInBar / 4)) % SCALE.length];
      const f = midiToFreq(ROOT_MIDI + bassStep);
      this.blip(f, when, 0.22, "square", 0.22);
    }
  }

  // Returns an array of lanes (0..LANES-1) that should have a note at this beat,
  // and the audio-clock time the note should be hit.
  patternForBeat(beat: number): number[] {
    const lanes: number[] = [];
    const posInBar = beat % 16;
    // Steady quarter notes on beats 0,4,8,12
    if (posInBar % 4 === 0) {
      lanes.push(Math.floor(this.rand(beat * 2 + 5) * LANES));
    }
    // Off-beat eighths sometimes
    if (posInBar % 2 === 1 && this.rand(beat * 1.7) > 0.35) {
      lanes.push(Math.floor(this.rand(beat * 4.1 + 3) * LANES));
    }
    // Sixteenth flourish occasionally
    if (this.rand(beat * 0.53) > 0.85) {
      const l = Math.floor(this.rand(beat * 5.9) * LANES);
      if (!lanes.includes(l)) lanes.push(l);
    }
    return lanes;
  }

  start(scheduleAhead: (beat: number, hitTime: number, lanes: number[]) => void) {
    this.running = true;
    this.startTime = this.ctx.currentTime + 0.2;
    this.nextBeat = 0;
    this.beatIndex = 0;

    const loop = () => {
      if (!this.running) return;
      const now = this.ctx.currentTime;
      // schedule up to ~200ms ahead of audio time, but notes need NOTE_TRAVEL_MS ahead visually
      while (
        this.startTime + this.nextBeat * this.beatDur <
        now + 2.2
      ) {
        const when = this.startTime + this.nextBeat * this.beatDur;
        this.scheduleBeat(this.nextBeat, when);
        const lanes = this.patternForBeat(this.nextBeat);
        scheduleAhead(this.nextBeat, when, lanes);
        this.nextBeat++;
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    this.master.gain.exponentialRampToValueAtTime(
      0.0001,
      this.ctx.currentTime + 0.3,
    );
  }

  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }
}

// ---------- Component ----------
export default function PixelPulseRush() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ChiptuneEngine | null>(null);
  const notesRef = useRef<Note[]>([]);
  const noteIdRef = useRef(0);
  const stateRef = useRef<GameState>("idle");
  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const missesRef = useRef(0);
  const judgementsRef = useRef<Judgement[]>([]);
  const pulseRef = useRef(0);
  const laneFlashRef = useRef<number[]>([0, 0, 0, 0]);

  const [state, setState] = useState<GameState>("idle");
  const [hud, setHud] = useState({ score: 0, combo: 0, misses: 0, best: 0 });
  const [finalStats, setFinalStats] = useState<{
    score: number;
    bestCombo: number;
    accuracy: number;
    hits: number;
    total: number;
  } | null>(null);

  const hitsRef = useRef(0);
  const totalRef = useRef(0);

  const endGame = useCallback(() => {
    if (stateRef.current !== "playing") return;
    stateRef.current = "over";
    setState("over");
    engineRef.current?.stop();
    const total = totalRef.current || 1;
    setFinalStats({
      score: scoreRef.current,
      bestCombo: bestComboRef.current,
      accuracy: Math.round((hitsRef.current / total) * 100),
      hits: hitsRef.current,
      total: totalRef.current,
    });
  }, []);

  const startGame = useCallback(async () => {
    // reset
    notesRef.current = [];
    noteIdRef.current = 0;
    scoreRef.current = 0;
    comboRef.current = 0;
    bestComboRef.current = 0;
    missesRef.current = 0;
    hitsRef.current = 0;
    totalRef.current = 0;
    judgementsRef.current = [];
    pulseRef.current = 0;
    laneFlashRef.current = [0, 0, 0, 0];
    setHud({ score: 0, combo: 0, misses: 0, best: 0 });
    setFinalStats(null);

    const engine = new ChiptuneEngine(130);
    engineRef.current = engine;
    await engine.resume();
    stateRef.current = "playing";
    setState("playing");
    engine.start((beat, hitTime, lanes) => {
      // first bar is a lead-in with no notes
      if (beat < 8) return;
      for (const lane of lanes) {
        notesRef.current.push({
          id: noteIdRef.current++,
          lane,
          spawnAt: hitTime - NOTE_TRAVEL_MS / 1000,
          hitAt: hitTime,
          hit: false,
          missed: false,
          judged: false,
        });
        totalRef.current++;
      }
    });
  }, []);

  const tapLane = useCallback((lane: number) => {
    if (stateRef.current !== "playing") return;
    const engine = engineRef.current;
    if (!engine) return;
    const now = engine.ctx.currentTime;
    // find nearest un-judged note in this lane
    let best: Note | null = null;
    let bestDelta = Infinity;
    for (const n of notesRef.current) {
      if (n.lane !== lane || n.judged) continue;
      const d = Math.abs((n.hitAt - now) * 1000);
      if (d < bestDelta) {
        bestDelta = d;
        best = n;
      }
    }
    laneFlashRef.current[lane] = 1;
    if (best && bestDelta <= HIT_WINDOW_MS) {
      best.hit = true;
      best.judged = true;
      hitsRef.current++;
      comboRef.current++;
      if (comboRef.current > bestComboRef.current)
        bestComboRef.current = comboRef.current;
      const perfect = bestDelta <= PERFECT_WINDOW_MS;
      const gain = (perfect ? 100 : 50) * (1 + Math.floor(comboRef.current / 10) * 0.5);
      scoreRef.current += Math.round(gain);
      pulseRef.current = 1;
      judgementsRef.current.push({
        text: perfect ? "PERFECT" : "GOOD",
        color: perfect ? "#ffe94a" : "#22e2ff",
        at: performance.now(),
      });
    } else {
      // stray tap — small penalty on combo
      comboRef.current = 0;
      judgementsRef.current.push({
        text: "MISS",
        color: "#ff3ea5",
        at: performance.now(),
      });
    }
  }, []);

  // keyboard input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const idx = LANE_KEYS.indexOf(e.key.toLowerCase() as (typeof LANE_KEYS)[number]);
      if (idx >= 0) {
        e.preventDefault();
        tapLane(idx);
      } else if (e.key === " " && (stateRef.current === "idle" || stateRef.current === "over")) {
        e.preventDefault();
        startGame();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tapLane, startGame]);

  // main render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const freqData = new Uint8Array(64);

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const engine = engineRef.current;

      // background pulse
      const pulse = pulseRef.current;
      pulseRef.current *= 0.9;

      // clear
      ctx.fillStyle = `rgba(14, 8, 28, ${0.85 - pulse * 0.25})`;
      ctx.fillRect(0, 0, W, H);

      // grid
      ctx.strokeStyle = `rgba(120, 60, 200, ${0.15 + pulse * 0.2})`;
      ctx.lineWidth = 1;
      for (let y = 0; y < H; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      // EQ bars along bottom (behind lanes)
      if (engine) {
        engine.analyser.getByteFrequencyData(freqData);
        const bars = 32;
        const bw = W / bars;
        for (let i = 0; i < bars; i++) {
          const v = freqData[i] / 255;
          const h = v * H * 0.5;
          const hue = (i / bars) * 60 + 280;
          ctx.fillStyle = `hsla(${hue}, 90%, 60%, 0.35)`;
          ctx.fillRect(i * bw, H - h, bw - 2, h);
        }
      }

      // lane setup
      const laneAreaW = Math.min(W, 520);
      const laneAreaX = (W - laneAreaW) / 2;
      const laneW = laneAreaW / LANES;
      const hitY = H * HIT_LINE_RATIO;

      // lane backgrounds
      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW;
        const flash = laneFlashRef.current[i];
        laneFlashRef.current[i] *= 0.85;
        ctx.fillStyle = `rgba(255,255,255,${0.02 + flash * 0.08})`;
        ctx.fillRect(x, 0, laneW - 2, H);
        // lane border
        ctx.strokeStyle = `rgba(255,255,255,${0.08 + flash * 0.3})`;
        ctx.strokeRect(x, 0, laneW - 2, H);
      }

      // hit line
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(laneAreaX, hitY);
      ctx.lineTo(laneAreaX + laneAreaW, hitY);
      ctx.stroke();

      // hit-line glow per lane
      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW;
        const flash = laneFlashRef.current[i];
        ctx.fillStyle = LANE_COLORS[i];
        ctx.globalAlpha = 0.15 + flash * 0.7;
        ctx.fillRect(x + 4, hitY - 6, laneW - 10, 12);
        ctx.globalAlpha = 1;
      }

      // notes
      if (engine && stateRef.current === "playing") {
        const now = engine.ctx.currentTime;
        for (const n of notesRef.current) {
          if (n.judged) continue;
          const t = (now - n.spawnAt) / (NOTE_TRAVEL_MS / 1000);
          if (t < 0) continue;
          const y = t * hitY;
          const x = laneAreaX + n.lane * laneW + 6;
          const w = laneW - 14;
          const h = 22;
          // pixel-block note
          ctx.fillStyle = LANE_COLORS[n.lane];
          ctx.shadowColor = LANE_COLORS[n.lane];
          ctx.shadowBlur = 18;
          ctx.fillRect(x, y - h / 2, w, h);
          ctx.shadowBlur = 0;
          // inner pixel detail
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillRect(x + 4, y - h / 2 + 4, w - 8, 3);

          // auto-miss when past window
          if ((now - n.hitAt) * 1000 > HIT_WINDOW_MS) {
            n.judged = true;
            n.missed = true;
            comboRef.current = 0;
            missesRef.current++;
            judgementsRef.current.push({
              text: "MISS",
              color: "#ff3ea5",
              at: performance.now(),
            });
            if (missesRef.current >= MAX_MISSES) {
              endGame();
            }
          }
        }
        // GC old notes
        notesRef.current = notesRef.current.filter(
          (n) => !n.judged || (engine.ctx.currentTime - n.hitAt) < 1.5,
        );
      }

      // key hint labels
      ctx.font = "12px 'VT323', monospace";
      ctx.textAlign = "center";
      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW + laneW / 2;
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText(LANE_KEYS[i].toUpperCase(), x, hitY + 26);
      }

      // judgements
      const nowMs = performance.now();
      judgementsRef.current = judgementsRef.current.filter(
        (j) => nowMs - j.at < 600,
      );
      ctx.textAlign = "center";
      for (const j of judgementsRef.current) {
        const age = (nowMs - j.at) / 600;
        ctx.globalAlpha = 1 - age;
        ctx.font = "18px 'Press Start 2P', monospace";
        ctx.fillStyle = j.color;
        ctx.shadowColor = j.color;
        ctx.shadowBlur = 12;
        ctx.fillText(j.text, W / 2, hitY - 40 - age * 30);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      // HUD sync
      setHud((h) =>
        h.score === scoreRef.current &&
        h.combo === comboRef.current &&
        h.misses === missesRef.current &&
        h.best === bestComboRef.current
          ? h
          : {
              score: scoreRef.current,
              combo: comboRef.current,
              misses: missesRef.current,
              best: bestComboRef.current,
            },
      );

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [endGame]);

  // touch / click lane taps
  const onCanvasPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const laneAreaW = Math.min(rect.width, 520);
    const laneAreaX = (rect.width - laneAreaW) / 2;
    const rel = x - laneAreaX;
    if (rel < 0 || rel > laneAreaW) return;
    const lane = Math.floor((rel / laneAreaW) * LANES);
    tapLane(Math.max(0, Math.min(LANES - 1, lane)));
  };

  const shareScore = async () => {
    if (!finalStats) return;
    const text = `🕹️ Pixel Pulse Rush\nScore ${finalStats.score} · Combo ${finalStats.bestCombo}x · ${finalStats.accuracy}% acc\nBeat my run:`;
    const url = typeof window !== "undefined" ? window.location.href : "";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Pixel Pulse Rush", text, url });
        return;
      }
    } catch {
      /* ignore */
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      alert("Score copied to clipboard!");
    } catch {
      alert(text);
    }
  };

  const downloadCard = () => {
    if (!finalStats) return;
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 630;
    const g = c.getContext("2d")!;
    // gradient bg
    const grad = g.createLinearGradient(0, 0, 1200, 630);
    grad.addColorStop(0, "#1a0836");
    grad.addColorStop(1, "#06222f");
    g.fillStyle = grad;
    g.fillRect(0, 0, 1200, 630);
    // grid
    g.strokeStyle = "rgba(180,100,255,0.2)";
    for (let y = 0; y < 630; y += 32) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(1200, y);
      g.stroke();
    }
    // pixel blocks decoration
    const colors = ["#ff3ea5", "#22e2ff", "#ffe94a", "#5cff8a"];
    for (let i = 0; i < 40; i++) {
      g.fillStyle = colors[i % 4];
      g.globalAlpha = 0.3 + (i % 5) * 0.1;
      const bx = (i * 137) % 1200;
      const by = (i * 211) % 630;
      g.fillRect(bx, by, 20, 20);
    }
    g.globalAlpha = 1;
    // title
    g.fillStyle = "#ffe94a";
    g.font = "bold 64px monospace";
    g.fillText("PIXEL PULSE RUSH", 60, 110);
    // score
    g.fillStyle = "#ff3ea5";
    g.font = "bold 180px monospace";
    g.fillText(String(finalStats.score), 60, 320);
    // stats
    g.fillStyle = "#22e2ff";
    g.font = "36px monospace";
    g.fillText(`COMBO  ${finalStats.bestCombo}x`, 60, 420);
    g.fillText(`ACC    ${finalStats.accuracy}%`, 60, 470);
    g.fillText(`HITS   ${finalStats.hits}/${finalStats.total}`, 60, 520);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.font = "24px monospace";
    g.fillText("tap the beat · chase the combo", 60, 585);

    const url = c.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `pixel-pulse-rush-${finalStats.score}.png`;
    a.click();
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center px-4 py-6">
      <header className="w-full max-w-[560px] flex items-center justify-between mb-3">
        <h1 className="font-display text-glow-pink text-sm sm:text-base">
          PIXEL PULSE RUSH
        </h1>
        <div className="flex gap-3 text-xs sm:text-sm">
          <span className="text-glow-cyan">SCORE {hud.score}</span>
          <span className="text-glow-yellow">x{hud.combo}</span>
        </div>
      </header>

      <div className="relative w-full max-w-[560px] aspect-[9/16] rounded-lg overflow-hidden border border-border scanlines shadow-[0_0_60px_-10px_rgba(255,62,165,0.5)]">
        <canvas
          ref={canvasRef}
          onPointerDown={onCanvasPointer}
          className="w-full h-full block touch-none select-none"
        />

        {/* Miss pips */}
        <div className="absolute top-2 left-2 flex gap-1">
          {Array.from({ length: MAX_MISSES }).map((_, i) => (
            <div
              key={i}
              className="w-3 h-3 rounded-sm"
              style={{
                background:
                  i < hud.misses ? "transparent" : "var(--neon-pink)",
                border: "1px solid var(--neon-pink)",
                boxShadow:
                  i < hud.misses ? "none" : "0 0 8px var(--neon-pink)",
              }}
            />
          ))}
        </div>
        <div className="absolute top-2 right-2 text-[10px] sm:text-xs font-display text-glow-cyan">
          BEST {hud.best}x
        </div>

        {state === "idle" && (
          <Overlay>
            <h2 className="font-display text-glow-pink text-lg sm:text-2xl mb-3">
              PIXEL PULSE RUSH
            </h2>
            <p className="max-w-xs text-sm text-muted-foreground mb-4 leading-relaxed">
              Tap the neon blocks as they hit the line. Every run generates a
              unique chiptune. Miss 3 and your pulse flatlines.
            </p>
            <div className="text-xs mb-5 space-y-1 opacity-80">
              <div>
                <span className="text-glow-yellow">KEYS</span> D F J K
              </div>
              <div>
                <span className="text-glow-yellow">MOBILE</span> tap the lanes
              </div>
            </div>
            <button
              onClick={startGame}
              className="font-display text-xs px-5 py-3 rounded bg-[var(--neon-pink)] text-black hover:brightness-110 active:translate-y-px shadow-[0_0_24px_-2px_var(--neon-pink)]"
            >
              PRESS START
            </button>
          </Overlay>
        )}

        {state === "over" && finalStats && (
          <Overlay>
            <h2 className="font-display text-glow-pink text-base sm:text-xl mb-2">
              FLATLINE
            </h2>
            <div className="font-display text-glow-yellow text-3xl sm:text-5xl mb-3">
              {finalStats.score}
            </div>
            <div className="text-sm space-y-1 mb-4">
              <div>
                <span className="text-glow-cyan">COMBO</span>{" "}
                {finalStats.bestCombo}x
              </div>
              <div>
                <span className="text-glow-cyan">ACC</span>{" "}
                {finalStats.accuracy}%
              </div>
              <div>
                <span className="text-glow-cyan">HITS</span> {finalStats.hits}/
                {finalStats.total}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              <button
                onClick={startGame}
                className="font-display text-[10px] px-4 py-2 rounded bg-[var(--neon-pink)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-pink)]"
              >
                RETRY
              </button>
              <button
                onClick={shareScore}
                className="font-display text-[10px] px-4 py-2 rounded bg-[var(--neon-cyan)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-cyan)]"
              >
                SHARE
              </button>
              <button
                onClick={downloadCard}
                className="font-display text-[10px] px-4 py-2 rounded bg-[var(--neon-yellow)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-yellow)]"
              >
                SAVE CARD
              </button>
            </div>
          </Overlay>
        )}
      </div>

      <footer className="mt-4 text-[11px] text-muted-foreground text-center max-w-[560px]">
        Procedurally generated chiptune · Every run is a new track
      </footer>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center bg-black/60 backdrop-blur-sm px-4">
      {children}
    </div>
  );
}
