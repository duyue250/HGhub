/** 全局返回拦截：面板等临时层优先消费，未消费则走导航栈。
 *  首页 Feed 与栈页 Feed 会同时挂载，单例会互相清掉对方的 handler，
 *  因此改为按 id 注册的栈，后进先消费。 */
type Handler = () => boolean;

const handlers = new Map<string, Handler>();
let seq = 0;

/** 返回注销函数，便于 useEffect cleanup 直接调用。 */
export function registerBackHandler(handler: Handler, id = `back-${++seq}`): () => void {
  handlers.set(id, handler);
  return () => { handlers.delete(id); };
}

/** 兼容旧调用点的语义：null 清空全部，函数注册到默认槽位。 */
export function setBackHandler(handler: Handler | null): void {
  if (handler === null) handlers.clear();
  else handlers.set("default", handler);
}

/** 返回 true 表示已被消费（不再退栈） */
export function runBack(): boolean {
  for (const handler of [...handlers.values()].reverse()) {
    try {
      if (handler()) return true;
    } catch { /* 跳过失效 handler，继续尝试更早注册的 */ }
  }
  return false;
}
