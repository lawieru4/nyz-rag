import { onUnmounted, ref, watch, type Ref } from "vue";

/** 积压按指数方式释放的时间常数：到达速度稳定时，显示约落后这么久。 */
const LAG_MS = 200;
/** 积压很少时的最低释放速度（字/秒），避免末尾几个字拖得太慢。 */
const MIN_CHARS_PER_SECOND = 40;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * 流式文本的平滑显示：模型 token 常一次到好几个字，按帧把积压的字符逐步释放，避免一顿一顿地跳。
 * 非流式状态（历史消息、生成结束或中止，以 `done` 的回答为准）和系统开启「减少动态效果」时直接显示全文。
 */
export function useSmoothText(text: () => string, streaming: () => boolean): Ref<string> {
  const shown = ref("");
  /** 已显示的字符数，带小数以便低速时逐帧累积。 */
  let position = 0;
  let frame = 0;
  let lastTime = 0;

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function tick(now: number) {
    const target = text();
    const elapsed = lastTime ? Math.min(now - lastTime, 100) : 16;
    lastTime = now;
    const backlog = target.length - position;
    position = Math.min(target.length, position + Math.max(backlog * elapsed / LAG_MS, MIN_CHARS_PER_SECOND * elapsed / 1000));
    let end = Math.floor(position);
    // 不把代理对（emoji 等）切成两半。
    const code = target.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end++;
    shown.value = target.slice(0, end);
    frame = end < target.length ? requestAnimationFrame(tick) : 0;
  }

  watch([text, streaming], ([value, active]) => {
    if (!active || reduceMotion.matches) {
      stop();
      position = value.length;
      shown.value = value;
      return;
    }
    // 回答被替换（如重新生成）时从头开始。
    if (!value.startsWith(shown.value)) {
      position = 0;
      shown.value = "";
    }
    if (!frame && position < value.length) {
      lastTime = 0;
      frame = requestAnimationFrame(tick);
    }
  }, { immediate: true });

  onUnmounted(stop);
  return shown;
}
