"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import VolumeCanvas from "../components/volume-canvas";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";
type ArrayInfo = {
  shape: number[];
  chunks: number[];
  dtype: string;
  chunk_count: number;
  uncompressed_bytes: number;
  compressor: string;
  level?: number;
};
type Dataset = {
  id: string;
  name: string;
  path: string;
  array: ArrayInfo;
  levels: ArrayInfo[];
};
type Preview = {
  shape: number[];
  source_shape: number[];
  data: number[];
  normalization: string;
  preview: boolean;
};
type Event = {
  coord: number[];
  accesses: number;
  stored_bytes: number;
  cache_hits: number;
};

function fmt(n: number) {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(2)} MB`;
}

export default function Home() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<Dataset | null>(null);
  const [level, setLevel] = useState(0);
  const [registerPath, setRegisterPath] = useState("");
  const [chunkRead, setChunkRead] = useState<{
    coord: number[];
    cache_hit: boolean;
    stored_bytes: number | null;
    stored_bytes_known: boolean;
    implicit_fill: boolean | null;
    decoded_bytes: number;
    duration_ms: number;
  } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [heat, setHeat] = useState<Event[]>([]);
  const [selection, setSelection] = useState<number[] | null>(null);
  const [activity, setActivity] = useState<number[][]>([]);
  const [slice, setSlice] = useState<{
    axis: number;
    index: number;
    cache_hits: number;
    cache_misses: number;
    stored_bytes: number | null;
    duration_ms: number;
    shape: number[];
    pixels: number[];
  } | null>(null);
  const sliceCanvas = useRef<HTMLCanvasElement>(null);
  const [sliceIndex, setSliceIndex] = useState(40);
  const [sliceAxis, setSliceAxis] = useState(0);
  const [tab, setTab] = useState<"inspect" | "activity">("inspect");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playAt, setPlayAt] = useState(0);
  const [opacity, setOpacity] = useState(82);
  const [windowLevel, setWindowLevel] = useState(72);
  const [volumeOn, setVolumeOn] = useState(true);
  const [latticeOn, setLatticeOn] = useState(true);
  const [resetKey, setResetKey] = useState(0);

  const load = useCallback(
    async (id?: string, nextLevel = 0) => {
      try {
        const list: Dataset[] = await fetch(`${API}/datasets`).then((r) =>
          r.json(),
        );
        setDatasets(list);
        const ds =
          list.find((d: Dataset) => d.id === (id || selected?.id)) || list[0];
        if (!ds) {
          setNotice(
            "No datasets found. Generate sample volumes with uv run python scripts/generate_samples.py, then reload.",
          );
          return;
        }
        const array =
          ds.levels?.find((item) => item.level === nextLevel) || ds.array;
        setLevel(nextLevel);
        setSelected({ ...ds, array });
        setBusy(true);
        const [p, h] = await Promise.all([
          fetch(`${API}/datasets/${ds.id}/preview?level=${nextLevel}`).then(
            (r) => r.json(),
          ),
          fetch(`${API}/telemetry/heatmap/${ds.id}?level=${nextLevel}`).then(
            (r) => r.json(),
          ),
        ]);
        setPreview(p);
        setHeat(h);
        setSliceIndex(Math.floor(array.shape[sliceAxis] / 2));
        setNotice("");
      } catch {
        setNotice("API unavailable. Start the backend at localhost:8000.");
      } finally {
        setBusy(false);
      }
    },
    [selected?.id, sliceAxis],
  );
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chunkDims = selected?.array.chunks || [];
  const lattice = useMemo(() => {
    if (!selected) return [0, 0, 0];
    return selected.array.shape.map((d, i) => Math.ceil(d / chunkDims[i]));
  }, [selected, chunkDims]);
  async function readChunk(coord: number[]) {
    if (!selected) return;
    setSelection(coord);
    setBusy(true);
    try {
      const response = await fetch(
        `${API}/datasets/${selected.id}/chunks/${coord.join(",")}?level=${level}`,
      );
      const d = await response.json();
      if (!response.ok) throw new Error(d.detail || "Chunk read failed");
      setChunkRead(d);
      setNotice(
        d.cache_hit
          ? `Chunk ${coord.join(" · ")} returned from decoded cache`
          : d.implicit_fill
            ? `Chunk ${coord.join(" · ")} is an implicit fill-value chunk`
            : d.stored_bytes_known
              ? `Read ${fmt(d.stored_bytes)} stored chunk payload`
              : `Read chunk ${coord.join(" · ")}; encoded payload size is unavailable for this store`,
      );
      setActivity((a) => [...a, coord]);
      await load(selected.id, level);
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }

  function selectChunk(coord: number[]) {
    setSelection(coord);
    setChunkRead(null);
  }

  async function registerLocal() {
    try {
      const r = await fetch(`${API}/datasets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: registerPath.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Registration failed");
      setRegisterPath("");
      await load(d.id);
      setNotice(`Registered ${d.name}`);
    } catch (e) {
      setNotice(String(e));
    }
  }

  async function requestSlice() {
    if (!selected) return;
    setBusy(true);
    try {
      const d = await fetch(
        `${API}/datasets/${selected.id}/slice/${sliceAxis}/${sliceIndex}?level=${level}`,
      ).then((r) => r.json());
      if (!d.events) throw new Error(d.detail || "Slice request failed");
      setSlice(d);
      setActivity((a) => [
        ...a,
        ...d.events.map((e: { coord: number[] }) => e.coord),
      ]);
      await load(selected.id, level);
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!playing || !activity.length) return;
    const t = setInterval(
      () => setPlayAt((x) => (x + 1) % activity.length),
      360,
    );
    return () => clearInterval(t);
  }, [playing, activity.length]);
  useEffect(() => {
    if (!slice || !sliceCanvas.current) return;
    const [h, w] = slice.shape;
    const canvas = sliceCanvas.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = w;
    canvas.height = h;
    const image = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = slice.pixels[i] || 0,
        k = i * 4;
      image.data[k] = v * 0.65;
      image.data[k + 1] = v * 0.88;
      image.data[k + 2] = v;
      image.data[k + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, [slice]);
  const accessed = activity.length
    ? activity[playing ? playAt : activity.length - 1]
    : null;
  const heatMax = Math.max(1, ...heat.map((h) => h.accesses));

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">C</span>
          <span>
            CHUNKSCOPE<small>SCIENTIFIC STORAGE INSPECTOR</small>
          </span>
        </a>
        <div className="top-center">
          <i className="pulse" /> STORAGE LINK{" "}
          <b>{selected?.path.startsWith("s3://") ? "S3" : "LOCAL"}</b>
          <span className="divider" /> API{" "}
          <b className="online">{busy ? "BUSY" : "READY"}</b>
        </div>
        <div className="top-right">
          <span>WORKSPACE / VOLUME LAB</span>
          <span className="avatar">CS</span>
        </div>
      </header>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      <div className="workspace">
        <aside className="rail">
          <button className="rail-active" title="Volume workspace">
            ▦
          </button>
          <button title="Dataset metadata">⌘</button>
          <button title="Access timeline" onClick={() => setTab("activity")}>
            ◷
          </button>
          <div className="rail-bottom">?</div>
        </aside>
        <section className="left-column">
          <div className="section-label">
            DATASET EXPLORER <span>01</span>
          </div>
          <div className="dataset-card">
            <div className="dataset-head">
              <span className="file-icon">▧</span>
              <div>
                <strong>{selected?.name || "Loading sample…"}</strong>
                <small>{selected?.path || "ZARR · LOCAL STORE"}</small>
              </div>
              <span className="online dot">●</span>
            </div>
            {datasets.length > 1 && (
              <select
                value={selected?.id || ""}
                onChange={(e) => load(e.target.value)}
              >
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            <div className="register-row">
              <input
                aria-label="Zarr source"
                placeholder="relative path or configured s3://…"
                value={registerPath}
                onChange={(e) => setRegisterPath(e.target.value)}
              />
              <button disabled={!registerPath.trim()} onClick={registerLocal}>
                ADD
              </button>
            </div>
            <div className="array-row">
              <span>ARRAY</span>
              <b>{selected?.array.shape.join(" × ") || "—"}</b>
            </div>
            <div className="array-row">
              <span>TYPE</span>
              <b>{selected?.array.dtype || "—"}</b>
            </div>
          </div>
          <div className="section-label spaced">
            VOLUME LAYERS <span>02</span>
          </div>
          <button
            className="layer-row layer-button"
            onClick={() => setVolumeOn(!volumeOn)}
          >
            <span className="layer-eye">◉</span>
            <span>
              Volume rendering<small>Intensity field · level 0</small>
            </span>
            <span className={`switch ${volumeOn ? "on" : ""}`} />
          </button>
          <button
            className="layer-row layer-button"
            onClick={() => setLatticeOn(!latticeOn)}
          >
            <span className="layer-cube">▧</span>
            <span>
              Chunk lattice
              <small>
                {selected?.array.chunk_count.toLocaleString() || "—"} physical
                chunks
              </small>
            </span>
            <span className={`switch ${latticeOn ? "on" : ""}`} />
          </button>
          <div className="section-label spaced">
            RENDER CONTROLS <span>03</span>
          </div>
          <label className="range-label">
            Opacity <b>{opacity}%</b>
            <input
              type="range"
              value={opacity}
              onChange={(e) => setOpacity(+e.target.value)}
            />
          </label>
          <label className="range-label">
            Window <b>{(windowLevel / 72).toFixed(1)}</b>
            <input
              type="range"
              value={windowLevel}
              onChange={(e) => setWindowLevel(+e.target.value)}
            />
          </label>
          <div className="control-pair">
            <span className="small-button">CYAN TRANSFER</span>
            <button
              className="small-button"
              onClick={() => setResetKey((k) => k + 1)}
            >
              RESET VIEW
            </button>
          </div>
          <div className="left-footer">
            <span className="online">●</span> DATA SOURCE VERIFIED{" "}
            <small>CHUNK METRICS FROM REAL READS</small>
          </div>
        </section>

        <section className="viewer-column">
          <div className="viewer-toolbar">
            <div>
              <span className="eyebrow">VOLUME VIEWER</span>
              <h1>
                {selected?.name || "Preparing volume"} <span>·</span>{" "}
                <em>LEVEL {level}</em>
              </h1>
            </div>
            <div className="view-tools">
              {selected && selected.levels.length > 1 && (
                <select
                  className="level-select"
                  aria-label="Resolution level"
                  value={level}
                  onChange={(e) => {
                    const next = +e.target.value;
                    setSlice(null);
                    load(selected.id, next);
                  }}
                >
                  {selected.levels.map((item) => (
                    <option key={item.level} value={item.level}>
                      LEVEL {item.level} · {item.shape.join("×")}
                    </option>
                  ))}
                </select>
              )}
              <span className="view-hint">DRAG TO ORBIT · SCROLL TO ZOOM</span>
              <button
                title="Reset camera"
                onClick={() => setResetKey((k) => k + 1)}
              >
                ⟲
              </button>
              <button
                title="Fullscreen"
                onClick={() =>
                  document.querySelector(".viewer")?.requestFullscreen()
                }
              >
                ⛶
              </button>
            </div>
          </div>
          <div className="viewer">
            <div className="viewer-grid" />
            <div className="axis-label y-axis">
              SUPERIOR <i /> INFERIOR
            </div>
            <div className="axis-label x-axis">
              ANTERIOR <i /> POSTERIOR
            </div>
            <div className="volume-wrap">
              <div className="volume-shadow" />
              {preview && selected && (
                <VolumeCanvas
                  data={preview.data}
                  shape={preview.shape}
                  sourceShape={selected.array.shape}
                  chunks={selected.array.chunks}
                  opacity={opacity / 100}
                  windowLevel={windowLevel / 72}
                  resetKey={resetKey}
                  selectedCoord={selection || accessed}
                  heatmap={heat}
                  showVolume={volumeOn}
                  showLattice={latticeOn}
                  onSelect={selectChunk}
                />
              )}
            </div>
            <div className="axis-corner">
              <span>Z</span>
              <span>Y</span>
              <span>X</span>
            </div>
            <div className="volume-stamp">
              XY PLANE <b>PREVIEW</b>
            </div>
            <div className="view-legend">
              <span>
                <i className="legend-voxel" />
                VOLUME
              </span>
              <span>
                <i className="legend-chunk" />
                CHUNK BOUNDARY
              </span>
              <span>
                <i className="legend-hot" />
                RECENT ACCESS
              </span>
            </div>
          </div>
          <div className="metrics-strip">
            <div>
              <small>ARRAY SHAPE</small>
              <b>{selected?.array.shape.join(" × ") || "—"}</b>
            </div>
            <div>
              <small>CHUNK SHAPE</small>
              <b>{selected?.array.chunks.join(" × ") || "—"}</b>
            </div>
            <div>
              <small>CHUNK COUNT</small>
              <b>{selected?.array.chunk_count.toLocaleString() || "—"}</b>
            </div>
            <div>
              <small>UNCOMPRESSED</small>
              <b>{selected ? fmt(selected.array.uncompressed_bytes) : "—"}</b>
            </div>
          </div>
          <div className="slice-panel">
            <div className="slice-title">
              <span className="eyebrow">SLICE REQUEST</span>
              <select
                className="axis-chip axis-select"
                value={sliceAxis}
                onChange={(e) => {
                  setSliceAxis(+e.target.value);
                  setSliceIndex(
                    Math.floor(
                      (selected?.array.shape[+e.target.value] || 1) / 2,
                    ),
                  );
                }}
              >
                <option value="0">AXIAL / Z</option>
                <option value="1">CORONAL / Y</option>
                <option value="2">SAGITTAL / X</option>
              </select>
            </div>
            <div className="slice-control">
              <span>{["Z", "Y", "X"][sliceAxis]} INDEX</span>
              <input
                type="range"
                min="0"
                max={Math.max(0, (selected?.array.shape[sliceAxis] || 1) - 1)}
                value={sliceIndex}
                onChange={(e) => setSliceIndex(+e.target.value)}
              />
              <b>
                {sliceIndex.toString().padStart(3, "0")}{" "}
                <small>/ {selected?.array.shape[sliceAxis]}</small>
              </b>
              <button
                className="primary"
                disabled={busy || !selected}
                onClick={requestSlice}
              >
                {busy ? "READING…" : "REQUEST SLICE ↗"}
              </button>
            </div>
            {slice && (
              <>
                <div className="slice-result">
                  <span>
                    LAST REQUEST · {slice.cache_hits + slice.cache_misses}{" "}
                    CHUNKS
                  </span>
                  <span>
                    PAYLOAD{" "}
                    <b>
                      {slice.stored_bytes === null
                        ? "NOT MEASURED"
                        : fmt(slice.stored_bytes)}
                    </b>
                  </span>
                  <span>
                    CACHE{" "}
                    <b>
                      {slice.cache_hits} HIT / {slice.cache_misses} MISS
                    </b>
                  </span>
                  <span>
                    TIME <b>{slice.duration_ms.toFixed(1)} ms</b>
                  </span>
                </div>
                <canvas
                  ref={sliceCanvas}
                  className="slice-preview"
                  aria-label="Requested Zarr slice"
                />
              </>
            )}
          </div>
        </section>

        <aside className="inspector">
          <div className="inspector-tabs">
            <button
              className={tab === "inspect" ? "tab-active" : ""}
              onClick={() => setTab("inspect")}
            >
              INSPECTOR
            </button>
            <button
              className={tab === "activity" ? "tab-active" : ""}
              onClick={() => setTab("activity")}
            >
              ACTIVITY <span>{activity.length}</span>
            </button>
          </div>
          {tab === "inspect" ? (
            <>
              <div className="inspect-title">
                <span className="cube-large">▧</span>
                <div>
                  <small>SELECTED CHUNK</small>
                  <h2>{selection?.join(" · ") || "No selection"}</h2>
                </div>
              </div>
              <button
                className="read-button"
                disabled={!selection || busy}
                onClick={() => selection && readChunk(selection)}
              >
                ↓ &nbsp; READ CHUNK FROM STORE
              </button>
              <div className="inspector-section">
                <h3>CHUNK COORDINATES</h3>
                <div className="coord-grid">
                  {(selection || [0, 0, 0]).map((v, i) => (
                    <div key={i}>
                      <small>{["Z", "Y", "X"][i]}</small>
                      <b>{v}</b>
                    </div>
                  ))}
                </div>
              </div>
              <div className="inspector-section">
                <h3>ARRAY BOUNDS</h3>
                {(selection || [0, 0, 0]).map((v, i) => (
                  <div className="bound-row" key={i}>
                    <span>{["Z", "Y", "X"][i]} AXIS</span>
                    <b>
                      {v * (chunkDims[i] || 0)} —{" "}
                      {Math.min(
                        (v + 1) * (chunkDims[i] || 0),
                        selected?.array.shape[i] || 0,
                      )}
                    </b>
                  </div>
                ))}
              </div>
              <div className="inspector-section">
                <h3>STORAGE STATE</h3>
                <div className="state-row">
                  <i
                    className={
                      selection &&
                      heat.some(
                        (h) => h.coord.join(",") === selection.join(","),
                      )
                        ? "cached"
                        : ""
                    }
                  />
                  <span>
                    {selection &&
                    heat.some((h) => h.coord.join(",") === selection.join(","))
                      ? "Previously accessed"
                      : "Not loaded"}
                  </span>
                  <small>APPLICATION CACHE</small>
                </div>
                <div className="bound-row">
                  <span>ARRAY TYPE</span>
                  <b>{selected?.array.dtype || "—"}</b>
                </div>
                <div className="bound-row">
                  <span>COMPRESSOR</span>
                  <b>{selected?.array.compressor || "None"}</b>
                </div>
                {chunkRead &&
                  selection &&
                  chunkRead.coord.join(",") === selection.join(",") && (
                    <>
                      <div className="bound-row">
                        <span>OBJECT LENGTH</span>
                        <b>
                          {chunkRead.stored_bytes_known
                            ? fmt(chunkRead.stored_bytes || 0)
                            : "NOT MEASURED"}
                        </b>
                      </div>
                      <div className="bound-row">
                        <span>LAST READ</span>
                        <b>
                          {chunkRead.cache_hit
                            ? "CACHE HIT"
                            : chunkRead.implicit_fill
                              ? "IMPLICIT FILL"
                              : "STORAGE MISS"}
                        </b>
                      </div>
                    </>
                  )}
              </div>
              <div className="inspector-note">
                Chunk selection is metadata-only. Storage reads happen only when
                you request one.
              </div>
            </>
          ) : (
            <>
              <div className="activity-head">
                <small>RECORDED ACCESS TRACE</small>
                <b>{activity.length} EVENTS</b>
              </div>
              <div className="timeline">
                {activity.slice(-12).map((coord, i) => (
                  <div key={i} className="event-row">
                    <span className="event-dot" />
                    <span>CHUNK {coord.join(" · ")}</span>
                    <small>READ</small>
                  </div>
                ))}
              </div>
              <div className="playback">
                <div className="play-row">
                  <button onClick={() => setPlaying(!playing)}>
                    {playing ? "Ⅱ" : "▶"}
                  </button>
                  <span>{playing ? "PLAYING" : "PAUSED"}</span>
                  <small>
                    {activity.length ? playAt + 1 : 0} / {activity.length}
                  </small>
                </div>
                <input
                  type="range"
                  min="0"
                  max={Math.max(0, activity.length - 1)}
                  value={playAt}
                  onChange={(e) => {
                    setPlayAt(+e.target.value);
                    if (activity[+e.target.value])
                      setSelection(activity[+e.target.value]);
                  }}
                />
              </div>
              <div className="inspector-section">
                <h3>ACCESS HEATMAP</h3>
                {heat.length === 0 ? (
                  <p className="empty">
                    Heatmap appears after real chunk reads.
                  </p>
                ) : (
                  heat.slice(0, 6).map((h) => (
                    <div className="bound-row" key={h.coord.join(",")}>
                      <span>{h.coord.join(" · ")}</span>
                      <b>
                        {h.accesses} ACCESS · {h.cache_hits} HIT
                      </b>
                    </div>
                  ))
                )}
              </div>
              <button
                className="read-button"
                onClick={async () => {
                  await fetch(`${API}/cache`, { method: "DELETE" });
                  setNotice("Decoded chunk cache cleared.");
                }}
              >
                CLEAR DECODED CACHE
              </button>
            </>
          )}
        </aside>
      </div>
      <footer className="statusbar">
        <span>
          <i className="online dot" /> STORAGE READY
        </span>
        <span>
          {selected?.path.startsWith("s3://")
            ? "S3 OBJECT STORAGE"
            : "LOCAL ZARR"}{" "}
          · DUCKDB TELEMETRY
        </span>
        <span>
          ENCODED OBJECT LENGTH WHEN AVAILABLE · NETWORK BYTES UNMEASURED
        </span>
        <span>CHUNKSCOPE 0.1</span>
      </footer>
    </main>
  );
}
