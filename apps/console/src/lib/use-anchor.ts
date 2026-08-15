// The one hook that applies an entity anchor to a page (§2.1): on the FIRST
// successful arrival of the owning query's data, find the row, scroll it into
// view, apply a transient highlight (reduced-motion aware via CSS), and let
// the page expand it. Later polls never re-scroll (C3: the hook keys on
// applied state, not data identity) and the found/missing decision is made
// once, at that first successful read — an unloaded or failed read renders no
// miss notice, because absence is not yet a fact.
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
      // Scroll after the page has rendered the found state (row expansion may
      // move the row), hence a frame later rather than synchronously.
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
