"use client";
import { useEffect, useRef } from "react";

type HeatCell = { coord: number[]; accesses: number };

export default function VolumeCanvas({
  data,
  shape,
  sourceShape,
  chunks,
  opacity,
  windowLevel,
  resetKey,
  selectedCoord,
  heatmap,
  showVolume,
  showLattice,
  onSelect,
}: {
  data: number[];
  shape: number[];
  sourceShape: number[];
  chunks: number[];
  opacity: number;
  windowLevel: number;
  resetKey: number;
  selectedCoord: number[] | null;
  heatmap: HeatCell[];
  showVolume: boolean;
  showLattice: boolean;
  onSelect: (coord: number[]) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({
    opacity,
    windowLevel,
    selectedCoord,
    heatmap,
    showVolume,
    showLattice,
    onSelect,
  });
  const redrawRef = useRef<() => void>(() => {});
  const heatUpdateRef = useRef<(items: HeatCell[]) => void>(() => {});
  live.current = {
    opacity,
    windowLevel,
    selectedCoord,
    heatmap,
    showVolume,
    showLattice,
    onSelect,
  };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !data.length) return;
    const [z, y, x] = shape;
    const [sz, sy, sx] = sourceShape;
    const [cz, cy, cx] = chunks;
    const grid = [Math.ceil(sz / cz), Math.ceil(sy / cy), Math.ceil(sx / cx)];
    const pickCoord = (
      clientX: number,
      clientY: number,
      yaw: number,
      pitch: number,
      zoom: number,
    ) => {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      const screenX = (ndcX * rect.width) / rect.height;
      const ro = [
        zoom * Math.cos(pitch) * Math.sin(yaw),
        zoom * Math.sin(pitch),
        zoom * Math.cos(pitch) * Math.cos(yaw),
      ];
      const forward = normalize(ro.map((v) => -v));
      const right = normalize(cross(forward, [0, 1, 0]));
      const up = normalize(cross(right, forward));
      const direction = normalize(
        forward.map((v, i) => v + (right[i] * screenX + up[i] * ndcY) * 0.88),
      );
      const ranges = ro.map((origin, i) => {
        const a = (-0.5 - origin) / direction[i],
          b = (0.5 - origin) / direction[i];
        return [Math.min(a, b), Math.max(a, b)];
      });
      const near = Math.max(...ranges.map((r) => r[0])),
        far = Math.min(...ranges.map((r) => r[1]));
      if (near > far || far < 0) return;
      const t = Math.max(near, 0),
        world = ro.map((v, i) =>
          Math.max(0, Math.min(0.999999, v + direction[i] * t + 0.5)),
        );
      const ax = Math.min(grid[2] - 1, Math.floor((world[0] * sx) / cx));
      const ay = Math.min(grid[1] - 1, Math.floor((world[1] * sy) / cy));
      const az = Math.min(grid[0] - 1, Math.floor((world[2] * sz) / cz));
      live.current.onSelect([az, ay, ax]);
    };

    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
    if (!gl) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        canvas.width = x;
        canvas.height = y;
        const image = ctx.createImageData(x, y),
          start = Math.floor(z / 2) * x * y;
        for (let i = 0; i < x * y; i++) {
          const v = data[start + i] || 0,
            k = i * 4;
          image.data[k] = v * 0.65;
          image.data[k + 1] = v * 0.88;
          image.data[k + 2] = v;
          image.data[k + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
        const rows = Math.min(10, grid[1]),
          cols = Math.min(10, grid[2]);
        ctx.strokeStyle = "#8cdae2";
        ctx.lineWidth = 1;
        if (live.current.showLattice) {
          for (let row = 0; row <= rows; row++) {
            const yy = (row * y) / rows;
            ctx.beginPath();
            ctx.moveTo(0, yy);
            ctx.lineTo(x, yy);
            ctx.stroke();
          }
          for (let col = 0; col <= cols; col++) {
            const xx = (col * x) / cols;
            ctx.beginPath();
            ctx.moveTo(xx, 0);
            ctx.lineTo(xx, y);
            ctx.stroke();
          }
        }
      }
      const fallbackClick = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect(),
          col = Math.floor(((e.clientX - r.left) / r.width) * grid[2]),
          row = Math.floor(((e.clientY - r.top) / r.height) * grid[1]);
        live.current.onSelect([
          Math.floor(sz / 2 / cz),
          Math.min(grid[1] - 1, row),
          Math.min(grid[2] - 1, col),
        ]);
      };
      canvas.addEventListener("click", fallbackClick);
      return () => canvas.removeEventListener("click", fallbackClick);
    }

    const vertex = `#version 300 es
      in vec2 position; out vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
    const fragment = `#version 300 es
      precision highp float; precision highp sampler3D;
      uniform sampler3D volumeTex; uniform sampler3D heatTex; uniform vec2 resolution;
      uniform float yaw; uniform float pitch; uniform float zoom; uniform float opacity; uniform float windowLevel; uniform float showVolume; uniform float showLattice;
      uniform vec3 chunkFraction; uniform vec3 gridSize; uniform vec3 selectedXYZ; uniform float hasSelection;
      in vec2 uv; out vec4 color;
      vec2 hitBox(vec3 ro,vec3 rd){vec3 inv=1.0/rd;vec3 a=(-.5-ro)*inv;vec3 b=(.5-ro)*inv;vec3 lo=min(a,b);vec3 hi=max(a,b);return vec2(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));}
      void main(){
        vec2 screen=(uv*2.0-1.0);screen.x*=resolution.x/resolution.y;
        vec3 ro=zoom*vec3(cos(pitch)*sin(yaw),sin(pitch),cos(pitch)*cos(yaw));
        vec3 fw=normalize(-ro);vec3 right=normalize(cross(fw,vec3(0.,1.,0.)));vec3 up=normalize(cross(right,fw));
        vec3 rd=normalize(fw+(right*screen.x+up*screen.y)*.88);vec2 bounds=hitBox(ro,rd);
        if(bounds.x>bounds.y){color=vec4(0.);return;}float t=max(bounds.x,0.);vec4 acc=vec4(0.);
        for(int i=0;i<128;i++){if(t>bounds.y||acc.a>.97)break;vec3 q=ro+rd*t+vec3(.5);float raw=texture(volumeTex,q).r;
          float v=clamp((raw-(.5-.5*windowLevel))/max(windowLevel,.02),0.,1.);float density=showVolume*smoothstep(.04,.46,v)*.075*opacity;
          vec3 cell=floor(q/chunkFraction);vec3 edge=min(fract(q/chunkFraction),1.-fract(q/chunkFraction));bool gridLine=any(lessThan(edge,vec3(.021)));
          bool selected=hasSelection>.5&&all(equal(cell,selectedXYZ));float heat=texture(heatTex,q).r;
          vec3 tint=mix(vec3(.19,.57,.65),vec3(.72,.92,.94),v);
          if(showLattice>.5&&heat>.005)tint=mix(tint,vec3(1.,.58,.27),min(.82,heat*.8));
          if(showLattice>.5&&gridLine){tint=mix(tint,vec3(.32,.77,.83),.82);density=max(density,.034);}
          if(selected){tint=mix(tint,vec3(1.,.72,.36),.9);density=max(density,.14);}
          float a=1.0-pow(1.0-density,1.6);acc.rgb+=(1.0-acc.a)*a*tint;acc.a+=(1.0-acc.a)*a;t+=.011;}
        color=acc;
      }`;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(
          gl.getShaderInfoLog(shader) || "Shader compilation failed",
        );
      return shader;
    };
    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
    } catch (err) {
      console.error(err);
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = (
      unit: number,
      width: number,
      height: number,
      depth: number,
      pixels: Uint8Array,
    ) => {
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R8,
        width,
        height,
        depth,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      return tex;
    };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const volumeTex = texture(0, x, y, z, new Uint8Array(data));
    const heatDims = [
      Math.min(64, grid[2]),
      Math.min(64, grid[1]),
      Math.min(64, grid[0]),
    ];
    const heatPixels = new Uint8Array(heatDims[0] * heatDims[1] * heatDims[2]);
    const maxAccesses = Math.max(
      1,
      ...live.current.heatmap.map((item) => item.accesses),
    );
    for (const item of live.current.heatmap) {
      const [hz, hy, hx] = item.coord;
      const ix = Math.min(
        heatDims[0] - 1,
        Math.floor((hx / grid[2]) * heatDims[0]),
      );
      const iy = Math.min(
        heatDims[1] - 1,
        Math.floor((hy / grid[1]) * heatDims[1]),
      );
      const iz = Math.min(
        heatDims[2] - 1,
        Math.floor((hz / grid[0]) * heatDims[2]),
      );
      const index = (iz * heatDims[1] + iy) * heatDims[0] + ix;
      heatPixels[index] = Math.max(
        heatPixels[index],
        Math.round((item.accesses / maxAccesses) * 255),
      );
    }
    const heatTex = texture(
      1,
      heatDims[0],
      heatDims[1],
      heatDims[2],
      heatPixels,
    );
    let frame = 0;
    let requestDraw = () => {};
    const updateHeat = (items: HeatCell[]) => {
      heatPixels.fill(0);
      const max = Math.max(1, ...items.map((item) => item.accesses));
      for (const item of items) {
        const [hz, hy, hx] = item.coord;
        const ix = Math.min(
            heatDims[0] - 1,
            Math.floor((hx / grid[2]) * heatDims[0]),
          ),
          iy = Math.min(
            heatDims[1] - 1,
            Math.floor((hy / grid[1]) * heatDims[1]),
          ),
          iz = Math.min(
            heatDims[2] - 1,
            Math.floor((hz / grid[0]) * heatDims[2]),
          );
        const index = (iz * heatDims[1] + iy) * heatDims[0] + ix;
        heatPixels[index] = Math.max(
          heatPixels[index],
          Math.round((item.accesses / max) * 255),
        );
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, heatTex);
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        0,
        heatDims[0],
        heatDims[1],
        heatDims[2],
        gl.RED,
        gl.UNSIGNED_BYTE,
        heatPixels,
      );
      requestDraw();
    };
    gl.uniform1i(gl.getUniformLocation(program, "volumeTex"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "heatTex"), 1);
    let yaw = 0.65,
      pitch = 0.18,
      zoom = 1.65,
      drag = false,
      moved = false,
      downX = 0,
      downY = 0,
      lastX = 0,
      lastY = 0;
    const draw = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2),
        w = Math.max(1, Math.floor(canvas.clientWidth * dpr)),
        h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(gl.getUniformLocation(program, "resolution"), w, h);
      gl.uniform1f(gl.getUniformLocation(program, "yaw"), yaw);
      gl.uniform1f(gl.getUniformLocation(program, "pitch"), pitch);
      gl.uniform1f(gl.getUniformLocation(program, "zoom"), zoom);
      gl.uniform1f(
        gl.getUniformLocation(program, "opacity"),
        live.current.opacity,
      );
      gl.uniform1f(
        gl.getUniformLocation(program, "windowLevel"),
        live.current.windowLevel,
      );
      gl.uniform1f(
        gl.getUniformLocation(program, "showVolume"),
        live.current.showVolume ? 1 : 0,
      );
      gl.uniform1f(
        gl.getUniformLocation(program, "showLattice"),
        live.current.showLattice ? 1 : 0,
      );
      gl.uniform3f(
        gl.getUniformLocation(program, "chunkFraction"),
        cx / sx,
        cy / sy,
        cz / sz,
      );
      gl.uniform3f(
        gl.getUniformLocation(program, "gridSize"),
        grid[2],
        grid[1],
        grid[0],
      );
      const [selZ, selY, selX] = live.current.selectedCoord || [-1, -1, -1];
      gl.uniform3f(
        gl.getUniformLocation(program, "selectedXYZ"),
        selX,
        selY,
        selZ,
      );
      gl.uniform1f(
        gl.getUniformLocation(program, "hasSelection"),
        selZ >= 0 ? 1 : 0,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    requestDraw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    redrawRef.current = requestDraw;
    heatUpdateRef.current = updateHeat;
    draw();
    const down = (e: PointerEvent) => {
      drag = true;
      moved = false;
      downX = lastX = e.clientX;
      downY = lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - lastX,
        dy = e.clientY - lastY;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
      yaw += dx * 0.009;
      pitch = Math.max(-1.35, Math.min(1.35, pitch + dy * 0.009));
      lastX = e.clientX;
      lastY = e.clientY;
      requestDraw();
    };
    const up = (e: PointerEvent) => {
      if (drag && !moved) pickCoord(e.clientX, e.clientY, yaw, pitch, zoom);
      drag = false;
      requestDraw();
    };
    const wheel = (e: WheelEvent) => {
      zoom = Math.max(1.25, Math.min(3.4, zoom + e.deltaY * 0.001));
      e.preventDefault();
      requestDraw();
    };
    const resize = new ResizeObserver(requestDraw);
    resize.observe(canvas);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", () => {
      drag = false;
    });
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      redrawRef.current = () => {};
      heatUpdateRef.current = () => {};
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("wheel", wheel);
      gl.deleteTexture(volumeTex);
      gl.deleteTexture(heatTex);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [data, shape, sourceShape, chunks, resetKey]);

  useEffect(() => {
    redrawRef.current();
  }, [opacity, windowLevel, selectedCoord, showVolume, showLattice]);
  useEffect(() => {
    heatUpdateRef.current(heatmap);
  }, [heatmap]);

  return (
    <canvas
      ref={ref}
      className="volume-canvas"
      aria-label="Interactive 3D volume and spatial chunk lattice. Click to select; drag to orbit; scroll to zoom."
    />
  );
}

function normalize(v: number[]) {
  const length = Math.hypot(...v) || 1;
  return v.map((n) => n / length);
}
function cross(a: number[], b: number[]) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
