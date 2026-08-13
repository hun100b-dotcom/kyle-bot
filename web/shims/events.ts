// =============================================================================
// web/shims/events.ts — 브라우저에서 'node:events'(EventEmitter) 흉내내기
// -----------------------------------------------------------------------------
// 엔진은 매매일지·체결강도·스크리너 진행률을 이벤트로 흘려보냅니다.
// 화면이 그 이벤트를 받아 실시간으로 갱신하죠. 필요한 기능은 on/off/emit 셋뿐입니다.
// =============================================================================

type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  once(event: string, fn: Listener): this {
    const wrap: Listener = (...args) => {
      this.off(event, wrap);
      fn(...args);
    };
    return this.on(event, wrap);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    // 듣는 쪽에서 오류가 나도 엔진이 멈추면 안 된다(데스크톱과 같은 안전 규칙).
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error("[capri] 이벤트 처리 중 오류", e);
      }
    }
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }
}

export default { EventEmitter };
