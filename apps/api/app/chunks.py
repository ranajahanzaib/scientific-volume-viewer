from __future__ import annotations
from itertools import product


def chunk_grid(shape: tuple[int, ...], chunks: tuple[int, ...]) -> tuple[int, ...]:
    if len(shape) != len(chunks) or any(s <= 0 for s in shape) or any(c <= 0 for c in chunks):
        raise ValueError("Shape and chunk dimensions must be positive and have equal rank")
    return tuple((s + c - 1) // c for s, c in zip(shape, chunks))


def chunk_bounds(shape: tuple[int, ...], chunks: tuple[int, ...], coord: tuple[int, ...]) -> tuple[tuple[int, int], ...]:
    grid = chunk_grid(shape, chunks)
    if len(coord) != len(shape) or any(c < 0 or c >= grid[i] for i, c in enumerate(coord)):
        raise ValueError("Chunk coordinate outside array")
    return tuple((c * size, min((c + 1) * size, shape[i])) for i, (c, size) in enumerate(zip(coord, chunks)))


def chunks_for_slice(shape: tuple[int, ...], chunks: tuple[int, ...], axis: int, index: int) -> list[tuple[int, ...]]:
    grid = chunk_grid(shape, chunks)
    if axis < 0 or axis >= len(shape) or index < 0 or index >= shape[axis]:
        raise ValueError("Slice axis or index outside array")
    fixed = index // chunks[axis]
    return [coord for coord in product(*(range(n) for n in grid)) if coord[axis] == fixed]
