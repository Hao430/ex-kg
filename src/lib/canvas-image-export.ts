/**
 * Spec K1（跟踪清单 B2）：画布 PNG 图片导出。
 *
 * 方案：React Flow 官方文档同款捕获法——
 *   1. getNodesBounds(nodes) 计算全节点包围盒；
 *   2. getViewportForBounds() 在固定 1920×1080 画幅内 fit-contain（zoom 夹在 [0.25, 2]）；
 *   3. html-to-image.toPng() 捕获 .react-flow__viewport DOM（只含节点与连线，
 *      不含 Minimap/工具条等周边 UI），按主题填背景色；
 *   4. 离屏 canvas 二次绘制叠加品牌水印后触发下载。
 *
 * 已知边界（v1 接受）：
 * - 回答中的外链图片若 CORS 不放行，捕获可能失败——整体 try/catch 降级为提示，不阻塞主流程；
 * - KaTeX webfont 由 html-to-image 自动内联（同源资源，成功率依赖字体加载完成时机）。
 */
import { getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react';
import { toPng } from 'html-to-image';

/** 导出画幅：固定 16:9，输出可预测，水印定位简单 */
const EXPORT_WIDTH = 1920;
const EXPORT_HEIGHT = 1080;
/** 实际像素倍率：2x 保证放大后文字/公式可读 */
const PIXEL_RATIO = 2;
/** fit-contain 缩放上下限：避免超大画布缩成蚂蚁、过小画布糊满屏 */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
/** 内容与画幅边缘的安全留白比例 */
const VIEWPORT_PADDING = 0.08;

export interface ImageExportResult {
  ok: boolean;
  /** 失败时的用户可读原因（中文，无内部术语） */
  error?: string;
}

/** 按当前主题取背景色（与 index.css 的明暗两套画布底色对齐） */
function resolveBackgroundColor(): string {
  const isDark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return isDark ? '#0b1120' : '#f8fafc';
}

/** 水印文字与颜色随主题自适应：深色底用浅字，浅色底用深字 */
function resolveWatermarkStyle(): { text: string; color: string } {
  const isDark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return {
    text: '枝想 · AI 深度思维探索工作台',
    color: isDark ? 'rgba(226, 232, 240, 0.45)' : 'rgba(15, 23, 42, 0.35)',
  };
}

/** 在已渲染的 PNG 上叠加右下角品牌水印 */
async function addWatermark(dataUrl: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('watermark-image-load-failed'));
    img.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // 2D 上下文不可用时退回无水印版本，导出优先

  ctx.drawImage(img, 0, 0);

  const { text, color } = resolveWatermarkStyle();
  const fontSize = Math.max(24, Math.round(canvas.width / 60));
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const margin = Math.round(fontSize * 0.8);
  ctx.fillText(text, canvas.width - margin, canvas.height - margin);

  return canvas.toDataURL('image/png');
}

/** 文件名安全化：仅保留常用字符，防止标题中的特殊字符破坏下载 */
function sanitizeFilename(title: string): string {
  const cleaned = (title || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || '枝想画板').slice(0, 40);
}

/**
 * 导出当前画布为 PNG（含水印）并触发浏览器下载。
 * 必须在 React Flow 已挂载（存在 .react-flow__viewport）时调用。
 */
export async function exportCanvasAsPng(
  nodes: Node[],
  boardTitle: string
): Promise<ImageExportResult> {
  try {
    const viewportEl = document.querySelector('.react-flow__viewport');
    if (!viewportEl) {
      return { ok: false, error: '画布尚未就绪，请稍后重试' };
    }

    // 全节点包围盒 → 在固定画幅内 fit-contain（官方 v12 导出配方）
    const bounds = getNodesBounds(nodes);
    const viewport = getViewportForBounds(
      bounds,
      EXPORT_WIDTH,
      EXPORT_HEIGHT,
      MIN_ZOOM,
      MAX_ZOOM,
      VIEWPORT_PADDING
    );

    const rawPng = await toPng(viewportEl as HTMLElement, {
      backgroundColor: resolveBackgroundColor(),
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      pixelRatio: PIXEL_RATIO,
      style: {
        width: `${EXPORT_WIDTH}px`,
        height: `${EXPORT_HEIGHT}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    });

    const finalPng = await addWatermark(rawPng);

    const link = document.createElement('a');
    link.download = `${sanitizeFilename(boardTitle)}.png`;
    link.href = finalPng;
    link.click();

    return { ok: true };
  } catch (e) {
    console.error('PNG export failed:', e);
    return { ok: false, error: '图片生成失败，可能是内容包含受限的外部图片，请重试' };
  }
}
