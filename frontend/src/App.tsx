import { useEffect, useState } from "react";
import { Events } from "@wailsio/runtime";
import { VideoService } from "../bindings/yyvideopress";
import type { VideoInfo, ConvertResult } from "../bindings/yyvideopress";
import "./App.css";

const AUDIO_KBPS = 128;

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1) + " MB";
}
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}
function baseNoExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
function recMbps(h: number): number {
  if (h >= 2160) return 20;
  if (h >= 1440) return 10;
  if (h >= 1080) return 5;
  if (h >= 720) return 2.5;
  if (h >= 540) return 1.5;
  return 1;
}
function qualityCls(bitrate: number, h: number): string {
  const r = bitrate / recMbps(h);
  if (r >= 1.2) return "q1";
  if (r >= 0.7) return "q2";
  if (r >= 0.4) return "q3";
  return "q4";
}

type Lang = "zh" | "en";

const i18n = {
  zh: {
    title: "小燕压缩",
    subtitle: "压缩、转换视频，让硬盘更清爽。",
    choose: "选择视频…",
    format: "输出格式",
    resolution: "清晰度",
    original: (h: number) => `原始 (${h}p)`,
    bitrate: "码率",
    refLine: (s: number, o: string) => `建议 ${s} · 原始 ≈ ${o} Mbps`,
    useSuggest: "用建议",
    useOriginal: "用原始",
    estSize: "预计大小",
    quality: "画质",
    qLabels: { q1: "清晰", q2: "合适", q3: "一般", q4: "偏糊" } as Record<string, string>,
    qHintBlurry: (h: number) => `码率偏低，${h}p 下会有些糊——调高码率或降清晰度`,
    qHintOk: (h: number, label: string) => `${h}p 在这个码率下${label}`,
    outFolder: "输出位置",
    sameAsSource: "与原视频同目录",
    change: "更改…",
    reset: "重置",
    filename: "文件名",
    compress: "压缩",
    processing: "处理中…",
    smaller: (p: number) => `（小了 ${p}%）`,
  },
  en: {
    title: "YY_VideoPress",
    subtitle: "Compress and convert videos — keep your disk healthy.",
    choose: "Choose a video…",
    format: "Format",
    resolution: "Resolution",
    original: (h: number) => `Original (${h}p)`,
    bitrate: "Bitrate",
    refLine: (s: number, o: string) => `Suggested ${s} · Original ≈ ${o} Mbps`,
    useSuggest: "Suggested",
    useOriginal: "Original",
    estSize: "Est. size",
    quality: "Quality",
    qLabels: { q1: "sharp", q2: "good", q3: "ok", q4: "blurry" } as Record<string, string>,
    qHintBlurry: (h: number) => `Bitrate is low for ${h}p — raise bitrate or lower resolution`,
    qHintOk: (h: number, label: string) => `${h}p looks ${label} at this bitrate`,
    outFolder: "Output folder",
    sameAsSource: "Same as source",
    change: "Change…",
    reset: "Reset",
    filename: "Filename",
    compress: "Compress",
    processing: "Processing…",
    smaller: (p: number) => ` (${p}% smaller)`,
  },
};

function App() {
  const [lang, setLang] = useState<Lang>("zh");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [container, setContainer] = useState<string>("mp4");
  const [height, setHeight] = useState<number>(0);
  const [bitrate, setBitrate] = useState<number>(2.5);
  const [outDir, setOutDir] = useState<string>("");
  const [outName, setOutName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [error, setError] = useState<string>("");

  const L = i18n[lang];

  useEffect(() => {
    const off = Events.On("produce:progress", (e: any) => {
      const d = e?.data;
      const v = Array.isArray(d) ? d[0] : d;
      if (typeof v === "number") setProgress(v);
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, []);

  async function pick() {
    setError("");
    setResult(null);
    try {
      const path = await VideoService.PickFile();
      if (!path) return;
      const vi = await VideoService.Probe(path);
      setInfo(vi);
      setOutDir("");
      setOutName(baseNoExt(vi.name) + "-compressed");
      // Prefer 720p by default when the source is taller; otherwise keep original.
      const defH = vi.height > 720 ? 720 : 0;
      setHeight(defH);
      setBitrate(recMbps(defH > 0 ? defH : vi.height));
      setContainer(vi.container === "mov" || vi.container === "mkv" ? vi.container : "mp4");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  function changeHeight(h: number) {
    setHeight(h);
    if (info) setBitrate(recMbps(h > 0 ? h : info.height));
  }

  async function pickOut() {
    setError("");
    try {
      const dir = await VideoService.PickFolder();
      if (dir) setOutDir(dir);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function run() {
    if (!info) return;
    setBusy(true);
    setProgress(0);
    setError("");
    setResult(null);
    try {
      const totalKbps = bitrate * 1000 + AUDIO_KBPS;
      const targetBytes = Math.round(totalKbps * 125 * info.duration);
      const r = await VideoService.Produce(info.path, targetBytes, height, container, outDir, outName);
      setResult(r);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const srcMbps = info && info.duration > 0 ? (info.sizeBytes * 8) / info.duration / 1e6 : 0;
  const effH = info ? (height > 0 ? height : info.height) : 0;
  const targetBytes = info ? (bitrate * 1000 + AUDIO_KBPS) * 125 * info.duration : 0;
  const barPct = info ? Math.min(100, (targetBytes / info.sizeBytes) * 100) : 0;
  const qcls = qualityCls(bitrate, effH);
  const outputLocation = info ? outDir || dirOf(info.path) : "";
  const actualSaved =
    result && result.inputSizeBytes > 0
      ? Math.round((1 - result.outputSizeBytes / result.inputSizeBytes) * 100)
      : 0;
  const resOptions = info ? [0, ...[1080, 720, 540, 480].filter((h) => h < info.height)] : [0];

  return (
    <div className="app">
      <button className="lang" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
        {lang === "zh" ? "EN" : "中"}
      </button>

      <h1>{L.title}</h1>
      <p className="subtitle">{L.subtitle}</p>

      <button className="pick" onClick={pick}>
        {L.choose}
      </button>

      {info && (
        <div className="card">
          <div className="fname">{info.name}</div>
          <div className="meta">
            {mb(info.sizeBytes)} · {info.width}×{info.height} · {info.codec} ·{" "}
            {info.duration.toFixed(1)}s · .{info.container}
          </div>
        </div>
      )}

      {result && (
        <div className="result">
          <div className="rname">✓ {result.outputName}</div>
          <div className="sizes">
            {mb(result.inputSizeBytes)} → <b>{mb(result.outputSizeBytes)}</b>
            {actualSaved > 0 && <span className="saved">{L.smaller(actualSaved)}</span>}
          </div>
          <div className="path" title={result.outputPath}>
            {result.outputPath}
          </div>
        </div>
      )}

      {info && (
        <div className="panel">
          <label className="row">
            <span>{L.format}</span>
            <select value={container} onChange={(e) => setContainer(e.target.value)}>
              <option value="mp4">.mp4</option>
              <option value="mov">.mov</option>
              <option value="mkv">.mkv</option>
            </select>
          </label>

          <label className="row">
            <span>{L.resolution}</span>
            <select value={height} onChange={(e) => changeHeight(Number(e.target.value))}>
              {resOptions.map((h) => (
                <option key={h} value={h}>
                  {h === 0 ? L.original(info.height) : `${h}p`}
                </option>
              ))}
            </select>
          </label>

          <div className="bitrate-field">
            <label className="row">
              <span>{L.bitrate}</span>
              <span className="bitrate-box">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={bitrate}
                  onChange={(e) => setBitrate(Math.max(0, Number(e.target.value) || 0))}
                />
                <span className="unit">Mbps</span>
              </span>
            </label>
            <div className="ref-line">
              <span>{L.refLine(recMbps(effH), srcMbps.toFixed(1))}</span>
              <span className="ref-btns">
                <button className="linkbtn" onClick={() => setBitrate(recMbps(effH))}>
                  {L.useSuggest}
                </button>
                <button
                  className="linkbtn"
                  onClick={() => setBitrate(Math.round(srcMbps * 10) / 10)}
                >
                  {L.useOriginal}
                </button>
              </span>
            </div>
          </div>

          <div className="est">
            <div className="est-label">
              <span>{L.estSize}</span>
              <span className="est-size">
                {mb(info.sizeBytes)} → <b>≈ {mb(targetBytes)}</b>
              </span>
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${Math.max(4, barPct)}%` }} />
            </div>
          </div>

          <div className="est">
            <div className="est-label">
              <span>{L.quality}</span>
              <span className={"qlabel " + qcls}>
                {L.qLabels[qcls]} · {effH}p
              </span>
            </div>
            <div className="reshint">
              {qcls === "q4" ? L.qHintBlurry(effH) : L.qHintOk(effH, L.qLabels[qcls])}
            </div>
          </div>

          <div className="outrow">
            <div className="outinfo">
              <span className="outlabel">{L.outFolder}</span>
              <span className="outpath" title={outputLocation}>
                {outDir ? outDir : L.sameAsSource}
              </span>
            </div>
            <div className="outbtns">
              <button className="ghost" onClick={pickOut}>
                {L.change}
              </button>
              {outDir && (
                <button className="ghost" onClick={() => setOutDir("")}>
                  {L.reset}
                </button>
              )}
            </div>
          </div>

          <label className="row filerow">
            <span>{L.filename}</span>
            <span className="fileinput">
              <input
                type="text"
                value={outName}
                onChange={(e) => setOutName(e.target.value)}
                placeholder={info ? baseNoExt(info.name) : "output"}
              />
              <span className="ext">.{container}</span>
            </span>
          </label>

          {busy ? (
            <div className="progress">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
              <span className="progress-text">
                {L.processing} {Math.round(progress)}%
              </span>
            </div>
          ) : (
            <button className="go" onClick={run}>
              {L.compress}
            </button>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
}

export default App;
