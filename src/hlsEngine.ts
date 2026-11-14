import Hls from "hls.js";
import { isLocalMedia, mediaUrl } from "../api";

/* 统一 HLS 引擎：Feed 的 VideoSurface 与图文页的 Player 原本各持一份
   近乎相同的 new Hls({...}) 与 ERROR 恢复代码，且 Player 缺退避、缺
   swapAudioCodec、非致命分支不判 active——这里收敛成一份基线实现。 */

export type HlsRecoveryState = { count: number; timer: number | null };

export type HlsRecoveryHooks = {
  isActive: () => boolean;
  play: (source: string) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  /** 致命错误兜底：VideoSurface → onError；Player → setErrMsg */
  onFatal: (detail: string) => void;
  /** FRAG_BUFFERED / MANIFEST_PARSED 的 UI 钩子 */
  onFragBuffered: () => void;
  /** MANIFEST_PARSED 后的自动播放（需要 autoPlay 与否由调用方决定） */
  onManifest?: () => void;
};

/** 静默自愈上限与退避：4 次以内不让用户看到报错层 */
const MAX_SILENT_RECOVER = 4;
const RETRY_DELAY_BASE = 250;
const SWAP_CODEC_AT = 2;

export function createHlsRecoveryState(): HlsRecoveryState {
  return { count: 0, timer: null };
}

export function clearRecoveryTimer(state: HlsRecoveryState | null) {
  if (!state) return;
  if (state.timer !== null) {
    window.clearTimeout(state.timer);
    state.timer = null;
  }
}

/** 判定交给本地协议还是直链：m3u8 → /hls 改写，mp4 等 → /seg 透传 */
export function resolveSource(src: string): { url: string; useHls: boolean } {
  const proxied = isLocalMedia(src);
  const url = proxied ? src : mediaUrl(src);
  return { url, useHls: !url.includes("/seg?u=") };
}

export function createHlsConfig(isIos: boolean) {
  return {
    // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
    interstitialsController: undefined,
    contentSteeringController: undefined,
    enableInterstitialPlayback: false,
    // iOS WKWebView 下 WebWorker 跨自定义协议 hg:// 高频中断易死锁，关闭 Worker 走主线程加载更稳
    enableWorker: !isIos,
    // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
    preferManagedMediaSource: false,
    autoStartLoad: false,
    lowLatencyMode: false,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
    maxBufferHole: 0.5,
    highBufferWatchdogPeriod: 2,
    nudgeOffset: 0.25,
    nudgeMaxRetry: 6,
    manifestLoadingTimeOut: 20000,
    manifestLoadingMaxRetry: 4,
    levelLoadingTimeOut: 20000,
    levelLoadingMaxRetry: 4,
    fragLoadingTimeOut: 25000,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 400,
    startFragPrefetch: true,
  };
}

/** 绑定 MANIFEST_PARSED / FRAG_BUFFERED / ERROR 三个事件，统一自愈策略。 */
export function attachHlsRecovery(
  hls: Hls,
  video: HTMLVideoElement,
  state: HlsRecoveryState,
  hooks: HlsRecoveryHooks,
) {
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (hooks.isActive()) hls.startLoad();
    hooks.onManifest?.();
  });
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    state.count = 0;
    hooks.onFragBuffered();
  });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    // 非致命卡顿错误（常见于拖动进度条后缓冲空洞）：主动触发加载与微调跳帧
    if (!data.fatal) {
      if (
        hooks.isActive() && (
          data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
          data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
        )
      ) {
        try {
          hls.startLoad(video.currentTime || -1);
        } catch { /* ignore */ }
      }
      return;
    }

    if (!hooks.isActive()) return;

    const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
    hooks.trace("hls.error.fatal", { detail, silent_recovered: state.count });

    // 致命错误：优先自动重连/恢复解码器，最多静默恢复 4 次，避免拖动进度条直接弹报错层
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (state.count < MAX_SILENT_RECOVER) {
        state.count += 1;
        const delay = RETRY_DELAY_BASE * state.count;
        clearRecoveryTimer(state);
        state.timer = window.setTimeout(() => {
          state.timer = null;
          try {
            hls.startLoad(video.currentTime || -1);
            if (!video.paused) video.play().catch(() => {});
          } catch { /* ignore */ }
        }, delay);
        return;
      }
      hooks.onFatal(detail);
      hls.startLoad();
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (state.count < MAX_SILENT_RECOVER) {
        state.count += 1;
        try {
          if (state.count === SWAP_CODEC_AT) hls.swapAudioCodec();
          hls.recoverMediaError();
          video.play().catch(() => {});
        } catch { /* ignore */ }
        return;
      }
      hooks.onFatal(detail);
      hls.recoverMediaError();
    } else {
      hooks.onFatal(detail);
      hls.destroy();
    }
  });
}
