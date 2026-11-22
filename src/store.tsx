import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, logLine, platform as envPlatform } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import type { User } from "./types";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "posts" }
  | { kind: "post"; id: number };

export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info" };

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = {
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  /** 上次使用的基准倍速：跨会话记住用户习惯（长按 2x 与锁速不落盘） */
  rate: number;
  /** 启动页偏好：应用冷启动默认落在哪个 tab（HGhubX #180 同款） */
  startTab: Tab;
  searchHist: string[];
};

const LS = "hghub_app_v1";
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, rate: 1, startTab: "home", searchHist: [],
};

const TABS: Tab[] = ["home", "search", "category", "profile"];

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

/** localStorage 是外部输入：逐字段校验，避免 likes:null / volume:99 / searchHist:"x" 之类
 *  脏数据在启动首帧把 .includes / .map / .filter 打崩白屏。 */
function normalizePersist(raw: unknown): Persist {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Persist>;
  const numArr = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    likes: numArr(o.likes),
    favs: numArr(o.favs),
    follows: numArr(o.follows),
    searchHist: strArr(o.searchHist).slice(0, 12),
    history: normalizeHistory(o.history),
    muted: typeof o.muted === "boolean" ? o.muted : DEFAULTS.muted,
    muteOnStartup: typeof o.muteOnStartup === "boolean" ? o.muteOnStartup : DEFAULTS.muteOnStartup,
    volume: typeof o.volume === "number" && Number.isFinite(o.volume)
      ? Math.max(0, Math.min(1, o.volume)) : DEFAULTS.volume,
    rate: typeof o.rate === "number" && Number.isFinite(o.rate)
      ? Math.max(0.5, Math.min(4, o.rate)) : DEFAULTS.rate,
    startTab: TABS.includes(o.startTab as Tab) ? (o.startTab as Tab) : DEFAULTS.startTab,
  };
}

function loadPersist(): Persist {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return DEFAULTS;
    const p = normalizePersist(JSON.parse(raw) as unknown);
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    return { ...p, muteOnStartup, muted: muteOnStartup || p.muted === true };
  } catch {
    return DEFAULTS;
  }
}

function readTheme(): Theme {
  try {
    if (localStorage.getItem("hghub_theme_mode") === "system") {
      // 跟随系统：无 matchMedia（WebView 老内核）时按深色兜底
      const dark = window.matchMedia?.("(prefers-color-scheme: light)").matches;
      return dark ? "light" : "dark";
    }
    return localStorage.getItem("hghub_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

type Store = {
  platform: Platform;
  theme: Theme; setTheme: (t: Theme) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => void;
  removeFavs: (ids: number[]) => void;
  removeHistory: (ids: number[]) => void;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 清屏模式（单击屏幕消除所有控件，只保留纯视频内容） */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  /** 基准倍速（跨会话记忆；长按 2x / 锁速是临时态，不入库） */
  rate: number; setRatePref: (r: number) => void;
  /** 启动页偏好 */
  startTab: Tab; setStartTab: (t: Tab) => void;
  /** 当前线路 base（分享链接用它，切线路后分享地址跟随） */
  shareBase: string; setShareBase: (b: string) => void;
  /** 主题模式：manual 沿用 theme 值；system 跟随系统深浅色 */
  themeMode: "manual" | "system"; setThemeMode: (m: "manual" | "system") => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [tab, setTabRaw] = useState<Tab>(() => loadPersist().startTab);
  const [stack, setStack] = useState<Page[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const toastSeq = useRef(0);
  /* 当前线路 base：app_boot 初始化，LinePicker 切线路时更新；分享链接跟随它 */
  const [shareBase, setShareBaseState] = useState("https://huangguoai.com");
  /* isLiked/isFav 稳定化：否则每次 value 重建都生成新函数，Feed 的 likeCount useMemo 恒失效。 */
  const likesRef = useRef(p.likes); likesRef.current = p.likes;
  const favsRef = useRef(p.favs); favsRef.current = p.favs;
  const isLiked = useCallback((id: number) => likesRef.current.includes(id), []);
  const isFav = useCallback((id: number) => favsRef.current.includes(id), []);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("hghub_theme", theme); } catch { /* ignore */ }
  }, [theme]);

  /* 跟随系统主题：监听系统深浅色切换，仅在 system 模式下生效 */
  useEffect(() => {
    if (localStorage.getItem("hghub_theme_mode") !== "system") return undefined;
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return undefined;
    const onChange = () => setThemeState(readTheme());
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  useEffect(() => {
    api.boot()
      .then((r) => {
        if (r.user && (r.user as User).id) setUser(r.user as User);
        if (typeof r.base === "string" && r.base) setShareBase(r.base);
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      })
      .catch(() => {
        /* 离线也能用；但必须放行 ready，否则安全设置开关会永久禁用且无提示。 */
        setStrictSecurityReady(true);
        logLine("[store] app_boot failed");
      });
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); setCleanState(false); }, []);
  const push = useCallback((pg: PageInput) => {
    setCleanState(false);
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, []);
  const pop = useCallback(() => {
    setCleanState(false);
    setStack((s) => s.slice(0, -1));
  }, []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.favs.includes(id);
      return { ...s, favs: on ? [id, ...s.favs] : s.favs.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: epChanged ? 0 : (t ?? prev?.t ?? 0),
        dur: dur ?? prev?.dur ?? 0,
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), []);
  /** 批量移除收藏 / 观看记录（「我的」页多选管理） */
  const removeFavs = useCallback((ids: number[]) => {
    const drop = new Set(ids);
    setP((s) => ({ ...s, favs: s.favs.filter((x) => !drop.has(x)) }));
  }, []);
  const removeHistory = useCallback((ids: number[]) => {
    const drop = new Set(ids);
    setP((s) => ({ ...s, history: s.history.filter((x) => !drop.has(x.id)) }));
  }, []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
      setUser(null);
      toast("已退出登录", "info");
    } catch {
      setUser(null);
      toast("本地已退出，服务端会话可能仍有效", "info");
    }
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      if (!next) {
        invoke("set_orientation", { landscape: false }).catch(() => {});
        try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);
  const setRatePref = useCallback((r: number) => {
    if (!Number.isFinite(r)) return;
    setP((s) => ({ ...s, rate: Math.max(0.5, Math.min(4, r)) }));
  }, []);
  const setStartTab = useCallback((t: Tab) => {
    if (!TABS.includes(t)) return;
    setP((s) => ({ ...s, startTab: t }));
  }, []);
  const setShareBase = useCallback((b: string) => setShareBaseState(b), []);
  const setThemeMode = useCallback((m: "manual" | "system") => {
    try { localStorage.setItem("hghub_theme_mode", m); } catch { /* ignore */ }
    // 切回手动时保持当前实际主题；切到系统时立即按系统值生效
    setThemeState(readTheme());
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, setTheme: setThemeState,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked, isFav,
    toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory, removeFavs, removeHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume,
    rate: p.rate, setRatePref,
    startTab: p.startTab, setStartTab,
    shareBase, setShareBase,
    themeMode: (() => {
      try { return localStorage.getItem("hghub_theme_mode") === "system" ? "system" as const : "manual" as const; } catch { return "manual" as const; }
    })(), setThemeMode,
    theater, setTheater, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast,
  }), [theme, tab, setTab, stack, push, pop, user, loginOpen, logout,
    p.likes, p.favs, p.history, p.follows, p.muted, p.muteOnStartup, p.volume, p.rate, p.startTab, p.searchHist,
    isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory, removeFavs, removeHistory,
    setMuted, setMuteOnStartup, setVolume, setRatePref, setStartTab, setThemeMode, setShareBase, addSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, theater, setTheater, fs, setFs, clean, setClean]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
