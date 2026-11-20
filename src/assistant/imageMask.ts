import type { ImageRef } from "./imageEditing";

/** Mask follows OpenAI semantics: transparent is editable, opaque is preserved. */
export async function drawImageMask(ref: ImageRef): Promise<Blob | null> {
  const image = new Image();
  image.src = ref.dataUrl;
  await image.decode();
  const dialog = document.createElement("dialog");
  dialog.dataset.petraInteractive = "image-mask";
  dialog.style.cssText = "max-width:90vw;max-height:90vh;background:var(--panel-bg,#fff);color:#2a2031;border:1px solid #d8bcd0;border-radius:12px;padding:12px;";
  const note = document.createElement("p");
  note.textContent = "涂出想修改的地方，未涂处尽量保留。";
  const stack = document.createElement("div");
  const scale = Math.min(1, window.innerWidth * .76 / image.naturalWidth, window.innerHeight * .62 / image.naturalHeight);
  stack.style.cssText = `position:relative;width:${Math.floor(image.naturalWidth * scale)}px;height:${Math.floor(image.naturalHeight * scale)}px`;
  image.style.cssText = "width:100%;height:100%;display:block;";
  const overlay = document.createElement("canvas");
  const mask = document.createElement("canvas");
  overlay.width = mask.width = image.naturalWidth;
  overlay.height = mask.height = image.naturalHeight;
  overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair;";
  const ctx = overlay.getContext("2d");
  const m = mask.getContext("2d");
  if (!ctx || !m) return null;
  let previous: [number, number] | null = null;
  let painted = false;
  const reset = () => {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    m.globalCompositeOperation = "source-over";
    m.fillStyle = "#fff";
    m.fillRect(0, 0, mask.width, mask.height);
    m.globalCompositeOperation = "destination-out";
    painted = false;
  };
  const stroke = (e: PointerEvent) => {
    const box = overlay.getBoundingClientRect();
    const point: [number, number] = [(e.clientX - box.left) * overlay.width / box.width, (e.clientY - box.top) * overlay.height / box.height];
    for (const brush of [ctx, m]) {
      brush.strokeStyle = brush === ctx ? "#d04698" : "#fff";
      brush.lineWidth = 22 * overlay.width / box.width;
      brush.lineCap = "round";
      brush.beginPath();
      brush.moveTo(...(previous ?? [point[0] - 0.1, point[1]]));
      brush.lineTo(...point);
      brush.stroke();
    }
    previous = point;
    painted = true;
  };
  overlay.onpointerdown = e => { overlay.setPointerCapture(e.pointerId); stroke(e); };
  overlay.onpointermove = e => { if (previous) stroke(e); };
  overlay.onlostpointercapture = overlay.onpointerup = overlay.onpointercancel = () => { previous = null; };
  stack.append(image, overlay);
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:6px;margin-top:8px;";
  const button = (text: string, fn: () => void) => {
    const b = document.createElement("button"); b.className = "as-btn"; b.textContent = text; b.onclick = fn; return b;
  };
  reset();
  return new Promise(resolve => {
    let accepting = false;
    buttons.append(button("清空涂抹", reset), button("取消", () => dialog.close()), button("使用选区", () => {
      if (!painted) { note.textContent = "请先涂抹要修改的位置。"; return; }
      accepting = true;
      dialog.close();
      mask.toBlob(resolve, "image/png");
    }));
    dialog.onclose = () => { dialog.remove(); if (!accepting) resolve(null); };
    dialog.append(note, stack, buttons);
    document.body.append(dialog);
    dialog.showModal();
  });
}
