/**
 * 把“是否靠近滚动底部”拆成无 DOM 依赖的纯函数，便于单元测试长会话的自动跟随边界。
 * ChatPanel 只负责从真实元素采集三个指标，这个模块负责决策。
 */

// 保留 80px 容差，让用户即使没有精确停在最后一像素，仍被视为“愿意跟随新 token”。
const DEFAULT_BOTTOM_THRESHOLD = 80;

// 仅依赖浏览器通用的滚动几何量，不绑定 DynamicScroller 的具体类型。
interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

// 剩余距离 = 总内容高度 - 已滚动距离 - 可视高度。
// 剩余距离小于容差时返回 true；边界值使用 <=，使恰好在阈值上的用户仍保持跟随。
export function isNearScrollBottom(
  { scrollTop, clientHeight, scrollHeight }: ScrollMetrics,
  threshold = DEFAULT_BOTTOM_THRESHOLD
) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
