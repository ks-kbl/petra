import { invoke } from "@tauri-apps/api/core";
import type { Window } from "@tauri-apps/api/window";
import type { PetView } from "../../live2d/PetDriver";
import { toast } from "../../ui/Toast";

/**
 * 垃圾桶功效 + PSD 导入分流：拖 .psd 给桌宠 = 导入新模型；拖其他文件 = 进回收站（可撤销）。
 *
 * ⚠️ 关键约束：Tauri 的原生 drag-drop 是**整窗口**级的 —— 以前不管把文件丢在窗口哪个角落
 * 都会进回收站，用户只是想拖进输入框，结果文件还没碰到角色就被"吃掉"了（还很难撤销）。
 * 所以这里必须先判断落点在谁身上：
 *   1. 落在**输入框**上 → 当作附件发给桌宠（图片/文本）；
 *   2. 落在**角色本体**上（不是那个带 padding 的点击框）→ 才执行导入/回收站；
 *   3. 落在空白处 → 什么都不做，只提示一句该拖到哪。
 *
 * getView 为视图获取器（模型热切换后仍指向当前实例）。
 */
export function setupTrashDrop(
  getView: () => PetView,
  win: Window,
  onImportPsd?: (path: string) => void,
  onDropToInput?: (paths: string[]) => void,
  isOverInput?: (cssX: number, cssY: number) => boolean,
  isOverModel?: (cssX: number, cssY: number) => boolean,
) {
  /** 原生事件给的是**物理像素**，页面里用的是 CSS 像素，要换算 */
  const toCss = (pos?: { x: number; y: number } | null) => {
    if (!pos) return null;
    const dpr = window.devicePixelRatio || 1;
    return { x: pos.x / dpr, y: pos.y / dpr };
  };

  win.onDragDropEvent((event) => {
    const payload = event.payload as {
      type: string;
      paths?: string[];
      position?: { x: number; y: number };
    };
    const pt = toCss(payload.position);

    switch (payload.type) {
      case "over": {
        if (!pt) {
          getView().playClick();
          return;
        }
        if (isOverInput?.(pt.x, pt.y)) {
          document.getElementById("as-inputbar")?.classList.add("as-drop");
        } else if (isOverModel?.(pt.x, pt.y)) {
          getView().playClick();
        }
        break;
      }
      case "drop": {
        document.getElementById("as-inputbar")?.classList.remove("as-drop");
        const paths = payload.paths ?? [];
        if (!paths.length) return;

        // 1) 拖进输入框 → 附件
        if (pt && isOverInput?.(pt.x, pt.y) && onDropToInput) {
          onDropToInput(paths);
          return;
        }
        // 位置拿不到时不要贸然丢回收站：宁可提示，也别把用户的文件吃掉
        const onModel = pt ? (isOverModel?.(pt.x, pt.y) ?? true) : false;
        if (!onModel) {
          toast("想送进回收站请拖到角色身上；想发给桌宠就拖进输入框", "info");
          return;
        }
        // 2) 拖到角色本体 → PSD 导入 / 回收站
        const psd = paths.find((p) => p.toLowerCase().endsWith(".psd"));
        if (psd && onImportPsd) {
          onImportPsd(psd);
          return;
        }
        getView().playGobble();
        void handleTrash(paths, getView());
        break;
      }
    }
  });
}

async function handleTrash(paths: string[], view: PetView) {
  try {
    const res = await invoke<{ ok: boolean; count: number }>("trash_files", { paths });
    if (res.ok) {
      toast(res.count > 1 ? `咕咚咕咚，吃了 ${res.count} 个文件，送进回收站` : "咕咚，送进回收站了");
    }
  } catch (err) {
    view.playClick();
    toast(String(err), "warn");
  }
}
