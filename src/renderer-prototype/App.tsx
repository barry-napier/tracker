// PROTOTYPE — throwaway (wayfinder ticket 12).
// Three variants of the Tracker renderer (board + ticket detail + review wizard),
// switchable via ?variant= on this single route. Run: npm run prototype
import React, { useEffect, useState } from "react";
import VariantA, { name as nameA } from "./variants/VariantA";
import VariantB, { name as nameB } from "./variants/VariantB";
import VariantC, { name as nameC } from "./variants/VariantC";

const VARIANTS = [
  { key: "A", name: nameA, C: VariantA },
  { key: "B", name: nameB, C: VariantB },
  { key: "C", name: nameC, C: VariantC },
];

function useVariant(): [number, (i: number) => void] {
  const read = () => {
    const k = new URLSearchParams(location.search).get("variant") ?? "A";
    return Math.max(0, VARIANTS.findIndex((v) => v.key === k));
  };
  const [i, setI] = useState(read);
  const set = (next: number) => {
    const idx = (next + VARIANTS.length) % VARIANTS.length;
    const url = new URL(location.href);
    url.searchParams.set("variant", VARIANTS[idx].key);
    history.replaceState(null, "", url);
    setI(idx);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "ArrowLeft") set(read() - 1);
      if (e.key === "ArrowRight") set(read() + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [i, set];
}

export default function App() {
  const [i, set] = useVariant();
  const { C, key, name } = VARIANTS[i];
  return (
    <>
      <C key={key} />
      {import.meta.env.MODE !== "production" && (
        <div className="proto-switcher">
          <button onClick={() => set(i - 1)}>←</button>
          <span>{key} — {name}</span>
          <button onClick={() => set(i + 1)}>→</button>
        </div>
      )}
    </>
  );
}
