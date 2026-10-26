// 横向滚动阴影（审计 batch2 #12）：根据滚动位置决定左右两侧是否还有被裁切的内容。
export function computeScrollEdges({ scrollLeft = 0, scrollWidth = 0, clientWidth = 0 } = {}, tolerance = 2) {
  const left = Number(scrollLeft) || 0;
  const overflow = (Number(scrollWidth) || 0) - (Number(clientWidth) || 0);
  if (overflow <= tolerance) return { left: false, right: false };
  return { left: left > tolerance, right: left < overflow - tolerance };
}
