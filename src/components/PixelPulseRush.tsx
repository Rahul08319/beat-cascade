import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ytg from "@/lib/ytgame";


/* ============================================================
 * Pixel Pulse Rush
 * 4-lane neon rhythm game with procedural chiptune (Web Audio API)
 * ============================================================ */

const LANES = 4;
const LANE_KEYS = ["d", "f", "j", "k"] as const;
const LANE_COLORS = ["#ff3ea5", "#22e2ff", "#ffe94a", "#5cff8a"] as const;
const HIT_LINE_RATIO = 0.82;
const NOTE_TRAVEL_MS = 1600;
const MAX_MISSES = 3;

type Difficulty = "easy" | "normal" | "hard";

type DifficultyConfig = {
  label: string;
  bpm: number;
  bpmJitter: number;
  density: number;
  hitWindow: number;
  perfectWindow: number;
  blurb: string;
};

const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  easy: {
    label: "EASY",
    bpm: 104,
    bpmJitter: 6,
    density: 0.55,
    hitWindow: 190,
    perfectWindow: 90,
    blurb: "100–110 BPM · loose timing · sparse notes",
  },
  normal: {
    label: "NORMAL",
    bpm: 130,
    bpmJitter: 8,
    density: 1.0,
    hitWindow: 140,
    perfectWindow: 55,
    blurb: "125–140 BPM · standard timing · full pattern",
  },
  hard: {
    label: "HARD",
    bpm: 162,
    bpmJitter: 10,
    density: 1.45,
    hitWindow: 95,
    perfectWindow: 35,
    blurb: "155–170 BPM · tight timing · dense pattern",
  },
};

// ---------- Persistence ----------
const STATS_KEY = "ppr:stats:v1";
const OFFSET_KEY = "ppr:offset:v1";

// Current cloud-save schema version. Bump when the shape of `stats` changes
// and add a case to `migrateCloudPayload` below.
const CLOUD_SAVE_VERSION = 2;

type DiffStats = {
  bestScore: number;
  bestCombo: number;
  bestAccuracy: number;
  plays: number;
};
type AllStats = Record<Difficulty, DiffStats>;
const EMPTY_STATS: AllStats = {
  easy: { bestScore: 0, bestCombo: 0, bestAccuracy: 0, plays: 0 },
  normal: { bestScore: 0, bestCombo: 0, bestAccuracy: 0, plays: 0 },
  hard: { bestScore: 0, bestCombo: 0, bestAccuracy: 0, plays: 0 },
};

/**
 * Versioned cloud-save envelope. Older builds wrote raw AllStats without
 * a wrapper (implicit v1). New builds always write { v, stats }.
 * When the schema evolves, bump CLOUD_SAVE_VERSION and add a migration
 * branch — never mutate the shape of an existing version in place.
 */
type CloudSaveV2 = { v: 2; stats: AllStats };
type CloudSave = CloudSaveV2;

function coerceDiffStats(x: unknown): DiffStats {
  const o = (x ?? {}) as Partial<DiffStats>;
  return {
    bestScore: Math.max(0, Math.floor(Number(o.bestScore) || 0)),
    bestCombo: Math.max(0, Math.floor(Number(o.bestCombo) || 0)),
    bestAccuracy: Math.max(0, Math.min(100, Math.floor(Number(o.bestAccuracy) || 0))),
    plays: Math.max(0, Math.floor(Number(o.plays) || 0)),
  };
}

function coerceAllStats(x: unknown): AllStats {
  const o = (x ?? {}) as Partial<Record<Difficulty, unknown>>;
  return {
    easy: coerceDiffStats(o.easy),
    normal: coerceDiffStats(o.normal),
    hard: coerceDiffStats(o.hard),
  };
}

/** Parse a raw cloud payload, migrating older schemas up to the current one. */
function migrateCloudPayload(raw: string): CloudSave | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const maybeVersioned = parsed as { v?: number; stats?: unknown };
  // v1 (legacy): the payload IS the AllStats object, no envelope.
  if (typeof maybeVersioned.v !== "number") {
    return { v: 2, stats: coerceAllStats(parsed) };
  }
  // v2: current envelope.
  if (maybeVersioned.v === 2) {
    return { v: 2, stats: coerceAllStats(maybeVersioned.stats) };
  }
  // Unknown future version — try to salvage `stats` if present, else drop.
  if (maybeVersioned.stats && typeof maybeVersioned.stats === "object") {
    return { v: 2, stats: coerceAllStats(maybeVersioned.stats) };
  }
  return null;
}

function encodeCloudPayload(stats: AllStats): string {
  const payload: CloudSaveV2 = { v: CLOUD_SAVE_VERSION, stats };
  return JSON.stringify(payload);
}

function loadStats(): AllStats {
  if (typeof window === "undefined") return EMPTY_STATS;
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return EMPTY_STATS;
    const parsed = JSON.parse(raw);
    return { ...EMPTY_STATS, ...parsed };
  } catch {
    return EMPTY_STATS;
  }
}
function saveStats(s: AllStats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
function loadOffset(): number {
  if (typeof window === "undefined") return 0;
  try {
    const v = localStorage.getItem(OFFSET_KEY);
    return v ? Number(v) || 0 : 0;
  } catch {
    return 0;
  }
}
function saveOffset(v: number) {
  try {
    localStorage.setItem(OFFSET_KEY, String(v));
  } catch {
    /* ignore */
  }
}

type Note = {
  id: number;
  lane: number;
  spawnAt: number;
  hitAt: number;
  hit: boolean;
  missed: boolean;
  judged: boolean;
};

type Judgement = { text: string; color: string; at: number };

type GameState = "idle" | "playing" | "paused" | "over" | "calibrating";

type FinalStats = {
  score: number;
  bestCombo: number;
  accuracy: number;
  hits: number;
  total: number;
  difficulty: Difficulty;
  bpm: number;
  newBestScore: boolean;
  newBestCombo: boolean;
};

// ---------- Procedural chiptune ----------
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12];
const ROOT_MIDI = 45;

function midiToFreq(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

type ScheduleCb = (beat: number, hitTime: number, lanes: number[]) => void;

class ChiptuneEngine {
  ctx: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  bpm: number;
  beatDur: number;
  density: number;
  startTime = 0;
  running = false;
  nextBeat = 0;
  beatIndex = 0;
  seed: number;
  scheduleCb: ScheduleCb | null = null;

  constructor(bpm: number, density: number) {
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
    this.density = density;
    this.seed = Math.floor(Math.random() * 1e9);
  }

  rand(n: number) {
    let x = (this.seed + n * 2654435761) >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  }

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
    if (posInBar % 4 === 0) this.kick(when);
    if (posInBar % 2 === 1) this.noise(when, 0.05, 0.08, 6000);
    if (posInBar === 4 || posInBar === 12) this.noise(when, 0.12, 0.18, 2000);

    const r = this.rand(beat);
    if (r > 0.15) {
      const scaleStep = SCALE[Math.floor(this.rand(beat * 3.7 + 1) * SCALE.length)];
      const octave = Math.floor(this.rand(beat * 1.3 + 7) * 3);
      const freq = midiToFreq(ROOT_MIDI + scaleStep + octave * 12 + 12);
      const type: OscillatorType =
        this.rand(beat * 0.9) > 0.5 ? "square" : "triangle";
      this.blip(freq, when, 0.14, type, 0.18);
    }
    if (posInBar % 2 === 0) {
      const bassStep = SCALE[(bar + Math.floor(posInBar / 4)) % SCALE.length];
      const f = midiToFreq(ROOT_MIDI + bassStep);
      this.blip(f, when, 0.22, "square", 0.22);
    }
  }

  patternForBeat(beat: number): number[] {
    const lanes: number[] = [];
    const posInBar = beat % 16;
    const d = this.density;
    if (posInBar % 4 === 0) {
      if (d >= 1 || this.rand(beat * 7.3 + 11) < 0.85) {
        lanes.push(Math.floor(this.rand(beat * 2 + 5) * LANES));
      }
    }
    const offBeatChance = 0.65 * d;
    if (posInBar % 2 === 1 && this.rand(beat * 1.7) < offBeatChance) {
      lanes.push(Math.floor(this.rand(beat * 4.1 + 3) * LANES));
    }
    const sixteenthChance = 0.15 * d;
    if (this.rand(beat * 0.53) < sixteenthChance) {
      const l = Math.floor(this.rand(beat * 5.9) * LANES);
      if (!lanes.includes(l)) lanes.push(l);
    }
    if (d > 1.2 && posInBar % 8 === 0 && this.rand(beat * 9.1) < 0.4) {
      const l = Math.floor(this.rand(beat * 11.3) * LANES);
      if (!lanes.includes(l)) lanes.push(l);
    }
    return lanes;
  }

  runLoop() {
    const loop = () => {
      if (!this.running) return;
      const now = this.ctx.currentTime;
      while (this.startTime + this.nextBeat * this.beatDur < now + 2.2) {
        const when = this.startTime + this.nextBeat * this.beatDur;
        this.scheduleBeat(this.nextBeat, when);
        const lanes = this.patternForBeat(this.nextBeat);
        this.scheduleCb?.(this.nextBeat, when, lanes);
        this.nextBeat++;
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  start(scheduleAhead: ScheduleCb) {
    this.scheduleCb = scheduleAhead;
    this.running = true;
    this.startTime = this.ctx.currentTime + 0.2;
    this.nextBeat = 0;
    this.beatIndex = 0;
    this.runLoop();
  }

  pause() {
    this.running = false;
    try {
      this.ctx.suspend();
    } catch {
      /* ignore */
    }
  }

  async unpause() {
    try {
      if (this.ctx.state !== "running") await this.ctx.resume();
    } catch {
      /* ignore */
    }
    this.running = true;
    this.runLoop();
  }

  stop() {
    this.running = false;
    try {
      this.master.gain.exponentialRampToValueAtTime(
        0.0001,
        this.ctx.currentTime + 0.3,
      );
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.ctx.close();
      } catch {
        /* ignore */
      }
    }, 400);
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
  const hitWindowRef = useRef(DIFFICULTIES.normal.hitWindow);
  const perfectWindowRef = useRef(DIFFICULTIES.normal.perfectWindow);
  const latencyOffsetRef = useRef(0);

  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [state, setState] = useState<GameState>("idle");
  const [hud, setHud] = useState({ score: 0, combo: 0, misses: 0, best: 0 });
  const [finalStats, setFinalStats] = useState<FinalStats | null>(null);
  const [statsAll, setStatsAll] = useState<AllStats>(EMPTY_STATS);
  const [latencyOffset, setLatencyOffset] = useState<number>(0);
  const [shareUrl, setShareUrl] = useState<string>("");
  const [challenge, setChallenge] = useState<
    | null
    | { score: number; combo: number; acc: number; diff: Difficulty }
  >(null);

  const hitsRef = useRef(0);
  const totalRef = useRef(0);
  const activeTouchesRef = useRef<Map<number, number>>(new Map());
  const mutedRef = useRef(false);
  const cloudReadyRef = useRef(false);
  // Interstitial cooldown — YouTube requires ads only at natural breakpoints,
  // never mid-run and never too frequently. Track last shown timestamp and
  // whether the current run has already surfaced one.
  const lastInterstitialAtRef = useRef(0);
  const shownInterstitialThisRunRef = useRef(false);
  const INTERSTITIAL_MIN_INTERVAL_MS = 90_000;
  const [rewardGranted, setRewardGranted] = useState(false);
  const [rewardPending, setRewardPending] = useState(false);





  // Load persisted stats + offset + parse challenge URL
  useEffect(() => {
    setStatsAll(loadStats());
    const off = loadOffset();
    latencyOffsetRef.current = off;
    setLatencyOffset(off);
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("s")) {
        const d = params.get("d");
        const diff: Difficulty =
          d === "easy" || d === "normal" || d === "hard" ? d : "normal";
        setChallenge({
          score: Number(params.get("s")) || 0,
          combo: Number(params.get("c")) || 0,
          acc: Number(params.get("a")) || 0,
          diff,
        });
        setDifficulty(diff);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // YouTube Playables SDK lifecycle. Runs as a no-op outside of Playables.
  useEffect(() => {
    let cancelled = false;

    // Initial audio state from YT settings.
    mutedRef.current = !ytg.isAudioEnabled();

    // Merge any cloud save into local stats (cloud wins on higher values).
    // Payload is versioned (see migrateCloudPayload) so older saves are
    // upgraded transparently and unknown-future saves are salvaged if possible.
    (async () => {
      const raw = await ytg.loadCloudData();
      if (cancelled || !raw) {
        cloudReadyRef.current = true;
        return;
      }
      const migrated = migrateCloudPayload(raw);
      if (!migrated) {
        cloudReadyRef.current = true;
        return;
      }
      const cloud = migrated.stats;
      setStatsAll((cur) => {
        const merged: AllStats = { ...cur };
        (Object.keys(EMPTY_STATS) as Difficulty[]).forEach((d) => {
          const a = cur[d];
          const b = cloud[d];
          if (!b) return;
          merged[d] = {
            bestScore: Math.max(a.bestScore, b.bestScore ?? 0),
            bestCombo: Math.max(a.bestCombo, b.bestCombo ?? 0),
            bestAccuracy: Math.max(a.bestAccuracy, b.bestAccuracy ?? 0),
            plays: Math.max(a.plays, b.plays ?? 0),
          };
        });
        saveStats(merged);
        // Rewrite cloud in the current envelope so legacy v1 saves get upgraded.
        void ytg.saveCloudData(encodeCloudPayload(merged));
        return merged;
      });
      cloudReadyRef.current = true;
    })();

    // Signal SDK milestones. firstFrameReady after paint, gameReady when interactable.
    const raf = requestAnimationFrame(() => {
      ytg.firstFrameReady();
      // The idle menu is interactable immediately.
      ytg.gameReady();
    });

    // React to YouTube-driven audio, pause and resume.
    const offAudio = ytg.onAudioEnabledChange((enabled) => {
      mutedRef.current = !enabled;
      const eng = engineRef.current;
      if (eng) {
        try {
          eng.master.gain.value = enabled ? 0.35 : 0;
        } catch {
          /* ignore */
        }
      }
    });
    const offPause = ytg.onPause(() => {
      if (stateRef.current === "playing") {
        stateRef.current = "paused";
        setState("paused");
        engineRef.current?.pause();
      }
    });
    const offResume = ytg.onResume(() => {
      if (stateRef.current === "paused") {
        void engineRef.current?.unpause().then(() => {
          stateRef.current = "playing";
          setState("playing");
        });
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      offAudio();
      offPause();
      offResume();
    };
  }, []);


  // Try to surface an interstitial at a natural break. Silently no-ops when
  // outside Playables, on cooldown, or if the ad request fails.
  const tryInterstitial = useCallback(async () => {
    const now = Date.now();
    if (now - lastInterstitialAtRef.current < INTERSTITIAL_MIN_INTERVAL_MS) return;
    lastInterstitialAtRef.current = now;
    // Fire-and-forget: any rejection is swallowed by the SDK wrapper.
    void ytg.requestInterstitialAd();
  }, []);

  const endGame = useCallback(() => {
    if (stateRef.current !== "playing" && stateRef.current !== "paused") return;
    stateRef.current = "over";
    setState("over");
    const engine = engineRef.current;
    engine?.stop();
    const total = totalRef.current || 1;
    const accuracy = Math.round((hitsRef.current / total) * 100);

    const prev = statsAll[difficulty];
    const newBestScore = scoreRef.current > prev.bestScore;
    const newBestCombo = bestComboRef.current > prev.bestCombo;

    const stats: FinalStats = {
      score: scoreRef.current,
      bestCombo: bestComboRef.current,
      accuracy,
      hits: hitsRef.current,
      total: totalRef.current,
      difficulty,
      bpm: engine?.bpm ?? DIFFICULTIES[difficulty].bpm,
      newBestScore,
      newBestCombo,
    };
    setFinalStats(stats);
    setRewardGranted(false);
    setRewardPending(false);

    const next: AllStats = {
      ...statsAll,
      [difficulty]: {
        bestScore: Math.max(prev.bestScore, stats.score),
        bestCombo: Math.max(prev.bestCombo, stats.bestCombo),
        bestAccuracy: Math.max(prev.bestAccuracy, accuracy),
        plays: prev.plays + 1,
      },
    };
    setStatsAll(next);
    saveStats(next);
    // Push best-score to YouTube leaderboards and mirror stats to cloud save
    // using the current versioned envelope.
    void ytg.sendScore(next[difficulty].bestScore);
    void ytg.saveCloudData(encodeCloudPayload(next));


    try {
      const u = new URL(window.location.href);
      u.search = "";
      u.searchParams.set("s", String(stats.score));
      u.searchParams.set("c", String(stats.bestCombo));
      u.searchParams.set("a", String(accuracy));
      u.searchParams.set("d", stats.difficulty);
      setShareUrl(u.toString());
    } catch {
      setShareUrl("");
    }

    // Natural break: game over. Only if we didn't already show one this run.
    if (!shownInterstitialThisRunRef.current) {
      shownInterstitialThisRunRef.current = true;
      void tryInterstitial();
    }
  }, [difficulty, statsAll, tryInterstitial]);

  const startGame = useCallback(async () => {
    const cfg = DIFFICULTIES[difficulty];
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
    hitWindowRef.current = cfg.hitWindow;
    perfectWindowRef.current = cfg.perfectWindow;
    setHud({ score: 0, combo: 0, misses: 0, best: 0 });
    setFinalStats(null);
    setRewardGranted(false);
    setRewardPending(false);
    shownInterstitialThisRunRef.current = false;

    // Stop any prior engine
    engineRef.current?.stop();

    const bpm = cfg.bpm + (Math.random() * 2 - 1) * cfg.bpmJitter;
    const engine = new ChiptuneEngine(bpm, cfg.density);
    engineRef.current = engine;
    await engine.resume();
    try {
      engine.master.gain.value = mutedRef.current ? 0 : 0.35;
    } catch {
      /* ignore */
    }

    stateRef.current = "playing";
    setState("playing");
    engine.start((beat, hitTime, lanes) => {
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
  }, [difficulty]);

  const pauseGame = useCallback(() => {
    if (stateRef.current !== "playing") return;
    stateRef.current = "paused";
    setState("paused");
    engineRef.current?.pause();
    // Natural break: pause is a good spot for an interstitial (rate-limited).
    if (!shownInterstitialThisRunRef.current) {
      shownInterstitialThisRunRef.current = true;
      void tryInterstitial();
    }
  }, [tryInterstitial]);

  const resumeGame = useCallback(async () => {
    if (stateRef.current !== "paused") return;
    await engineRef.current?.unpause();
    stateRef.current = "playing";
    setState("playing");
  }, []);

  const quitToMenu = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    notesRef.current = [];
    stateRef.current = "idle";
    setState("idle");
  }, []);

  const tapLane = useCallback((lane: number) => {
    if (stateRef.current !== "playing") return;
    const engine = engineRef.current;
    if (!engine) return;
    const now = engine.ctx.currentTime;
    const offset = latencyOffsetRef.current;
    let best: Note | null = null;
    let bestDelta = Infinity;
    for (const n of notesRef.current) {
      if (n.lane !== lane || n.judged) continue;
      const d = Math.abs((n.hitAt - now) * 1000 - offset);
      if (d < bestDelta) {
        bestDelta = d;
        best = n;
      }
    }
    laneFlashRef.current[lane] = 1;
    if (best && bestDelta <= hitWindowRef.current) {
      best.hit = true;
      best.judged = true;
      hitsRef.current++;
      comboRef.current++;
      if (comboRef.current > bestComboRef.current)
        bestComboRef.current = comboRef.current;
      const perfect = bestDelta <= perfectWindowRef.current;
      const gain = (perfect ? 100 : 50) * (1 + Math.floor(comboRef.current / 10) * 0.5);
      scoreRef.current += Math.round(gain);
      pulseRef.current = 1;
      judgementsRef.current.push({
        text: perfect ? "PERFECT" : "GOOD",
        color: perfect ? "#ffe94a" : "#22e2ff",
        at: performance.now(),
      });
    } else {
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
      const k = e.key.toLowerCase();
      const idx = LANE_KEYS.indexOf(k as (typeof LANE_KEYS)[number]);
      if (idx >= 0 && stateRef.current === "playing") {
        e.preventDefault();
        tapLane(idx);
      } else if (
        e.key === " " &&
        (stateRef.current === "idle" || stateRef.current === "over")
      ) {
        e.preventDefault();
        startGame();
      } else if (
        (e.key === "Escape" || k === "p") &&
        stateRef.current === "playing"
      ) {
        e.preventDefault();
        pauseGame();
      } else if (
        (e.key === "Escape" || k === "p") &&
        stateRef.current === "paused"
      ) {
        e.preventDefault();
        resumeGame();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tapLane, startGame, pauseGame, resumeGame]);

  // Auto-pause on tab hide
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && stateRef.current === "playing") pauseGame();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [pauseGame]);

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

      const pulse = pulseRef.current;
      pulseRef.current *= 0.9;

      ctx.fillStyle = `rgba(14, 8, 28, ${0.85 - pulse * 0.25})`;
      ctx.fillRect(0, 0, W, H);

      ctx.strokeStyle = `rgba(120, 60, 200, ${0.15 + pulse * 0.2})`;
      ctx.lineWidth = 1;
      for (let y = 0; y < H; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

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

      const laneAreaW = Math.min(W, 520);
      const laneAreaX = (W - laneAreaW) / 2;
      const laneW = laneAreaW / LANES;
      const hitY = H * HIT_LINE_RATIO;

      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW;
        const flash = laneFlashRef.current[i];
        laneFlashRef.current[i] *= 0.85;
        ctx.fillStyle = `rgba(255,255,255,${0.02 + flash * 0.08})`;
        ctx.fillRect(x, 0, laneW - 2, H);
        ctx.strokeStyle = `rgba(255,255,255,${0.08 + flash * 0.3})`;
        ctx.strokeRect(x, 0, laneW - 2, H);
      }

      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(laneAreaX, hitY);
      ctx.lineTo(laneAreaX + laneAreaW, hitY);
      ctx.stroke();

      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW;
        const flash = laneFlashRef.current[i];
        ctx.fillStyle = LANE_COLORS[i];
        ctx.globalAlpha = 0.15 + flash * 0.7;
        ctx.fillRect(x + 4, hitY - 6, laneW - 10, 12);
        ctx.globalAlpha = 1;
      }

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
          ctx.fillStyle = LANE_COLORS[n.lane];
          ctx.shadowColor = LANE_COLORS[n.lane];
          ctx.shadowBlur = 18;
          ctx.fillRect(x, y - h / 2, w, h);
          ctx.shadowBlur = 0;
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillRect(x + 4, y - h / 2 + 4, w - 8, 3);

          if ((now - n.hitAt) * 1000 > hitWindowRef.current + latencyOffsetRef.current) {
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
        notesRef.current = notesRef.current.filter(
          (n) => !n.judged || (engine.ctx.currentTime - n.hitAt) < 1.5,
        );
      }

      ctx.font = "12px 'VT323', monospace";
      ctx.textAlign = "center";
      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW + laneW / 2;
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText(LANE_KEYS[i].toUpperCase(), x, hitY + 26);
      }

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

  const laneFromClientX = (host: HTMLElement, clientX: number) => {
    const rect = host.getBoundingClientRect();
    const rel = clientX - rect.left;
    if (rel < 0 || rel > rect.width) return -1;
    const lane = Math.floor((rel / rect.width) * LANES);
    return Math.max(0, Math.min(LANES - 1, lane));
  };

  const onZonePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const lane = laneFromClientX(e.currentTarget, e.clientX);
    if (lane < 0) return;
    activeTouchesRef.current.set(e.pointerId, lane);
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
    tapLane(lane);
  };
  const onZonePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeTouchesRef.current.has(e.pointerId)) return;
    const lane = laneFromClientX(e.currentTarget, e.clientX);
    if (lane < 0) return;
    const prev = activeTouchesRef.current.get(e.pointerId);
    if (prev !== lane) {
      activeTouchesRef.current.set(e.pointerId, lane);
      tapLane(lane);
    }
  };
  const onZonePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activeTouchesRef.current.delete(e.pointerId);
  };

  // ---------- Share ----------
  const buildShareText = (fs: FinalStats) =>
    `🕹️ Pixel Pulse Rush [${DIFFICULTIES[fs.difficulty].label}]\nScore ${fs.score} · Combo ${fs.bestCombo}x · ${fs.accuracy}% acc — beat my run:`;

  const shareScore = async () => {
    if (!finalStats) return;
    const text = buildShareText(finalStats);
    const url = shareUrl || window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Pixel Pulse Rush", text, url });
        return;
      }
    } catch {
      /* ignore */
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      alert("Score link copied to clipboard!");
    } catch {
      alert(`${text}\n${url}`);
    }
  };

  const copyShareLink = async () => {
    const url = shareUrl || window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      alert("Link copied!");
    } catch {
      prompt("Copy this link:", url);
    }
  };

  const socialLinks = useMemo(() => {
    if (!finalStats) return null;
    const text = buildShareText(finalStats);
    const url = shareUrl || (typeof window !== "undefined" ? window.location.href : "");
    const enc = encodeURIComponent;
    return {
      twitter: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}&quote=${enc(text)}`,
      reddit: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(`Pixel Pulse Rush — ${finalStats.score}`)}`,
      whatsapp: `https://api.whatsapp.com/send?text=${enc(`${text} ${url}`)}`,
    };
  }, [finalStats, shareUrl]);

  const buildCardCanvas = () => {
    if (!finalStats) return null;
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 630;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 1200, 630);
    grad.addColorStop(0, "#1a0836");
    grad.addColorStop(1, "#06222f");
    g.fillStyle = grad;
    g.fillRect(0, 0, 1200, 630);
    g.strokeStyle = "rgba(180,100,255,0.2)";
    for (let y = 0; y < 630; y += 32) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(1200, y);
      g.stroke();
    }
    const colors = ["#ff3ea5", "#22e2ff", "#ffe94a", "#5cff8a"];
    for (let i = 0; i < 40; i++) {
      g.fillStyle = colors[i % 4];
      g.globalAlpha = 0.3 + (i % 5) * 0.1;
      const bx = (i * 137) % 1200;
      const by = (i * 211) % 630;
      g.fillRect(bx, by, 20, 20);
    }
    g.globalAlpha = 1;
    g.fillStyle = "#ffe94a";
    g.font = "bold 64px monospace";
    g.fillText("PIXEL PULSE RUSH", 60, 110);
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "28px monospace";
    g.fillText(
      `${DIFFICULTIES[finalStats.difficulty].label} · ${Math.round(finalStats.bpm)} BPM`,
      60,
      155,
    );
    g.fillStyle = "#ff3ea5";
    g.font = "bold 180px monospace";
    g.fillText(String(finalStats.score), 60, 340);
    g.fillStyle = "#22e2ff";
    g.font = "36px monospace";
    g.fillText(`COMBO  ${finalStats.bestCombo}x`, 60, 430);
    g.fillText(`ACC    ${finalStats.accuracy}%`, 60, 480);
    g.fillText(`HITS   ${finalStats.hits}/${finalStats.total}`, 60, 530);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.font = "24px monospace";
    g.fillText("tap the beat · chase the combo", 60, 590);
    return c;
  };

  const downloadCard = () => {
    const c = buildCardCanvas();
    if (!c || !finalStats) return;
    const url = c.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `pixel-pulse-rush-${finalStats.score}.png`;
    a.click();
  };

  const downloadCardPdf = () => {
    const c = buildCardCanvas();
    if (!c || !finalStats) return;
    const imgData = c.toDataURL("image/jpeg", 0.92);
    const jpegBinary = atob(imgData.split(",")[1]);
    const jpegBytes = new Uint8Array(jpegBinary.length);
    for (let i = 0; i < jpegBinary.length; i++) jpegBytes[i] = jpegBinary.charCodeAt(i);

    const W = 1200;
    const H = 630;
    const parts: (string | Uint8Array)[] = [];
    const offsets: number[] = [];
    let pos = 0;
    const push = (s: string | Uint8Array) => {
      parts.push(s);
      pos += typeof s === "string" ? s.length : s.length;
    };
    const startObj = (n: number) => {
      offsets[n] = pos;
      push(`${n} 0 obj\n`);
    };
    push("%PDF-1.4\n%\xff\xff\xff\xff\n");
    startObj(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    startObj(2);
    push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    startObj(3);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    );
    startObj(4);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
    );
    push(jpegBytes);
    push("\nendstream\nendobj\n");
    const contentStream = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`;
    startObj(5);
    push(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`);
    const xrefStart = pos;
    push(`xref\n0 6\n0000000000 65535 f \n`);
    for (let i = 1; i <= 5; i++) {
      push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
    }
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

    const blobParts: BlobPart[] = parts.map((p) =>
      typeof p === "string" ? p : new Uint8Array(p),
    );
    const blob = new Blob(blobParts, { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pixel-pulse-rush-${finalStats.score}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ---------- Calibration ----------
  const calibRef = useRef<{
    ctx: AudioContext;
    startAt: number;
    interval: number;
    taps: number[];
    total: number;
  } | null>(null);
  const [calProgress, setCalProgress] = useState<
    | null
    | { taps: number; total: number; offset: number }
  >(null);

  const startCalibration = async () => {
    const Ctor: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext || window.AudioContext;
    const ctx = new Ctor();
    await ctx.resume();
    const interval = 0.5; // 120 BPM
    const total = 8;
    const startAt = ctx.currentTime + 0.8;
    for (let i = 0; i < total + 2; i++) {
      const when = startAt + i * interval;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = i === 0 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.3, when + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(when);
      o.stop(when + 0.12);
    }
    calibRef.current = { ctx, startAt, interval, taps: [], total };
    stateRef.current = "calibrating";
    setState("calibrating");
    setCalProgress({ taps: 0, total, offset: 0 });
  };

  const calibrationTap = () => {
    const c = calibRef.current;
    if (!c) return;
    const now = c.ctx.currentTime;
    const elapsed = now - c.startAt;
    if (elapsed < -0.1) return;
    const beatIdx = Math.max(0, Math.round(elapsed / c.interval));
    const beatTime = beatIdx * c.interval;
    const deltaMs = (elapsed - beatTime) * 1000;
    if (Math.abs(deltaMs) > 300) return; // reject wild taps
    c.taps.push(deltaMs);
    const avg = c.taps.reduce((a, b) => a + b, 0) / c.taps.length;
    setCalProgress({ taps: c.taps.length, total: c.total, offset: avg });
    if (c.taps.length >= c.total) finishCalibration(avg);
  };

  const finishCalibration = (offset: number) => {
    const clamped = Math.max(-150, Math.min(150, Math.round(offset)));
    latencyOffsetRef.current = clamped;
    setLatencyOffset(clamped);
    saveOffset(clamped);
    const c = calibRef.current;
    if (c) {
      try {
        c.ctx.close();
      } catch {
        /* ignore */
      }
    }
    calibRef.current = null;
    setCalProgress(null);
    stateRef.current = "idle";
    setState("idle");
  };

  const cancelCalibration = () => {
    const c = calibRef.current;
    if (c) {
      try {
        c.ctx.close();
      } catch {
        /* ignore */
      }
    }
    calibRef.current = null;
    setCalProgress(null);
    stateRef.current = "idle";
    setState("idle");
  };

  const resetCalibration = () => {
    latencyOffsetRef.current = 0;
    setLatencyOffset(0);
    saveOffset(0);
  };

  const diffKeys = useMemo(() => Object.keys(DIFFICULTIES) as Difficulty[], []);

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center px-4 py-6">
      <header className="w-full max-w-[560px] flex items-center justify-between mb-3">
        <h1 className="font-display text-glow-pink text-sm sm:text-base">
          PIXEL PULSE RUSH
        </h1>
        <div className="flex gap-3 text-xs sm:text-sm items-center">
          <span className="text-glow-cyan">SCORE {hud.score}</span>
          <span className="text-glow-yellow">x{hud.combo}</span>
        </div>
      </header>

      <div className="relative w-full max-w-[560px] aspect-[9/16] rounded-lg overflow-hidden border border-border scanlines shadow-[0_0_60px_-10px_rgba(255,62,165,0.5)]">
        <canvas
          ref={canvasRef}
          className="w-full h-full block touch-none select-none pointer-events-none"
        />

        {state === "playing" && (
          <div
            className="absolute left-0 right-0 flex touch-none select-none"
            style={{
              top: `${HIT_LINE_RATIO * 100 - 30}%`,
              bottom: 0,
            }}
            onPointerDown={onZonePointerDown}
            onPointerMove={onZonePointerMove}
            onPointerUp={onZonePointerUp}
            onPointerCancel={onZonePointerUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            {Array.from({ length: LANES }).map((_, i) => (
              <div
                key={i}
                className="flex-1 border-x border-white/5"
                style={{
                  background: `linear-gradient(to top, ${LANE_COLORS[i]}22, transparent)`,
                }}
                aria-label={`Lane ${i + 1}`}
              />
            ))}
          </div>
        )}

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

        {/* Pause button during play */}
        {state === "playing" && (
          <button
            onClick={pauseGame}
            aria-label="Pause"
            className="absolute top-2 left-1/2 -translate-x-1/2 z-20 font-display text-[10px] px-3 py-2 rounded bg-black/60 border border-white/20 text-white/90 backdrop-blur-sm hover:bg-black/80"
          >
            ❚❚ PAUSE
          </button>
        )}

        <div className="absolute top-2 right-2 text-[10px] sm:text-xs font-display text-glow-cyan flex flex-col items-end gap-1">
          <span>BEST {hud.best}x</span>
          {(state === "playing" || state === "paused") && (
            <span className="text-glow-yellow opacity-80">
              {DIFFICULTIES[difficulty].label}
            </span>
          )}
        </div>

        {state === "idle" && (
          <Overlay>
            <h2 className="font-display text-glow-pink text-lg sm:text-2xl mb-2">
              PIXEL PULSE RUSH
            </h2>

            {challenge && (
              <div className="mb-3 px-3 py-2 rounded border border-[var(--neon-yellow)] bg-[var(--neon-yellow)]/10 text-[11px] text-glow-yellow max-w-xs">
                CHALLENGE · {DIFFICULTIES[challenge.diff].label} ·{" "}
                {challenge.score} pts · {challenge.combo}x · {challenge.acc}%
              </div>
            )}

            <p className="max-w-xs text-sm text-muted-foreground mb-3 leading-relaxed">
              Tap the neon blocks as they hit the line. Miss 3 and your pulse
              flatlines.
            </p>

            <div className="w-full max-w-xs mb-3">
              <div className="text-[10px] font-display text-glow-cyan mb-2 tracking-widest">
                DIFFICULTY
              </div>
              <div className="grid grid-cols-3 gap-1">
                {diffKeys.map((k) => (
                  <button
                    key={k}
                    onClick={() => setDifficulty(k)}
                    className={`font-display text-[10px] px-2 py-2 rounded border transition-colors ${
                      difficulty === k
                        ? "bg-[var(--neon-cyan)] text-black border-transparent shadow-[0_0_16px_-2px_var(--neon-cyan)]"
                        : "bg-transparent text-foreground/80 border-border hover:border-[var(--neon-cyan)]"
                    }`}
                  >
                    {DIFFICULTIES[k].label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground min-h-[2.5em]">
                {DIFFICULTIES[difficulty].blurb}
              </div>
            </div>

            {/* Per-difficulty stats */}
            <div className="w-full max-w-xs mb-3 border border-border/60 rounded p-2 bg-black/30">
              <div className="text-[10px] font-display text-glow-cyan mb-1 tracking-widest text-left">
                BEST — {DIFFICULTIES[difficulty].label}
              </div>
              <div className="grid grid-cols-4 gap-1 text-[10px] font-mono text-left">
                <div>
                  <div className="text-muted-foreground">SCORE</div>
                  <div className="text-glow-yellow text-sm">
                    {statsAll[difficulty].bestScore}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">COMBO</div>
                  <div className="text-glow-pink text-sm">
                    {statsAll[difficulty].bestCombo}x
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">ACC</div>
                  <div className="text-glow-cyan text-sm">
                    {statsAll[difficulty].bestAccuracy}%
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">RUNS</div>
                  <div className="text-white text-sm">
                    {statsAll[difficulty].plays}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-center gap-2 mb-3">
              <button
                onClick={startGame}
                className="font-display text-xs px-5 py-3 rounded bg-[var(--neon-pink)] text-black hover:brightness-110 active:translate-y-px shadow-[0_0_24px_-2px_var(--neon-pink)]"
              >
                PRESS START
              </button>
              <div className="flex gap-2 items-center text-[10px] font-mono text-muted-foreground">
                <button
                  onClick={startCalibration}
                  className="font-display text-[9px] px-2 py-1 rounded border border-[var(--neon-cyan)] text-glow-cyan hover:bg-[var(--neon-cyan)]/10"
                >
                  CALIBRATE
                </button>
                <span>
                  offset {latencyOffset >= 0 ? "+" : ""}
                  {latencyOffset}ms
                </span>
                {latencyOffset !== 0 && (
                  <button
                    onClick={resetCalibration}
                    className="underline hover:text-white"
                  >
                    reset
                  </button>
                )}
              </div>
            </div>

            <div className="text-[10px] opacity-70 font-mono">
              KEYS D F J K · SPACE start · ESC/P pause
            </div>
          </Overlay>
        )}

        {state === "paused" && (
          <Overlay>
            <h2 className="font-display text-glow-cyan text-lg sm:text-2xl mb-4">
              PAUSED
            </h2>
            <div className="text-sm mb-4 space-y-1 text-center">
              <div>
                <span className="text-glow-yellow">SCORE</span> {hud.score}
              </div>
              <div>
                <span className="text-glow-pink">COMBO</span> {hud.combo}x ·
                BEST {hud.best}x
              </div>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-[220px]">
              <button
                onClick={resumeGame}
                className="font-display text-xs px-4 py-3 rounded bg-[var(--neon-green)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-green)]"
              >
                ▶ RESUME
              </button>
              <button
                onClick={startGame}
                className="font-display text-xs px-4 py-3 rounded bg-[var(--neon-yellow)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-yellow)]"
              >
                ↻ RESTART
              </button>
              <button
                onClick={quitToMenu}
                className="font-display text-[10px] px-4 py-2 rounded border border-white/30 text-white/80 hover:bg-white/10"
              >
                QUIT
              </button>
            </div>
          </Overlay>
        )}

        {state === "calibrating" && calProgress && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center text-center bg-black/70 backdrop-blur-sm px-4 z-10 touch-none select-none"
            onPointerDown={(e) => {
              e.preventDefault();
              calibrationTap();
            }}
          >
            <h2 className="font-display text-glow-yellow text-base sm:text-xl mb-2">
              CALIBRATE
            </h2>
            <p className="text-[12px] text-muted-foreground max-w-xs mb-4">
              Tap anywhere in time with the beeps. We'll match the timing window
              to your device's audio latency.
            </p>
            <div className="font-display text-glow-cyan text-3xl mb-2">
              {calProgress.taps} / {calProgress.total}
            </div>
            <div className="text-xs text-muted-foreground mb-4">
              offset {calProgress.offset >= 0 ? "+" : ""}
              {Math.round(calProgress.offset)}ms
            </div>
            <div className="flex gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  cancelCalibration();
                }}
                className="font-display text-[10px] px-3 py-2 rounded border border-white/30 text-white/80 hover:bg-white/10"
              >
                CANCEL
              </button>
              {calProgress.taps >= 3 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    finishCalibration(calProgress.offset);
                  }}
                  className="font-display text-[10px] px-3 py-2 rounded bg-[var(--neon-green)] text-black"
                >
                  SAVE
                </button>
              )}
            </div>
          </div>
        )}

        {state === "over" && finalStats && (
          <Overlay>
            <h2 className="font-display text-glow-pink text-base sm:text-xl mb-1">
              FLATLINE
            </h2>
            <div className="text-[10px] font-display text-glow-cyan mb-2 tracking-widest">
              {DIFFICULTIES[finalStats.difficulty].label} ·{" "}
              {Math.round(finalStats.bpm)} BPM
            </div>
            <div className="font-display text-glow-yellow text-3xl sm:text-5xl mb-1">
              {finalStats.score}
            </div>
            {(finalStats.newBestScore || finalStats.newBestCombo) && (
              <div className="mb-2 text-[10px] font-display text-glow-pink animate-pulse">
                {finalStats.newBestScore ? "NEW BEST SCORE! " : ""}
                {finalStats.newBestCombo ? "NEW BEST COMBO!" : ""}
              </div>
            )}
            <div className="text-sm space-y-1 mb-3">
              <div>
                <span className="text-glow-cyan">COMBO</span>{" "}
                {finalStats.bestCombo}x
              </div>
              <div>
                <span className="text-glow-cyan">ACC</span>{" "}
                {finalStats.accuracy}%
              </div>
              <div>
                <span className="text-glow-cyan">HITS</span>{" "}
                {finalStats.hits}/{finalStats.total}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 justify-center mb-2">
              <button
                onClick={startGame}
                className="font-display text-[10px] px-4 py-2 rounded bg-[var(--neon-pink)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-pink)]"
              >
                RETRY
              </button>
              <button
                onClick={quitToMenu}
                className="font-display text-[10px] px-4 py-2 rounded border border-white/30 text-white/80 hover:bg-white/10"
              >
                MENU
              </button>
              <button
                onClick={shareScore}
                className="font-display text-[10px] px-4 py-2 rounded bg-[var(--neon-cyan)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-cyan)]"
              >
                SHARE
              </button>
              <button
                onClick={copyShareLink}
                className="font-display text-[10px] px-4 py-2 rounded border border-[var(--neon-cyan)] text-glow-cyan hover:bg-[var(--neon-cyan)]/10"
              >
                COPY LINK
              </button>
              <button
                onClick={downloadCard}
                className="font-display text-[10px] px-4 py-2 rounded bg-[var(--neon-yellow)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-yellow)]"
              >
                PNG
              </button>
              <button
                onClick={downloadCardPdf}
                className="font-display text-[10px] px-4 py-2 rounded bg-[var(--neon-green)] text-black hover:brightness-110 shadow-[0_0_20px_-2px_var(--neon-green)]"
              >
                PDF
              </button>
            </div>

            {socialLinks && (
              <div className="flex gap-2 justify-center text-[10px] font-display">
                <a
                  href={socialLinks.twitter}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 rounded border border-white/20 hover:border-[var(--neon-cyan)] hover:text-glow-cyan"
                >
                  X
                </a>
                <a
                  href={socialLinks.facebook}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 rounded border border-white/20 hover:border-[var(--neon-cyan)] hover:text-glow-cyan"
                >
                  FB
                </a>
                <a
                  href={socialLinks.reddit}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 rounded border border-white/20 hover:border-[var(--neon-cyan)] hover:text-glow-cyan"
                >
                  REDDIT
                </a>
                <a
                  href={socialLinks.whatsapp}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 rounded border border-white/20 hover:border-[var(--neon-cyan)] hover:text-glow-cyan"
                >
                  WA
                </a>
              </div>
            )}
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
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center bg-black/60 backdrop-blur-sm px-4 z-10 overflow-y-auto py-6">
      {children}
    </div>
  );
}
