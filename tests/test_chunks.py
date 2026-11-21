import pytest
from apps.api.app.chunks import chunk_bounds, chunk_grid, chunks_for_slice


def test_grid_and_edge_bounds():
    assert chunk_grid((65, 64, 33), (32, 32, 16)) == (3, 2, 3)
    assert chunk_bounds((65, 64, 33), (32, 32, 16), (2, 1, 2)) == ((64, 65), (32, 64), (32, 33))


@pytest.mark.parametrize("axis", [0, 1, 2])
def test_slice_chunk_intersections(axis):
    shape, chunks, index = (64, 48, 32), (16, 16, 16), 17
    coords = chunks_for_slice(shape, chunks, axis, index)
    expected = [6, 8, 12][axis]
    assert len(coords) == expected
    assert all(c[axis] == 1 for c in coords)


def test_invalid_slice_rejected():
    with pytest.raises(ValueError):
        chunks_for_slice((10, 10, 10), (4, 4, 4), 2, 10)
