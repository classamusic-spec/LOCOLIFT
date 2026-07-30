import type { EventMap, EventKey } from './types';

type Handler<K extends EventKey> = (payload: EventMap[K]) => void;

/**
 * Tiny typed pub/sub. Deliberately allocation-free on emit for the hot path:
 * handler arrays are copied only when a listener unsubscribes during dispatch.
 */
export class EventBus {
  private handlers = new Map<EventKey, Array<Handler<EventKey>>>();
  private dispatching = 0;

  on<K extends EventKey>(key: K, fn: Handler<K>): () => void {
    let list = this.handlers.get(key);
    if (!list) {
      list = [];
      this.handlers.set(key, list);
    }
    list.push(fn as Handler<EventKey>);
    return () => this.off(key, fn);
  }

  /** Subscribe for a single delivery. */
  once<K extends EventKey>(key: K, fn: Handler<K>): () => void {
    const off = this.on(key, ((payload: EventMap[K]) => {
      off();
      fn(payload);
    }) as Handler<K>);
    return off;
  }

  off<K extends EventKey>(key: K, fn: Handler<K>): void {
    const list = this.handlers.get(key);
    if (!list) return;
    const i = list.indexOf(fn as Handler<EventKey>);
    if (i < 0) return;
    if (this.dispatching > 0) {
      // copy-on-write so an in-flight dispatch keeps iterating a stable array
      const copy = list.slice();
      copy.splice(i, 1);
      this.handlers.set(key, copy);
    } else {
      list.splice(i, 1);
    }
  }

  emit<K extends EventKey>(key: K, payload: EventMap[K]): void {
    const list = this.handlers.get(key);
    if (!list || list.length === 0) return;
    this.dispatching++;
    try {
      for (let i = 0; i < list.length; i++) {
        try {
          (list[i] as Handler<K>)(payload);
        } catch (err) {
          console.error(`[EventBus] handler for "${String(key)}" threw:`, err);
        }
      }
    } finally {
      this.dispatching--;
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
