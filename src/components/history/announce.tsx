"use client";

import { useEffect } from "react";

/**
 * Writes `text` into a live region that stays mounted outside the history Suspense boundary, so screen readers hear
 * when a newly selected range has loaded (a region inserted with its text already present is often not announced).
 */
export function Announce({ targetId, text }: { targetId: string; text: string }) {
  useEffect(() => {
    const region = document.getElementById(targetId);
    if (region) region.textContent = text;
  }, [targetId, text]);
  return null;
}
