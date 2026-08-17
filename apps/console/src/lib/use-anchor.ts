import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { type Anchor, anchorDomId, parseAnchor } from "@/lib/anchors";

export type AnchorState = "none" | "pending" | "found" | "missing";

/** Pure decision core, tested directly (the harness has no DOM environment). */
export function anchorDecision(
  anchor: Anchor | null,
  applied: boolean,
  prior: AnchorState,
  ready: boolean,
  present: boolean,
): AnchorState {
  if (anchor === null) return "none";
  if (applied) return prior;
  if (!ready) return "pending";
  return present ? "found" : "missing";
}

export function useAnchor<K extends Anchor["kind"]>(
  kind: K,
  ready: boolean,
  isPresent: (a: Extract<Anchor, { kind: K }>) => boolean,
  onFound?: (a: Extract<Anchor, { kind: K }>) => void,
): { anchor: Extract<Anchor, { kind: K }> | null; state: AnchorState } {
  const location = useLocation();
  const parsed = parseAnchor(location.hash.replace(/^#/, ""));
  const anchor = parsed && parsed.kind === kind ? (parsed as Extract<Anchor, { kind: K }>) : null;
  const appliedRef = useRef(false);
  const [state, setState] = useState<AnchorState>("none");

  useEffect(() => {
    const next = anchorDecision(
      anchor,
      appliedRef.current,
      state,
      ready,
      anchor !== null && ready ? isPresent(anchor) : false,
    );
    if (next === state) return;
    setState(next);
    if (next !== "found" && next !== "missing") return;
    appliedRef.current = true;
    if (next === "found" && anchor) {
      onFound?.(anchor);
      const domId = anchorDomId(anchor);
      requestAnimationFrame(() => {
        const el = document.getElementById(domId);
        if (!el) return;
        el.scrollIntoView({ block: "center" });
        el.classList.add("anchor-hit");
        window.setTimeout(() => el.classList.remove("anchor-hit"), 2_000);
      });
    }
  });

  return { anchor, state };
}
