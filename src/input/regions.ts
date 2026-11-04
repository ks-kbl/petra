export interface LogicalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PhysicalInteractiveRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  /**
   * 圆角半径（与区域同坐标系）。0 或不填 = 直角矩形。
   * 用户要求：包围盒的四个角不该还能点到桌宠 —— 那里明明是透明的。
   */
  cornerRadius?: number;
}

/**
 * 点是否落在圆角矩形内。
 * 做法：把点夹到「内缩 radius 的矩形」上取最近点，再比对距离 —— 四角自然是 1/4 圆。
 */
export function pointInRoundedRect(
  px: number,
  py: number,
  rect: { x: number; y: number; width: number; height: number },
  radius: number,
): boolean {
  const { x, y, width, height } = rect;
  if (width <= 0 || height <= 0) return false;
  if (px < x || px >= x + width || py < y || py >= y + height) return false;
  const r = Math.max(0, Math.min(radius || 0, Math.min(width, height) / 2));
  if (r <= 0) return true;
  const innerLeft = x + r;
  const innerRight = x + width - r;
  const innerTop = y + r;
  const innerBottom = y + height - r;
  const cx = Math.min(Math.max(px, innerLeft), innerRight);
  const cy = Math.min(Math.max(py, innerTop), innerBottom);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * CSS logical client rect → physical client rect.
 * DOMRect 只在这里乘一次 Tauri/WebView scale factor；Rust 使用 ScreenToClient
 * 得到相同的 physical client coordinates。
 */
export function logicalRectToPhysicalRegion(
  id: string,
  rect: LogicalRect,
  scaleFactor: number,
  clientPhysicalWidth: number,
  clientPhysicalHeight: number,
  padding = 0,
  cornerRadius = 0,
): PhysicalInteractiveRegion | null {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;
  if (![rect.left, rect.top, rect.right, rect.bottom, padding].every(Number.isFinite)) return null;

  const left = Math.max(0, Math.floor((rect.left - padding) * scaleFactor));
  const top = Math.max(0, Math.floor((rect.top - padding) * scaleFactor));
  const right = Math.min(clientPhysicalWidth, Math.ceil((rect.right + padding) * scaleFactor));
  const bottom = Math.min(clientPhysicalHeight, Math.ceil((rect.bottom + padding) * scaleFactor));
  if (right <= left || bottom <= top) return null;

  return {
    id,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    enabled: true,
    cornerRadius: Math.max(0, Math.round(cornerRadius * scaleFactor)),
  };
}

export function regionFingerprint(regions: PhysicalInteractiveRegion[]): string {
  return regions
    .map((r) => `${r.id}:${r.x},${r.y},${r.width},${r.height},${r.enabled ? 1 : 0},${r.cornerRadius ?? 0}`)
    .join("|");
}
