import type { AppEvent, EventSubscription, EventType, IEventBus } from "@/types";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";
import { isoNow } from "@/lib/utils";

type Handler<T = unknown> = (event: AppEvent<T>) => void;

class EventBus implements IEventBus {
  private handlers = new Map<EventType, Set<Handler>>();
  private anyHandlers = new Set<Handler>();

  emit<T>(type: EventType, payload: T, source: string): void {
    const event: AppEvent<T> = {
      id: nanoid(),
      type,
      payload,
      source,
      timestamp: isoNow(),
    };

    const set = this.handlers.get(type);
    if (set) {
      for (const handler of set) {
        try {
          (handler as Handler<T>)(event);
        } catch (err) {
          logger.error(`Event handler error for "${type}":`, err);
        }
      }
    }

    for (const handler of this.anyHandlers) {
      try {
        (handler as Handler<T>)(event);
      } catch (err) {
        logger.error(`onAny handler error for "${type}":`, err);
      }
    }
  }

  /** Subscribe to every event regardless of type (used by the OTel bridge). */
  onAny(handler: (event: AppEvent<unknown>) => void): EventSubscription {
    this.anyHandlers.add(handler as Handler);
    return { unsubscribe: () => { this.anyHandlers.delete(handler as Handler); } };
  }

  on<T>(
    type: EventType,
    handler: (event: AppEvent<T>) => void,
  ): EventSubscription {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as Handler);
    return {
      unsubscribe: () => {
        this.handlers.get(type)?.delete(handler as Handler);
      },
    };
  }

  once<T>(
    type: EventType,
    handler: (event: AppEvent<T>) => void,
  ): EventSubscription {
    const wrapper = (event: AppEvent<T>) => {
      this.handlers.get(type)?.delete(wrapper as Handler);
      handler(event);
    };
    return this.on(type, wrapper);
  }

  off(type: EventType, handler: (event: AppEvent<unknown>) => void): void {
    this.handlers.get(type)?.delete(handler as Handler);
  }

  /** For testing: remove all handlers */
  _reset(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
  }
}

export const eventBus = new EventBus();
