import { useEffect } from "react";
import { eventBus } from "@/orchestration/event-bus";
import type { EventType, AppEvent } from "@/types";

export function useEventBus<T>(
  type: EventType,
  handler: (event: AppEvent<T>) => void,
): void {
  useEffect(() => {
    const sub = eventBus.on<T>(type, handler);
    return () => sub.unsubscribe();
  }, [type, handler]);
}
