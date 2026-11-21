"""Create small, deterministic multiscale Zarr v2 demonstrations."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

import numpy as np
import zarr

ROOT = Path(os.getenv("CHUNKSCOPE_DATA_DIR", "data/volumes"))
SIZE = int(os.getenv("CHUNKSCOPE_SAMPLE_SIZE", "96"))
CHUNK = int(os.getenv("CHUNKSCOPE_SAMPLE_CHUNK", "24"))


def fields(n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    z, y, x = np.mgrid[-1:1:complex(n), -1:1:complex(n), -1:1:complex(n)].astype(np.float32)
    r = np.sqrt((x * .88) ** 2 + (y * 1.06) ** 2 + (z * .82) ** 2)
    medical = np.zeros((n, n, n), np.float32)
    medical[r < .83] = 0.24
    medical[(x*x/.36 + y*y/.44 + z*z/.44) < 1] = .55
    medical[((x-.22)**2 + (y+.1)**2 + (z+.08)**2) < .16] = .84
    medical[((x+.22)**2 + (y+.1)**2 + (z+.08)**2) < .16] = .82
    medical[(z > .28) & (z < .38) & (np.abs(x) < .3) & (np.abs(y) < .08)] = .93
    medical += .012 * (np.sin(21*x) * np.cos(18*y) * np.sin(17*z))
    medical = np.clip(medical, 0, 1)
    rng = np.random.default_rng(20261121)
    microscopy = np.zeros_like(medical)
    for cx, cy, cz, radius, intensity in [(-.38,-.2,.08,.18,.9),(.2,.23,-.1,.24,.75),(.35,-.3,.3,.14,1),(-.1,.35,.32,.12,.82)]:
        distance = (x-cx)**2 + (y-cy)**2 + (z-cz)**2
        microscopy += intensity * np.exp(-distance/(radius*radius*.22))
    microscopy += (rng.random((n,n,n), dtype=np.float32) ** 8) * .28
    microscopy = np.clip(microscopy, 0, 1)
    simulation = .5 + .2*np.sin(5*x+2*z)*np.cos(5*y-1.5*z) + .18*np.exp(-((x-.24)**2+(y+.12)**2+(z-.1)**2)/.08)
    simulation += .08*np.exp(-((x+.45)**2+(y-.36)**2+(z+.4)**2)/.025)
    return medical, microscopy, np.clip(simulation, 0, 1).astype(np.float32)


def write(name: str, data: np.ndarray, description: str) -> None:
    path = ROOT / f"{name}.zarr"
    if path.exists():
        try:
            existing = zarr.open_group(str(path), mode="r")
            if all(str(level) in existing for level in range(3)):
                return
        except Exception:
            pass
        shutil.rmtree(path)
    group = zarr.open_group(str(path), mode="w", zarr_format=2)
    group.attrs.update({"title": name.replace("-", " ").title(), "description": description,
                        "axes": [{"name":"z","type":"space","unit":"micrometer"},{"name":"y","type":"space","unit":"micrometer"},{"name":"x","type":"space","unit":"micrometer"}],
                        "multiscales": [{"version":"0.4","name":name,"axes":[{"name":"z","type":"space"},{"name":"y","type":"space"},{"name":"x","type":"space"}],"datasets":[{"path":"0"},{"path":"1"},{"path":"2"}]}]})
    current = data
    for level in range(3):
        # Use a real compressor when the installed Zarr/numcodecs supports one.
        try:
            from numcodecs import Blosc
            compressor = Blosc(cname="zstd", clevel=3, shuffle=Blosc.BITSHUFFLE)
        except ImportError:
            compressor = None
        group.create_array(str(level), data=current.astype(np.float32), chunks=(CHUNK,CHUNK,CHUNK), compressor=compressor, overwrite=True)
        if min(current.shape) >= 2:
            current = current[::2,::2,::2]
    print(f"created {path}")


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    medical, microscopy, simulation = fields(SIZE)
    write("medical-volume", medical, "Anatomical phantom with tissue-like regions.")
    write("microscopy-volume", microscopy, "Procedural fluorescent microscopy structures.")
    write("simulation-field", simulation, "Smooth scalar field with localized structures.")


if __name__ == "__main__": main()
