"""ChunkScope API. Local Zarr access is bounded and all events are persisted."""
from __future__ import annotations

import json
import os
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event, RLock
from typing import Any
from urllib.parse import urlsplit

import duckdb
import numpy as np
import zarr
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from .chunks import chunk_bounds, chunks_for_slice

ROOT = Path(os.getenv("CHUNKSCOPE_DATA_DIR", "data/volumes")).resolve()
DB_PATH = Path(os.getenv("CHUNKSCOPE_DB", "data/telemetry.duckdb")).resolve()
MAX_PREVIEW_DIM = int(os.getenv("CHUNKSCOPE_MAX_PREVIEW_DIM", "96"))
MAX_CHUNKS = int(os.getenv("CHUNKSCOPE_MAX_CHUNKS", "20000"))
MAX_CHUNK_BYTES = int(os.getenv("CHUNKSCOPE_MAX_CHUNK_BYTES", str(64 * 1024 * 1024)))
MAX_SLICE_VOXELS = int(os.getenv("CHUNKSCOPE_MAX_SLICE_VOXELS", str(16 * 1024 * 1024)))
ROOT.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    if not any(ROOT.glob("*.zarr")):
        # A fresh local checkout gets a real, small Zarr demo automatically.
        from scripts.generate_samples import main as generate_samples
        generate_samples()
    with db() as con:
        for path in ROOT.glob("*.zarr"):
            ident = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
            con.execute("INSERT OR IGNORE INTO datasets (id,path,name) VALUES (?,?,?)", [ident, path.name, path.stem.replace('-', ' ').title()])
    yield


app = FastAPI(title="ChunkScope", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(","), allow_methods=["*"], allow_headers=["*"])
lock = RLock()
cache: OrderedDict[tuple[str, str, tuple[int, ...]], tuple[np.ndarray, bool | None]] = OrderedDict()
inflight: dict[tuple[str, str, tuple[int, ...]], Event] = {}
CACHE_LIMIT = int(os.getenv("CHUNKSCOPE_CACHE_BYTES", str(128 * 1024 * 1024)))
cache_bytes = 0


def db() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(str(DB_PATH))


def init_db() -> None:
    with db() as con:
        con.execute("CREATE TABLE IF NOT EXISTS accesses (id VARCHAR, ts TIMESTAMP DEFAULT current_timestamp, dataset VARCHAR, array_path VARCHAR, coord VARCHAR, kind VARCHAR, cache_hit BOOLEAN, stored_bytes BIGINT, elapsed_ms DOUBLE, implicit_fill BOOLEAN)")
        con.execute("CREATE TABLE IF NOT EXISTS datasets (id VARCHAR PRIMARY KEY, path VARCHAR, name VARCHAR, added TIMESTAMP DEFAULT current_timestamp)")


def safe_path(relative: str) -> Path:
    candidate = (ROOT / relative).resolve()
    if candidate != ROOT and ROOT not in candidate.parents:
        raise HTTPException(400, "Dataset path must stay inside the configured data root")
    if not candidate.exists():
        raise HTTPException(404, "Dataset was not found under the configured data root")
    return candidate


def resolve_location(location: str) -> Path | str:
    if not location.startswith("s3://"):
        return safe_path(location)
    parts = urlsplit(location)
    bucket = os.getenv("S3_BUCKET", "").strip()
    configured_prefix = os.getenv("S3_PREFIX", "").strip("/")
    key = parts.path.lstrip("/")
    requested_prefix = f"{configured_prefix}/" if configured_prefix else ""
    if not bucket:
        raise HTTPException(503, "S3 registration is disabled until S3_BUCKET is configured")
    if parts.scheme != "s3" or parts.username or parts.password or parts.query or parts.fragment or parts.port or not parts.hostname:
        raise HTTPException(400, "S3 source must be a bucket and prefix URI without credentials or query parameters")
    if parts.hostname != bucket:
        raise HTTPException(400, "S3 source bucket must match the configured S3_BUCKET")
    if any(part in (".", "..") for part in key.split("/")) or (configured_prefix and key != configured_prefix and not key.startswith(requested_prefix)):
        raise HTTPException(400, "S3 source prefix is outside the configured S3_PREFIX")
    return f"s3://{bucket}/{key}" if key else f"s3://{bucket}"


def open_store(location: Path | str) -> Any:
    if isinstance(location, str) and location.startswith("s3://"):
        from zarr.storage import FsspecStore
        options: dict[str, Any] = {"asynchronous": True, "use_ssl": os.getenv("S3_USE_TLS", "true").lower() in ("1", "true", "yes")}
        endpoint = os.getenv("S3_ENDPOINT_URL", "").strip()
        region = os.getenv("S3_REGION", "").strip()
        access_key = os.getenv("S3_ACCESS_KEY_ID", "").strip()
        secret_key = os.getenv("S3_SECRET_ACCESS_KEY", "").strip()
        if bool(access_key) != bool(secret_key):
            raise HTTPException(503, "Configure both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither")
        if endpoint:
            options["client_kwargs"] = {"endpoint_url": endpoint, **({"region_name": region} if region else {})}
        elif region:
            options["client_kwargs"] = {"region_name": region}
        if access_key:
            options["key"] = access_key
        if secret_key:
            options["secret"] = secret_key
        try:
            return FsspecStore.from_url(location, storage_options=options, read_only=True)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, f"Could not connect to configured S3 storage: {type(exc).__name__}") from exc
    return str(location)


def open_array(path: Path | str, array_path: str = "") -> Any:
    store = open_store(path)
    try:
        root = zarr.open_group(store=store, mode="r")
        if array_path:
            return root[array_path]
        # Prefer the OME-NGFF conventional level 0, otherwise choose a stable path.
        keys = list(root.array_keys())
        if keys:
            return root["0"] if "0" in keys else root[sorted(keys, key=lambda k: (not k.isdigit(), int(k) if k.isdigit() else k))[0]]
    except HTTPException:
        raise
    except Exception:
        pass
    try:
        # A bare array is also accepted.
        return zarr.open_array(store=store, mode="r")
    except Exception as exc:
        raise HTTPException(422, f"Could not open Zarr array: {type(exc).__name__}") from exc


def open_level(path: Path | str, level: int) -> Any:
    if level == 0:
        return open_array(path)
    try:
        group = zarr.open_group(store=open_store(path), mode="r")
        key = str(level)
        if key not in group.array_keys():
            raise HTTPException(404, f"Resolution level {level} is not present")
        return group[key]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(404, f"Resolution level {level} is not present") from exc


def array_info(array: Any) -> dict[str, Any]:
    chunks = tuple(int(n) for n in array.chunks)
    shape = tuple(int(n) for n in array.shape)
    count = int(np.prod([(s + c - 1) // c for s, c in zip(shape, chunks)]))
    if count > MAX_CHUNKS:
        raise HTTPException(413, f"Array has {count:,} chunks; configured limit is {MAX_CHUNKS:,}")
    try:
        compressor = array.compressors
    except Exception:
        try:
            compressor = array.compressor
        except Exception:
            compressor = None
    return {"shape": list(shape), "chunks": list(chunks), "dtype": str(array.dtype), "ndim": len(shape), "chunk_count": count,
            "voxels": int(np.prod(shape)), "uncompressed_bytes": int(np.prod(shape) * array.dtype.itemsize),
            "fill_value": str(array.fill_value), "compressor": str(compressor), "order": getattr(array, "order", "C")}


def level_info(path: Path | str, fallback: Any) -> list[dict[str, Any]]:
    try:
        group = zarr.open_group(store=open_store(path), mode="r")
        keys = [key for key in group.array_keys() if key.isdigit()]
        if keys:
            return [{"level": int(key), **array_info(group[key])} for key in sorted(keys, key=int)]
    except Exception:
        pass
    return [{"level": 0, **array_info(fallback)}]


def chunk_key(dataset: str, array: Any, coord: tuple[int, ...]) -> Path | None:
    """Return a physical v2 chunk path where derivable. Zarr's array read remains authoritative."""
    # Zarr v2 default DirectoryStore layout. For nested arrays, the array path is included.
    metadata = getattr(array, "metadata", None)
    path = getattr(array, "path", "")
    if dataset.startswith("s3://"):
        return None
    if getattr(metadata, "zarr_format", 2) != 2:
        return None
    try:
        return (ROOT / dataset / path / ".".join(map(str, coord))).resolve()
    except Exception:
        return None


def record(dataset: str, arr: str, coord: tuple[int, ...], kind: str, hit: bool, nbytes: int | None, elapsed: float, implicit: bool | None) -> None:
    with lock, db() as con:
        con.execute("INSERT INTO accesses (id,dataset,array_path,coord,kind,cache_hit,stored_bytes,elapsed_ms,implicit_fill) VALUES (?,?,?,?,?,?,?,?,?)",
                    [str(uuid.uuid4()), dataset, arr, json.dumps(coord), kind, hit, nbytes, elapsed, implicit])


def read_chunk(dataset: str, array_path: str, array: Any, coord: tuple[int, ...], kind: str = "chunk") -> tuple[np.ndarray, dict[str, Any]]:
    global cache_bytes
    key = (dataset, array_path, coord)
    started = time.perf_counter()
    with lock:
        if key in cache:
            block, was_implicit = cache.pop(key)
            cache[key] = (block, was_implicit)
            record(dataset, array_path, coord, kind, True, 0, (time.perf_counter() - started) * 1000, was_implicit)
            return block, {"cache_hit": True, "stored_bytes": 0, "stored_bytes_known": True, "implicit_fill": was_implicit, "duration_ms": (time.perf_counter() - started) * 1000}
        wait_for = inflight.get(key)
        if wait_for is None:
            wait_for = Event()
            inflight[key] = wait_for
            leader = True
        else:
            leader = False
    if not leader:
        wait_for.wait()
        # The completed read is now either in cache or failed; retrying handles both cases.
        return read_chunk(dataset, array_path, array, coord, kind)
    try:
        chunk_shape = tuple(int(x) for x in array.chunks)
        bounds = tuple(slice(a, b) for a, b in chunk_bounds(tuple(map(int, array.shape)), chunk_shape, coord))
        payload_path = chunk_key(dataset, array, coord)
        if payload_path is None:
            stored_bytes, implicit = None, None
        elif payload_path.is_file():
            stored_bytes, implicit = payload_path.stat().st_size, False
        else:
            # For local Zarr v2 DirectoryStore, an absent key is a valid fill-value chunk.
            stored_bytes, implicit = 0, True
        decoded_size = int(np.prod([s.stop - s.start for s in bounds]) * array.dtype.itemsize)
        if decoded_size > MAX_CHUNK_BYTES:
            raise HTTPException(413, f"Chunk requires {decoded_size:,} decoded bytes; configured limit is {MAX_CHUNK_BYTES:,}")
        try:
            block = np.asarray(array[bounds]).copy()
        except Exception as exc:
            record(dataset, array_path, coord, kind, False, stored_bytes, (time.perf_counter() - started) * 1000, implicit)
            raise HTTPException(422, f"Chunk read failed: {type(exc).__name__}") from exc
        if block.nbytes <= CACHE_LIMIT:
            with lock:
                while cache and cache_bytes + block.nbytes > CACHE_LIMIT:
                    _, (old, _) = cache.popitem(last=False)
                    cache_bytes -= old.nbytes
                cache[key] = (block, implicit)
                cache_bytes += block.nbytes
        elapsed = (time.perf_counter() - started) * 1000
        record(dataset, array_path, coord, kind, False, stored_bytes, elapsed, implicit)
        return block, {"cache_hit": False, "stored_bytes": stored_bytes, "stored_bytes_known": stored_bytes is not None, "implicit_fill": implicit, "duration_ms": elapsed}
    except HTTPException:
        raise
    finally:
        with lock:
            inflight.pop(key, None)
            wait_for.set()


class RegisterRequest(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    name: str | None = Field(default=None, max_length=120)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "data_root_configured": True, "zarr_version": zarr.__version__}


@app.get("/api/datasets")
def datasets() -> list[dict[str, Any]]:
    with db() as con:
        rows = con.execute("SELECT id,path,name FROM datasets ORDER BY CASE WHEN name='Medical Volume' THEN 0 ELSE 1 END, added").fetchall()
    result = []
    for ident, relative, name in rows:
        try:
            path = resolve_location(relative)
            arr = open_array(path)
            result.append({"id": ident, "name": name, "path": relative, "array": array_info(arr), "levels": level_info(path, arr)})
        except HTTPException:
            continue
    return result


@app.post("/api/datasets")
def register(req: RegisterRequest) -> dict[str, Any]:
    path = resolve_location(req.path)
    try:
        arr = open_array(path)
        info = array_info(arr)
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(422, "Dataset is not a readable Zarr group or array") from exc
    ident = str(uuid.uuid5(uuid.NAMESPACE_URL, req.path))
    with db() as con:
        con.execute("INSERT OR REPLACE INTO datasets (id,path,name) VALUES (?,?,?)", [ident, req.path, req.name or path.name])
    return {"id": ident, "name": req.name or (Path(urlsplit(req.path).path).name if req.path.startswith("s3://") else path.name), "path": req.path, "array": info, "levels": level_info(path, arr)}


def dataset_path(dataset_id: str) -> tuple[str, Path | str]:
    with db() as con:
        row = con.execute("SELECT path FROM datasets WHERE id=?", [dataset_id]).fetchone()
    if not row:
        raise HTTPException(404, "Dataset is not registered")
    return row[0], resolve_location(row[0])


@app.get("/api/datasets/{dataset_id}/metadata")
def metadata(dataset_id: str) -> dict[str, Any]:
    relative, path = dataset_path(dataset_id)
    arr = open_array(path)
    name = Path(urlsplit(relative).path).name if isinstance(path, str) else path.name
    return {"id": dataset_id, "name": name, "array_path": getattr(arr, "path", ""), "array": array_info(arr), "levels": level_info(path, arr), "attrs": dict(getattr(arr, "attrs", {}))}


def make_preview(array: Any, max_dim: int = MAX_PREVIEW_DIM) -> tuple[np.ndarray, list[int]]:
    if array.ndim != 3:
        raise HTTPException(422, "3D preview currently requires selecting a 3D array")
    shape = tuple(map(int, array.shape))
    steps = tuple(max(1, int(np.ceil(n / max_dim))) for n in shape)
    # Slice first, then bound allocation. Zarr resolves only intersecting chunks.
    preview = np.asarray(array[tuple(slice(0, n, step) for n, step in zip(shape, steps))])
    finite = preview[np.isfinite(preview)]
    lo, hi = (np.percentile(finite, [1, 99]) if finite.size else (0, 1))
    if hi <= lo:
        hi = lo + 1
    normalized = np.nan_to_num(np.clip((preview.astype(np.float32) - lo) / (hi - lo), 0, 1))
    return (normalized * 255).astype(np.uint8), list(preview.shape)


@app.get("/api/datasets/{dataset_id}/preview")
def preview(dataset_id: str, level: int = Query(default=0, ge=0)) -> dict[str, Any]:
    _, path = dataset_path(dataset_id)
    array = open_level(path, level)
    data, preview_shape = make_preview(array)
    return {"shape": preview_shape, "source_shape": list(array.shape), "dtype": "uint8", "data": data.ravel().tolist(), "normalization": "finite 1st–99th percentile", "preview": preview_shape != list(array.shape)}


@app.get("/api/datasets/{dataset_id}/chunks/{coord}")
def chunk(dataset_id: str, coord: str, level: int = Query(default=0, ge=0)) -> dict[str, Any]:
    relative, path = dataset_path(dataset_id)
    array = open_level(path, level)
    try:
        coordinates = tuple(int(part) for part in coord.split(","))
    except ValueError as exc:
        raise HTTPException(400, "Coordinates must be comma separated integers") from exc
    if len(coordinates) != array.ndim or any(c < 0 or c >= (array.shape[i] + array.chunks[i] - 1) // array.chunks[i] for i, c in enumerate(coordinates)):
        raise HTTPException(400, "Chunk coordinate is outside this array")
    block, stats = read_chunk(relative, getattr(array, "path", ""), array, coordinates)
    return {"coord": coordinates, "shape": block.shape, "dtype": str(block.dtype), "decoded_bytes": block.nbytes, **stats}


@app.get("/api/datasets/{dataset_id}/slice/{axis}/{index}")
def slice_request(dataset_id: str, axis: int, index: int, level: int = Query(default=0, ge=0)) -> dict[str, Any]:
    relative, path = dataset_path(dataset_id)
    array = open_level(path, level)
    if array.ndim != 3 or axis not in (0, 1, 2) or index < 0 or index >= array.shape[axis]:
        raise HTTPException(400, "Slice request requires a valid axis and index on a 3D array")
    slice_voxels = int(np.prod([array.shape[i] for i in range(3) if i != axis]))
    if slice_voxels > MAX_SLICE_VOXELS:
        raise HTTPException(413, f"Slice contains {slice_voxels:,} voxels; configured limit is {MAX_SLICE_VOXELS:,}")
    start = time.perf_counter()
    coords = chunks_for_slice(tuple(map(int, array.shape)), tuple(map(int, array.chunks)), axis, index)
    if len(coords) > MAX_CHUNKS:
        raise HTTPException(413, f"Slice touches {len(coords):,} chunks; configured limit is {MAX_CHUNKS:,}")
    # Read exactly the intersecting chunks through the application cache, then assemble slice.
    plane = np.empty(tuple(int(array.shape[i]) for i in range(3) if i != axis), dtype=array.dtype)
    events = []
    for c in coords:
        block, stats = read_chunk(relative, getattr(array, "path", ""), array, c, "slice")
        local = index - c[axis] * array.chunks[axis]
        part = np.take(block, local, axis=axis)
        target = tuple(slice(c[i] * array.chunks[i], min((c[i] + 1) * array.chunks[i], array.shape[i])) for i in range(3) if i != axis)
        plane[target] = part
        events.append({"coord": c, **stats})
    finite = plane[np.isfinite(plane)]
    lo, hi = np.percentile(finite, [1, 99]) if finite.size else (0, 1)
    if hi <= lo: hi = lo + 1
    pixels = (np.nan_to_num(np.clip((plane.astype(np.float32) - lo) / (hi - lo), 0, 1)) * 255).astype(np.uint8)
    return {"axis": axis, "index": index, "shape": pixels.shape, "pixels": pixels.ravel().tolist(), "chunks_accessed": len(coords),
            "cache_hits": sum(e["cache_hit"] for e in events), "cache_misses": sum(not e["cache_hit"] for e in events),
            "stored_bytes": sum(e["stored_bytes"] or 0 for e in events) if all(e["stored_bytes_known"] for e in events) else None,
            "stored_bytes_known": all(e["stored_bytes_known"] for e in events), "duration_ms": (time.perf_counter() - start) * 1000, "events": events}


@app.get("/api/telemetry/heatmap/{dataset_id}")
def heatmap(dataset_id: str, level: int = Query(default=0, ge=0)) -> list[dict[str, Any]]:
    relative, path = dataset_path(dataset_id)
    array_path = getattr(open_level(path, level), "path", "")
    with db() as con:
        rows = con.execute("SELECT coord,count(*),sum(stored_bytes),sum(CASE WHEN cache_hit THEN 1 ELSE 0 END) FROM accesses WHERE dataset=? AND array_path=? GROUP BY coord", [relative, array_path]).fetchall()
    return [{"coord": json.loads(coord), "accesses": count, "stored_bytes": nbytes, "cache_hits": hits} for coord, count, nbytes, hits in rows]


@app.get("/api/telemetry/events/{dataset_id}")
def events(dataset_id: str, level: int = Query(default=0, ge=0)) -> list[dict[str, Any]]:
    relative, path = dataset_path(dataset_id)
    array_path = getattr(open_level(path, level), "path", "")
    with db() as con:
        rows = con.execute("SELECT ts,array_path,coord,kind,cache_hit,stored_bytes,elapsed_ms,implicit_fill FROM accesses WHERE dataset=? AND array_path=? ORDER BY ts DESC LIMIT 500", [relative, array_path]).fetchall()
    return [{"timestamp": str(r[0]), "array_path": r[1], "coord": json.loads(r[2]), "kind": r[3], "cache_hit": r[4], "stored_bytes": r[5], "duration_ms": r[6], "implicit_fill": r[7]} for r in rows]


@app.delete("/api/cache")
def clear_cache() -> dict[str, Any]:
    global cache_bytes
    with lock:
        cache.clear(); cache_bytes = 0
    return {"cleared": True}
