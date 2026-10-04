import { useEffect } from "react";

const storageKey = "sage-text-size:v1";
const defaultPercent = 100;
const minPercent = 80;
const maxPercent = 200;
const stepPercent = 10;

export function useTextSizeShortcuts() {
  useEffect(() => {
    let percent = readSavedPercent();
    applyPercent(percent);

    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const direction = textSizeDirection(event);
      if (direction === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      percent = Math.max(
        minPercent,
        Math.min(maxPercent, percent + direction * stepPercent)
      );
      applyPercent(percent);
      savePercent(percent);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}

function textSizeDirection(event: KeyboardEvent): -1 | 1 | null {
  if (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return 1;
  }
  if (
    event.key === "-" ||
    event.key === "_" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  ) {
    return -1;
  }
  return null;
}

function readSavedPercent(): number {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === null) {
      return defaultPercent;
    }
    const value = Number(saved);
    if (!Number.isInteger(value)) {
      return defaultPercent;
    }
    return Math.max(minPercent, Math.min(maxPercent, value));
  } catch {
    return defaultPercent;
  }
}

function savePercent(percent: number) {
  try {
    window.localStorage.setItem(storageKey, String(percent));
  } catch {
    // A disabled or full local store should not stop text resizing.
  }
}

function applyPercent(percent: number) {
  document.documentElement.style.fontSize = `${percent}%`;
  // Root rem sizing also positions the native traffic-light controls.
  window.dispatchEvent(new Event("resize"));
}
