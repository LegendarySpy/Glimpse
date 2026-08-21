import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";

type ShortcutCapturePayload =
  | { kind: "preview"; shortcut: string }
  | { kind: "captured"; shortcut: string }
  | { kind: "error"; message: string };

type UseShortcutCaptureOptions = {
  active: boolean;
  onCancel: () => void | Promise<void>;
  onPreviewChange: (preview: string) => void;
  onShortcutCaptured: (shortcut: string) => void;
  onCaptureCancelled?: () => void;
  onError?: (message: string) => void;
  onCaptureInput?: () => void;
};

const SHORTCUT_CAPTURE_EVENT = "shortcut:capture";

export function useShortcutCapture({
  active,
  onCancel,
  onPreviewChange,
  onShortcutCaptured,
  onCaptureCancelled,
  onError,
  onCaptureInput,
}: UseShortcutCaptureOptions) {
  const resetCaptureState = useCallback(() => {
    onPreviewChange("");
  }, [onPreviewChange]);

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    const finishCapture = async (shortcut: string) => {
      if (disposed) return;
      disposed = true;
      unlisten?.();
      unlisten = null;
      try {
        await onCancel();
      } catch (error) {
        onError?.(String(error));
      } finally {
        onShortcutCaptured(shortcut);
        resetCaptureState();
      }
    };

    const cancelCapture = async () => {
      if (disposed) return;
      disposed = true;
      unlisten?.();
      unlisten = null;
      try {
        await onCancel();
      } catch (error) {
        onError?.(String(error));
      } finally {
        onCaptureCancelled?.();
        resetCaptureState();
      }
    };

    const handleCapturePayload = (payload: ShortcutCapturePayload) => {
      if (disposed) return;

      if (payload.kind === "preview") {
        onCaptureInput?.();
        onPreviewChange(payload.shortcut);
        return;
      }

      if (payload.kind === "captured") {
        onCaptureInput?.();
        void finishCapture(payload.shortcut);
        return;
      }

      if (payload.kind === "error") {
        onError?.(payload.message);
        void cancelCapture();
      }
    };

    listen<ShortcutCapturePayload>(SHORTCUT_CAPTURE_EVENT, (event) => {
      handleCapturePayload(event.payload);
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((error) => {
        if (disposed) return;
        onError?.(String(error));
        void cancelCapture();
      });

    const handleKeyboardEvent = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const hasModifier =
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
      const shouldCancel =
        event.type === "keydown" && event.key === "Escape" && !hasModifier;
      if (shouldCancel && !disposed) {
        void cancelCapture();
      }
    };

    const handleMouseEvent = (event: MouseEvent) => {
      if (event.button === 0) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleKeyboardEvent, true);
    window.addEventListener("keyup", handleKeyboardEvent, true);
    window.addEventListener("mousedown", handleMouseEvent, true);
    window.addEventListener("mouseup", handleMouseEvent, true);
    window.addEventListener("auxclick", handleMouseEvent, true);

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("keydown", handleKeyboardEvent, true);
      window.removeEventListener("keyup", handleKeyboardEvent, true);
      window.removeEventListener("mousedown", handleMouseEvent, true);
      window.removeEventListener("mouseup", handleMouseEvent, true);
      window.removeEventListener("auxclick", handleMouseEvent, true);
    };
  }, [
    active,
    onCancel,
    onCaptureCancelled,
    onCaptureInput,
    onError,
    onPreviewChange,
    onShortcutCaptured,
    resetCaptureState,
  ]);

  return { resetCaptureState };
}
