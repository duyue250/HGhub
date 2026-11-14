import { useEffect } from "react";
import type { Tab } from "./store";

/** 全局键盘：/ 聚焦搜索、1-4 切页、Escape 退栈 / 关登录 / 失焦输入框。
 *  AppBody 与 ShellInner 原本各有一份逐字相同的实现，合并到这里。 */
export function useGlobalKeys(d: {
  stackLen: number;
  pop: () => void;
  setTab: (t: Tab) => void;
  loginOpen: boolean;
  setLoginOpen: (b: boolean) => void;
}) {
  const { stackLen, pop, setTab, loginOpen, setLoginOpen } = d;
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stackLen) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stackLen, pop, setTab, loginOpen, setLoginOpen]);
}
