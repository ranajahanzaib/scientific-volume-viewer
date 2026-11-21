import numpy as np
import zarr
from fastapi.testclient import TestClient

from apps.api.app import main


def test_real_zarr_chunk_slice_cache_and_duckdb(tmp_path, monkeypatch):
    root = tmp_path / "volumes"
    root.mkdir()
    store = root / "fixture.zarr"
    group = zarr.open_group(str(store), mode="w", zarr_format=2)
    values = np.arange(16 * 16 * 16, dtype=np.uint16).reshape(16, 16, 16)
    group.create_array("0", data=values, chunks=(8, 8, 8), overwrite=True)
    group.create_array("1", data=values[::2, ::2, ::2], chunks=(4, 4, 4), overwrite=True)
    sparse = group.create_array("implicit", shape=(16, 16, 16), chunks=(8, 8, 8), dtype="uint8", fill_value=0, write_data=False)
    sparse[:8, :8, :8] = 1
    db_path = tmp_path / "telemetry.duckdb"
    monkeypatch.setattr(main, "ROOT", root)
    monkeypatch.setattr(main, "DB_PATH", db_path)
    with main.lock:
        main.cache.clear()
        main.cache_bytes = 0

    with TestClient(main.app) as client:
        registration = client.post("/api/datasets", json={"path": "fixture.zarr", "name": "fixture"})
        assert registration.status_code == 200
        dataset_id = registration.json()["id"]
        assert registration.json()["array"]["shape"] == [16, 16, 16]
        assert [item["level"] for item in registration.json()["levels"]] == [0, 1]
        coarse_preview = client.get(f"/api/datasets/{dataset_id}/preview?level=1").json()
        assert coarse_preview["shape"] == [8, 8, 8]
        assert coarse_preview["source_shape"] == [8, 8, 8]

        first = client.get(f"/api/datasets/{dataset_id}/chunks/0,0,0").json()
        second = client.get(f"/api/datasets/{dataset_id}/chunks/0,0,0").json()
        assert first["cache_hit"] is False
        assert first["stored_bytes_known"] is True
        assert first["stored_bytes"] > 0
        assert second["cache_hit"] is True
        assert second["stored_bytes"] == 0

        axial = client.get(f"/api/datasets/{dataset_id}/slice/0/3").json()
        assert axial["shape"] == [16, 16]
        assert axial["chunks_accessed"] == 4
        assert len(axial["pixels"]) == 256
        repeat = client.get(f"/api/datasets/{dataset_id}/slice/0/3").json()
        assert repeat["cache_hits"] == 4
        assert repeat["cache_misses"] == 0
        assert repeat["stored_bytes"] == 0

        events = client.get(f"/api/telemetry/events/{dataset_id}").json()
        assert len(events) >= 10
        assert any(event["cache_hit"] for event in events)
        heatmap = client.get(f"/api/telemetry/heatmap/{dataset_id}").json()
        assert sum(cell["accesses"] for cell in heatmap) == len(events)

        implicit, stats = main.read_chunk("fixture.zarr", "implicit", sparse, (1, 1, 1))
        assert not np.any(implicit)
        assert stats["implicit_fill"] is True
        assert stats["stored_bytes"] == 0
        implicit_again, cached_stats = main.read_chunk("fixture.zarr", "implicit", sparse, (1, 1, 1))
        assert np.array_equal(implicit, implicit_again)
        assert cached_stats["cache_hit"] is True
        assert cached_stats["implicit_fill"] is True
