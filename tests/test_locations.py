import pytest
from fastapi import HTTPException

from apps.api.app.main import resolve_location


def test_local_registration_is_confined_to_data_root(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    (root / "scan.zarr").mkdir()
    monkeypatch.setattr("apps.api.app.main.ROOT", root.resolve())
    assert resolve_location("scan.zarr") == (root / "scan.zarr").resolve()
    with pytest.raises(HTTPException) as error:
        resolve_location("../outside.zarr")
    assert error.value.status_code == 400


def test_s3_uri_is_restricted_to_configured_bucket_and_prefix(monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "science-data")
    monkeypatch.setenv("S3_PREFIX", "approved/zarr")
    assert resolve_location("s3://science-data/approved/zarr/scan.zarr") == "s3://science-data/approved/zarr/scan.zarr"
    for uri in (
        "s3://other-bucket/approved/zarr/scan.zarr",
        "s3://science-data/unapproved/scan.zarr",
        "s3://science-data/approved/zarr/../private.zarr",
        "s3://user:secret@science-data/approved/zarr/scan.zarr",
    ):
        with pytest.raises(HTTPException):
            resolve_location(uri)


def test_s3_registration_requires_server_configuration(monkeypatch):
    monkeypatch.delenv("S3_BUCKET", raising=False)
    monkeypatch.delenv("S3_PREFIX", raising=False)
    with pytest.raises(HTTPException) as error:
        resolve_location("s3://science-data/scan.zarr")
    assert error.value.status_code == 503
