# Architecture and measurements

## Request path

The Next.js client requests dataset metadata, a bounded preview, chunk reads, slices, and telemetry from FastAPI. The API resolves local datasets beneath `CHUNKSCOPE_DATA_DIR` or S3 locations beneath the configured bucket and optional prefix. It opens the Zarr store and selects the first 3D array. Preview samples are normalized to 8-bit values and sent to the browser, where a WebGL2 texture and fragment shader render the volume. The shader draws chunk boundaries in volume coordinates, and pointer selection maps a point in the volume to its source chunk coordinate.

A chunk request computes array bounds from the chunk coordinate and reads that region through Zarr. A slice request enumerates the chunks intersecting the requested plane, obtains them through the same cache-aware read path, and assembles the output image. A cache hit returns a decoded NumPy block without indexing the Zarr array again.

## Cache and persistence

The process-local LRU is keyed by dataset location, array path, and chunk coordinate. It accounts for decoded NumPy bytes and evicts least-recently-used entries to stay within its configured limit. DuckDB stores the dataset catalog and one event per chunk access. Heatmap and event endpoints aggregate and return these recorded accesses.

## Measurement definitions

- **Cache hit:** a decoded array block was present in this API process's LRU. No Zarr array read was issued for the chunk.
- **Cache miss:** a decoded array block was absent and requested through Zarr.
- **Stored bytes:** for local Zarr v2 directory stores, the encoded chunk file's exact length. This is not physical disk I/O or network traffic. Cache hits report zero newly requested bytes. Unsupported layouts and remote stores return an unknown value.
- **Implicit fill:** for local Zarr v2 directory stores, the expected chunk file is absent and Zarr supplies the array's fill value. An absent key is not treated as corruption.
- **Duration:** application wall-clock time covering cache lookup, Zarr access and decoding, and event persistence. Slice duration also includes assembly and normalization. It does not isolate provider latency.
- **Decoded bytes:** the in-memory NumPy block size, not its encoded storage size.

## Storage and security

Local registration is confined to the resolved `CHUNKSCOPE_DATA_DIR`. S3 access is limited to the server-configured bucket and optional prefix; endpoint settings and credentials remain on the API server and are not sent to the browser.

The API is intended for trusted local use and does not include authentication. Do not expose it to untrusted networks without adding an access-control layer and restrictive CORS settings. Request-size limits and the decoded-chunk cache are configurable.

## Supported scope

- Local Zarr v2 and v3 stores are opened through the installed Zarr-Python library. Exact encoded chunk lengths and implicit-fill detection are available for local Zarr v2 directory-store layout only.
- S3-compatible stores can be registered and read through `fsspec` and `s3fs` when configured on the server. Live interoperability depends on the selected provider and is not covered by the local test suite. Encoded remote object lengths are reported as unknown.
- The viewer selects the first 3D array in a store. It assumes the array dimensions are ordered Z/Y/X and does not provide manual axis mapping, arbitrary extra-dimension selection, or array browsing.
- Numeric root array paths can be selected as resolution levels. The viewer does not interpret the complete OME-NGFF metadata and transform model.
- The lattice draws chunk boundaries in the volume shader. Picking selects the front-facing intersected chunk. Configured limits reject arrays with excessive chunk counts.
- Playback replays recorded client-visible events; it does not execute a server-side workload.
- Sample datasets are deterministic Zarr v2 volumes. External OME-NGFF datasets and GPU-less fallback rendering are not validated. Keyboard accessibility, frontend unit tests, and browser end-to-end coverage are limited.
